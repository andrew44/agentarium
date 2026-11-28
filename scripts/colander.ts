#!/usr/bin/env node
/**
 * agentarium / colander: drain the noise out of test, build and install output before the model reads it.
 *
 * Post-tool hook (Claude Code: PostToolUse on Bash; Copilot CLI: postToolUse). When a test run, build, type
 * check, lint or package install succeeds, most of what it printed is passing tests, progress bars and
 * download chatter, and the model would re-read all of it at every later step. colander saves the full
 * output to ~/.agentarium/colander/ (readable only by you, kept for a day), then shows the model the first
 * and last lines, every warning and failure, and a footer saying what it left out and where the rest is.
 * The model greps that file when it needs more, instead of running the command again.
 * Rules: agentarium/engine/colander.ts.
 *
 * Successful calls only. Claude Code sends a command that exits non-zero to PostToolUseFailure, which can't
 * replace output, so a failing run reaches the model whole. VS Code's hooks can't replace output at all.
 *
 *   colander.ts [source]                     post-tool hook (stdin: hook JSON)  source = claude-code (default) | copilot
 *   colander.ts strain [--max-lines N] [--command "npm test"]
 *                                            strain whatever is on stdin and print what the model would get;
 *                                            with --command, also say whether the hook would strain it
 *   colander.ts report [--days N] [--json]   what colander strained, and the tokens it kept out, by program
 *
 * Env:
 *   AGENTARIUM_COLANDER            on (default) | off
 *   AGENTARIUM_COLANDER_MAX_LINES  lines shown at most, failures aside (default 60)
 *   AGENTARIUM_COLANDER_COMMANDS   more programs to strain, comma separated (e.g. ci.sh,just)
 * Bypass for one command: append `# colander-off`. Each strain is logged in colander_events with the
 * program's name and token counts, never the command or what it printed.
 * Always exits 0; a crash leaves the output as it was (errors go to <db>.err).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultDbPath } from '../agentarium/config.ts'
import * as colander from '../agentarium/engine/colander.ts'
import { withDb } from '../agentarium/engine/db.ts'
import { BILLING_ANTHROPIC_TOKENS, TOOL_SHELL } from '../agentarium/engine/evidence.ts'
import { ratesFor } from '../agentarium/engine/pricing.ts'
import * as trace from '../agentarium/engine/trace.ts'
import type { PlatformAdapter, ToolOutput } from '../agentarium/platform/adapter.ts'
import { Capability } from '../agentarium/platform/capabilities.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../agentarium/services/index.ts'
import { argValue, errText, first, fmt, isMain, isObj, logErr, now, readPayload, readStdin, type Obj } from '../agentarium/util.ts'
import { money2, period, write } from './common.ts'

const KEEP_MS = 24 * 3_600_000
const KEEP_FILES = 30
const TAIL_BYTES = 1_000_000                // the last request's model is all that is needed

export const logDir = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'colander')
const maxLines = () => PolicyEngine.threshold('AGENTARIUM_COLANDER_MAX_LINES', colander.MAX_LINES, { min: 10, max: 2000 })
const extra = () => (process.env.AGENTARIUM_COLANDER_COMMANDS ?? '').split(/[,\s]+/).filter(Boolean)

/** Drop logs older than a day, and all but the newest few, so command output never piles up. */
function prune(dir: string): void {
  const files: [string, number][] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.log')) continue
    try {
      files.push([join(dir, f), statSync(join(dir, f)).mtimeMs])
    } catch {
      // vanished
    }
  }
  files.sort((a, b) => b[1] - a[1])
  files.forEach(([p, m], i) => {
    if (i >= KEEP_FILES - 1 || Date.now() - m > KEEP_MS) {
      try {
        unlinkSync(p)
      } catch {
        // already gone
      }
    }
  })
}

/** Save the full output where the model can read it; null when it can't be written. */
export function save(text: string, prog: string, dir = logDir()): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    prune(dir)
    const stamp = now().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const path = join(dir, `${prog.replace(/[^\w.-]/g, '_')}-${stamp}-${randomBytes(3).toString('hex')}.log`)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch {
    return null
  }
}

type Totals = Omit<colander.Strained, 'text'>

function add(a: Totals, b: Totals): Totals {
  const out = { ...a }
  for (const k of Object.keys(b) as (keyof Totals)[]) out[k] = a[k] + b[k]
  return out
}

