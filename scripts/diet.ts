#!/usr/bin/env node
/**
 * tokenomics / diet: stop tool calls that would flood the context with low-value text.
 *
 * Pre-tool hook (Claude Code: PreToolUse on Read|Bash; Copilot: preToolUse). Denies, with a
 * reason the model acts on, things like reading package-lock.json whole, `kubectl logs` with no
 * --tail, `git log` with no -n, `cat` of a 2 MB file or `ls -R`. The model then retries with a
 * narrower call. Commands that already pipe, redirect or limit their output are left alone.
 *
 * Post-tool, it records how much each call actually printed, filed under the program's name (shell)
 * or the file's extension (reads): never the command or the output. Once a program has run unfiltered
 * at least 5 times here and typically printed more than the size limit, the guard treats it like the
 * built-in rules (`big-by-habit`), so diet learns the commands that flood your own projects.
 *
 *   diet.ts [source]            pre-tool hook        source = claude-code (default) | copilot
 *   diet.ts measure [source]    post-tool hook: record the size of what the call printed
 *   diet.ts sizes [--json]      what each program and file type has typically printed
 *
 * Env:
 *   TOKENOMICS_DIET         block (default) | warn (notice only, never denies) | off
 *   TOKENOMICS_DIET_MAX_KB  files below this size are never blocked (default 64)
 *   TOKENOMICS_DIET_LEARN   on (default: record sizes, and use them) | off
 * Bypass for one command: append `# diet-ok`. Rules: tokenomics/engine/diet.ts.
 * Always exits 0; a crash never blocks a tool call (errors go to <db>.err).
 */
import { defaultDbPath, loadSettings } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as diet from '../tokenomics/engine/diet.ts'
import { TOOL_SHELL } from '../tokenomics/engine/evidence.ts'
import * as events from '../tokenomics/engine/events.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { errText, fmt, isMain, logErr, readPayload } from '../tokenomics/util.ts'
import { write } from './common.ts'

const learning = () => (process.env.TOKENOMICS_DIET_LEARN ?? 'on').trim().toLowerCase() !== 'off'
const RECENT = 2_000            // rows read to work out typical sizes

/** Median output, in characters, of each kind with enough recorded runs. */
export function learned(dbPath: string, min = diet.LEARN_MIN_RUNS): Record<string, { runs: number, median: number, max: number }> {
  try {
    return withDb(dbPath, (db) => {
      if (!db.tables().has('diet_sizes')) return {}
      const by = new Map<string, number[]>()
      for (const r of db.all('SELECT kind, chars FROM diet_sizes ORDER BY id DESC LIMIT ?', RECENT)) {
        const list = by.get(r.kind) ?? []
        list.push(Number(r.chars))
        by.set(String(r.kind), list)
      }
      const out: Record<string, { runs: number, median: number, max: number }> = {}
      for (const [k, v] of by) {
        if (v.length < min) continue
        v.sort((a, b) => a - b)
        out[k] = { runs: v.length, median: v[Math.floor(v.length / 2)], max: v[v.length - 1] }
      }
      return out
    }, { readOnly: true })
  } catch {
    return {}
  }
}

function guard(source: string): void {
  const mode = (process.env.TOKENOMICS_DIET ?? 'block').trim().toLowerCase()
  if (mode === 'off') return
  const payload = readPayload()
  const adapter = getAdapter(source)
  const call = adapter.toolCall(payload)
  if (call === null) return
  const dbPath = loadSettings().dbPath
  const typical = call.kind === TOOL_SHELL && learning()
    ? Object.fromEntries(Object.entries(learned(dbPath)).map(([k, v]) => [k, v.median])) : {}
  const verdict = diet.check(call, payload.cwd ?? null, typical)
  if (verdict === null) return
  const action = mode === 'warn' ? 'warned' : 'denied'
  const out = action === 'warned' ? adapter.notify(verdict.reason) : adapter.denyTool(verdict.reason)
  events.log(dbPath, 'diet_events', { session_id: adapter.sessionId(payload), source: adapter.name,
    tool: call.name, rule: verdict.rule, est_tokens: verdict.estTokens, action })
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

function measure(source: string): void {
  if ((process.env.TOKENOMICS_DIET ?? '').trim().toLowerCase() === 'off' || !learning()) return
  const payload = readPayload()
  const adapter = getAdapter(source)
  const call = adapter.toolCall(payload)
  const chars = adapter.toolResultChars(payload)
  if (call === null || chars === null) return
  const kind = diet.sizeKind(call)
  if (!kind) return
  events.log(loadSettings().dbPath, 'diet_sizes', { session_id: adapter.sessionId(payload), source: adapter.name,
    tool: call.name, kind, chars, est_tokens: Math.ceil(chars / 4) })
}

function sizes(args: string[]): number {
  const all = learned(defaultDbPath(), 1)
  const rows = Object.entries(all).map(([kind, v]) => ({ kind, runs: v.runs, median_tokens: Math.ceil(v.median / 4),
    max_tokens: Math.ceil(v.max / 4), flagged: !kind.startsWith('read') && v.runs >= diet.LEARN_MIN_RUNS && v.median >= diet.maxBytes() }))
    .sort((a, b) => b.median_tokens - a.median_tokens)
  if (args.includes('--json')) {
    write(JSON.stringify({ kinds: rows }, null, 2))
    return 0
  }
  if (!rows.length) {
    write('diet: no tool output sizes recorded yet.')
    return 0
  }
  write('diet: what each program (run unfiltered) and file type typically printed')
  for (const r of rows.slice(0, 20)) {
    write(`- ${r.kind.padEnd(16)} ${String(r.runs).padStart(4)} runs, typically ${fmt(r.median_tokens)} tokens, up to ${fmt(r.max_tokens)}` +
      (r.flagged ? '  (diet now asks for a filter)' : ''))
  }
  return 0
}

export function main(args: string[]): number {
  const [first = 'claude-code', second = 'claude-code'] = args
  if (first === 'sizes') return sizes(args.slice(1))
  try {
    if (first === 'measure') measure(second)
    else guard(first)
  } catch (e) {
    logErr(defaultDbPath(), `diet ${first}\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
