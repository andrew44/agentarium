#!/usr/bin/env node
/**
 * tokenomics / cache-buster: catch an edit that would make the prompt cache start again.
 *
 * The prompt cache keys on the start of each request: CLAUDE.md and the files it imports, settings,
 * MCP servers and the skill, command and agent listings. Edit one of those mid-session and the next
 * request that picks the change up writes the whole conversation to the cache again, at 1.25x the
 * input price instead of a tenth. cold-snap finds these afterwards as "prefix change"; this hook
 * catches them before the edit, prices them from the session's context size and lets you decide.
 * Rules: tokenomics/engine/prefix.ts.
 *
 * Pre-tool hook (Claude Code: PreToolUse on Edit|Write|MultiEdit|NotebookEdit). Each file is raised
 * once per session. Copilot bills premium requests, not cache writes, so it has no Copilot hook.
 *
 *   cachebuster.ts [source]                      hook (stdin: hook JSON)
 *   cachebuster.ts check [--session ID | --transcript FILE] [--json]
 *                                                 replay a session and list every prefix edit, priced
 *
 * Env: TOKENOMICS_CACHEBUSTER        warn (default: tell you once per file) | ask (confirm first) |
 *                                    block (refuse; the agent leaves a note to make the edit later) | off
 *      TOKENOMICS_CACHEBUSTER_MIN_TOKENS  stay quiet below this context size (default 10000)
 * Always exits 0; a crash never blocks an edit.
 */
import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as lessons from '../tokenomics/engine/lessons.ts'
import { prefixKind, rebuildCost, type PrefixKind } from '../tokenomics/engine/prefix.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { argValue, errText, first, isMain, logErr, readPayload, type Obj } from '../tokenomics/util.ts'
import { money2, write } from './common.ts'

const TAIL_BYTES = 1_000_000                // the last request's usage is all that is needed
const LABEL: Record<PrefixKind, string> = {
  instructions: 'the instructions', settings: 'the settings', mcp: 'the MCP server list', skills: 'the skill and command listing',
}

const minTokens = () => PolicyEngine.threshold('TOKENOMICS_CACHEBUSTER_MIN_TOKENS', 10_000, { min: 0 })

function seen(dbPath: string, sid: string, path: string): boolean {
  try {
    return withDb(dbPath, (db) => db.tables().has('cachebuster_events') &&
      Boolean(db.get('SELECT 1 FROM cachebuster_events WHERE session_id=? AND path=? LIMIT 1', sid, path)))
  } catch {
    return false
  }
}

export function message(kind: PrefixKind, name: string, ctx: number, usd: number): string {
  const { fmt } = CostEngine.display()
  return `cache-buster: ${name} is part of ${LABEL[kind]}, which sits at the start of every request. Changing it mid-session ` +
    `means the next request that picks it up writes the whole conversation (${ctx.toLocaleString('en-GB')} tokens) to the ` +
    `cache again: about ${fmt(usd)} more than a warm read. If this task doesn't need it now, make the edit at the end ` +
    'of the session.'
}

function hook(source: string): void {
  const mode = PolicyEngine.mode('TOKENOMICS_CACHEBUSTER', 'warn', ['warn', 'ask', 'block', 'off'])
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    if (adapter.name !== 'claude-code') return
    const call = adapter.toolCall(payload)
    const cwd = String(payload.cwd || process.cwd())
    if (!call?.path) return
    const kind = prefixKind(call.path, cwd)
    if (!kind) return
    const path = String(first(payload, ['transcript_path', 'transcriptPath'], '') || '')
    if (!path) return
    const cost = rebuildCost(trace.parse(path, { tail: TAIL_BYTES }))
    if (!cost || cost.ctx < minTokens()) return
    const sid = adapter.sessionId(payload)
    if (seen(dbPath, sid, call.path)) return
    const name = call.path.split(/[\\/]/).pop() || call.path
    let msg = message(kind, name, cost.ctx, cost.usd)
    const action: PolicyEngine.Action = mode === 'ask' ? 'ask' : mode === 'block' ? 'deny' : 'warn'
    if (action === 'deny') msg += ' Leave the change as a note for the user to make later, and carry on with the task.'
    msg += lessons.teach(dbPath, 'prefix-change', { sessionId: sid, source: adapter.name })
    const out = PolicyEngine.enforce(adapter, action, msg)
    PolicyEngine.log(dbPath, 'cachebuster_events', { session_id: sid, source: adapter.name, tool: call.name, kind, path: call.path,
      ctx_tokens: cost.ctx, usd: Math.round(cost.usd * 1e6) / 1e6, action: PolicyEngine.effective(adapter, action) })
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `cachebuster\n${errText(e)}`)
  }
}

export type PrefixEdit = { turn: number, tool: string, path: string, kind: PrefixKind, ctx_tokens: number, usd: number }

/** Every edit to a prefix file in a finished session, priced at the context it had then. */
export function replay(t: trace.Trace): PrefixEdit[] {
  const cwd = t.cwd || process.cwd()
  const out: PrefixEdit[] = []
  for (const s of t.steps) {
    if (s.sidechain || !trace.EDIT_TOOLS.has(s.name) || s.isError) continue
    const p = trace.filePath(s)
    const kind = prefixKind(p, cwd)
    if (!kind) continue
    const cost = rebuildCost({ ...t, turns: t.turns.slice(0, s.turn + 1) })
    out.push({ turn: s.turn, tool: s.name, path: p, kind, ctx_tokens: cost?.ctx ?? 0, usd: cost?.usd ?? 0 })
  }
  return out
}

export function main(args: string[]): number {
  if (args[0] !== 'check') {
    hook(args[0] ?? 'claude-code')
    return 0
  }
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const edits = replay(trace.parse(p))
  const total = edits.reduce((a, e) => a + e.usd, 0)
  if (args.includes('--json')) {
    write(JSON.stringify({ transcript: p, edits, total_usd: total } satisfies Obj, money2, 2))
    return 0
  }
  const { fmt } = CostEngine.display()
  if (!edits.length) {
    write('cache-buster: no edits to instruction, settings or skill files in this session.')
    return 0
  }
  write(`cache-buster: ${edits.length} edit(s) to the start of the context in this session, up to about ${fmt(total)} in cache rebuilds.`)
  for (const e of edits) write(`- ${e.path} (${LABEL[e.kind]}): ${e.ctx_tokens.toLocaleString('en-GB')} tokens, about ${fmt(e.usd)}`)
  write('Make these edits at the end of a session, or just before /clear, when the cache is rebuilt anyway.')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