export type Squeezed = { out: ToolOutput, totals: Totals, full: string }

/** Strain each stream; null when it wouldn't leave out enough to be worth it. The footer goes under the last
 *  stream that has anything in it, and `logPath` is filled in by the caller once the full output is saved. */
export function squeeze(got: ToolOutput, max = maxLines()): Squeezed | null {
  const o = colander.strain(got.stdout, max)
  const e = colander.strain(got.stderr, max)
  const { text: _o, ...ot } = o
  const { text: _e, ...et } = e
  const totals = add(ot, et)
  if (!colander.worth(totals.rawChars, totals.keptChars)) return null
  const cleanErr = colander.clean(got.stderr).trimEnd()
  const full = colander.clean(got.stdout).trimEnd() + (cleanErr ? `\n\n----- stderr -----\n${cleanErr}` : '')
  return { out: { stdout: o.text, stderr: e.text }, totals, full }
}

/** Put the footer under the strained output. */
export function withFooter(s: Squeezed, logPath: string | null): ToolOutput {
  const note = colander.footer(s.totals, logPath)
  const onErr = !s.out.stdout.trim() && s.out.stderr.trim()
  const put = (t: string) => (t.trim() ? `${t}\n\n${note}` : note)
  return onErr ? { stdout: s.out.stdout, stderr: put(s.out.stderr) } : { stdout: put(s.out.stdout), stderr: s.out.stderr }
}

/** The cache write the left-out tokens would have cost on the next request, at the session's model and cache
 *  lifetime. Each later request would have re-read them too; that part isn't counted. Money only where the
 *  platform bills tokens. */
function savedUsd(adapter: PlatformAdapter, payload: Obj, tokens: number): number | null {
  if (adapter.billingModel !== BILLING_ANTHROPIC_TOKENS || tokens <= 0) return null
  let model: string | null = null
  let oneHour = false
  const path = String(first(payload, ['transcript_path', 'transcriptPath'], '') || '')
  if (path) {
    try {
      const last = trace.parse(path, { tail: TAIL_BYTES }).turns.findLast((x) => !x.sidechain && x.model)
      model = last?.model ?? null
      oneHour = (last?.usage.cacheCreation1hTokens ?? 0) > 0
    } catch {
      // no transcript: the default rates
    }
  }
  const r = ratesFor(model)
  return Math.round(tokens * (oneHour ? r.cache_write_1h : r.cache_write_5m)) / 1e6
}

function hook(source: string): void {
  if (PolicyEngine.mode('AGENTARIUM_COLANDER', 'on', ['on', 'off']) === 'off') return
  const payload = readPayload()
  const adapter = getAdapter(source)
  if (!adapter.supports(Capability.TOOL_OUTPUT_INTERCEPTION)) return
  const call = adapter.toolCall(payload)
  if (call?.kind !== TOOL_SHELL) return
  if (isObj(payload.tool_input) && payload.tool_input.run_in_background === true) return
  const prog = colander.program(call.command, extra())
  if (!prog) return
  const got = adapter.toolOutput(payload)
  if (!got || got.stdout.length + got.stderr.length < colander.MIN_CHARS) return
  const s = squeeze(got)
  if (!s || adapter.replaceOutput(payload, s.out) === null) return
  const logPath = save(s.full, prog)
  const out = adapter.replaceOutput(payload, withFooter(s, logPath))!
  // counted against what the model would have read: Claude Code cuts a long result down itself
  const raw = Math.ceil(Math.min(s.totals.rawChars, adapter.shellResultLimit() ?? Infinity) / 4)
  const kept = Math.min(raw, Math.ceil(s.totals.keptChars / 4))
  PolicyEngine.log(defaultDbPath(), 'colander_events', { session_id: adapter.sessionId(payload), source: adapter.name,
    tool: call.name, program: prog, raw_tokens: raw, kept_tokens: kept, saved_usd: savedUsd(adapter, payload, raw - kept),
    action: 'strained' })
  process.stdout.write(JSON.stringify(out) + '\n')
}

function strainCmd(args: string[]): number {
  const cmd = argValue(args, '--command')
  if (cmd !== null) {
    const prog = colander.program(cmd, extra())
    write(prog ? `colander strains \`${cmd}\` (as ${prog}) when it succeeds and prints more than about 1,000 tokens.`
      : `colander leaves \`${cmd}\` alone: not a test, build, lint or install command it knows, or its output is already ` +
        'piped. Add the program to AGENTARIUM_COLANDER_COMMANDS to strain it.')
  }
  const raw = readStdin()
  if (!raw) return cmd !== null ? 0 : 2
  const max = Number(argValue(args, '--max-lines')) || maxLines()
  const s = colander.strain(raw, max)
  if (cmd !== null) write('')
  write(s.text)
  write('')
  write(`colander: ${colander.summary(s)}.` + (colander.worth(s.rawChars, s.keptChars) ? ''
    : ' Too little to leave out: the hook would pass this through unchanged.'))
  return 0
}

export type ProgramRow = { program: string, runs: number, raw_tokens: number, kept_tokens: number, saved_usd: number }

export function summarise(dbPath: string, since: string): { runs: number, raw_tokens: number, kept_tokens: number, saved_usd: number, programs: ProgramRow[] } {
  const rows = withDb(dbPath, (db) => db.tables().has('colander_events')
    ? db.all('SELECT program, COUNT(*) AS runs, COALESCE(SUM(raw_tokens),0) AS raw_tokens, COALESCE(SUM(kept_tokens),0) AS kept_tokens, ' +
      'COALESCE(SUM(saved_usd),0) AS saved_usd FROM colander_events WHERE substr(ts,1,10) >= ? GROUP BY program ' +
      'ORDER BY SUM(raw_tokens - kept_tokens) DESC', since)
    : [], { readOnly: true })
  const programs = rows.map((r) => ({ program: String(r.program), runs: Number(r.runs), raw_tokens: Number(r.raw_tokens),
    kept_tokens: Number(r.kept_tokens), saved_usd: Number(r.saved_usd) }))
  const sum = (k: 'runs' | 'raw_tokens' | 'kept_tokens' | 'saved_usd') => programs.reduce((a, p) => a + p[k], 0)
  return { runs: sum('runs'), raw_tokens: sum('raw_tokens'), kept_tokens: sum('kept_tokens'), saved_usd: sum('saved_usd'), programs }
}

function report(args: string[]): number {
  const p = period(args, 7)
  let r: ReturnType<typeof summarise>
  try {
    r = summarise(defaultDbPath(), p.since)
  } catch {
    r = { runs: 0, raw_tokens: 0, kept_tokens: 0, saved_usd: 0, programs: [] }
  }
  if (args.includes('--json')) {
    write(JSON.stringify({ since: p.since, ...r, log_dir: logDir() }, money2, 2))
    return 0
  }
  if (!r.runs) {
    write(`colander: nothing strained (${p.label}). It steps in when a test run, build, lint or install succeeds and prints ` +
      'more than about 1,000 tokens.')
    return 0
  }
  const { fmt: money } = CostEngine.display()
  const out = r.raw_tokens - r.kept_tokens
  const n = (k: number, one: string, many: string) => `${fmt(k)} ${k === 1 ? one : many}`
  write(`colander: strained ${n(r.runs, 'command output', 'command outputs')} (${p.label}), keeping about ${fmt(out)} tokens ` +
    `out of the context (${Math.round(out / Math.max(1, r.raw_tokens) * 100)}% of what they printed).` +
    (r.saved_usd >= 0.005 ? ` That skipped about ${money(r.saved_usd)} of cache writes, and the re-reads at every step after.` : ''))
  for (const x of r.programs.slice(0, 12)) {
    write(`- ${x.program.padEnd(12)} ${n(x.runs, 'run ', 'runs').padStart(9)}  ${fmt(x.raw_tokens - x.kept_tokens).padStart(10)} tokens left out` +
      `  (typically ${fmt(Math.round(x.raw_tokens / x.runs))} → ${fmt(Math.round(x.kept_tokens / x.runs))})`)
  }
  write(`Full outputs are kept for a day in ${logDir()}.`)
  return 0
}

export function main(args: string[]): number {
  const [cmd = 'claude-code'] = args
  if (cmd === 'strain') return strainCmd(args.slice(1))
  if (cmd === 'report') return report(args.slice(1))
  try {
    hook(cmd)
  } catch (e) {
    logErr(defaultDbPath(), `colander ${cmd}\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
