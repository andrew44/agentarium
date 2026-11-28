#!/usr/bin/env node
/**
 * agentarium / kettle: when the assistant stops to wait for you, say how long the cache stays warm.
 *
 * The prompt cache keeps the conversation for 5 minutes after the last request (an hour on the 1-hour
 * cache). Reply inside that and the next prompt re-reads it at a tenth of the input price; reply after
 * it and the whole conversation is written to the cache again. The statusline counts this down, but
 * only while you are looking. kettle puts the deadline and the money into the notification you get
 * when Claude Code goes idle or waits for a permission:
 *
 *   kettle: 3:20 to reply before the cache goes cold (62,010 tokens, about £0.23 at risk)
 *
 * Notification hook (Claude Code: Notification, matcher idle_prompt|permission_prompt). Claude Code
 * ignores a Notification hook's systemMessage, so the message goes out as a terminal notification
 * (OSC 9 and OSC 777: iTerm2, Windows Terminal, kitty, WezTerm, Ghostty; other terminals ignore it),
 * and with `desktop` as a system notification too. Once per request: a second notification about the
 * same wait says nothing.
 *
 *   kettle.ts [source]       hook (stdin: hook JSON)
 *
 * Env: AGENTARIUM_KETTLE            on (default: terminal notification) | desktop (also a system
 *                                   notification: macOS and Linux) | off
 *      AGENTARIUM_KETTLE_MIN_TOKENS stay quiet below this context size (default 20000)
 *      AGENTARIUM_CACHE_TTL         cache lifetime in seconds (default: detected, 300 or 3600)
 * Always exits 0.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { defaultDbPath } from '../agentarium/config.ts'
import { ttlFor } from '../agentarium/engine/coldcache.ts'
import { withDb } from '../agentarium/engine/db.ts'
import { rebuildCost } from '../agentarium/engine/prefix.ts'
import * as trace from '../agentarium/engine/trace.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../agentarium/services/index.ts'
import { errText, first, isMain, logErr, readPayload, type Obj } from '../agentarium/util.ts'

const TAIL_BYTES = 1_000_000
const minTokens = () => PolicyEngine.threshold('AGENTARIUM_KETTLE_MIN_TOKENS', 20_000, { min: 0 })
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export type Kettle = { ctx: number, usd: number, secondsLeft: number, turn: string }

/** How long the session's cache has left and what it would cost to lose it; null when nothing is at stake. */
export function reading(t: trace.Trace, nowS = Date.now() / 1000): Kettle | null {
  const cost = rebuildCost(t)
  const last = [...t.turns].reverse().find((x) => !x.sidechain && x.ctx > 0)
  if (!cost || !last || last.ts === null) return null
  const left = last.ts + ttlFor(t) - nowS
  return left > 0 ? { ctx: cost.ctx, usd: cost.usd, secondsLeft: Math.round(left), turn: last.id } : null
}

export function message(k: Kettle): string {
  const { fmt } = CostEngine.display()
  return `kettle: ${mmss(k.secondsLeft)} to reply before the cache goes cold ` +
    `(${k.ctx.toLocaleString('en-GB')} tokens, about ${fmt(k.usd)} at risk)`
}

/** OSC 9 (iTerm2, Windows Terminal, kitty, WezTerm, Ghostty) and OSC 777 (rxvt, foot, some others). */
export function terminalSequence(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ')
  return `\u001b]9;${clean}\u0007\u001b]777;notify;agentarium;${clean.replaceAll(';', ',')}\u0007`
}

function desktop(text: string): void {
  try {
    const cmd = process.platform === 'darwin'
      ? ['osascript', '-e', `display notification ${JSON.stringify(text)} with title "agentarium"`]
      : process.platform === 'linux' ? ['notify-send', 'agentarium', text] : null
    if (cmd) spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  } catch {
    // the terminal notification still went out
  }
}

function said(dbPath: string, sid: string, turn: string): boolean {
  try {
    return withDb(dbPath, (db) => db.tables().has('kettle_events') &&
      Boolean(db.get('SELECT 1 FROM kettle_events WHERE session_id=? AND action=? LIMIT 1', sid, `told:${turn}`)))
  } catch {
    return false
  }
}

function hook(source: string): void {
  const mode = PolicyEngine.mode('AGENTARIUM_KETTLE', 'on', ['on', 'desktop', 'off'])
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    if (adapter.name !== 'claude-code') return
    const kind = String(first(payload, ['notification_type'], '') || '')
    if (kind && !['idle_prompt', 'permission_prompt', 'agent_needs_input'].includes(kind)) return
    const path = String(first(payload, ['transcript_path'], '') || '')
    if (!path || !existsSync(path)) return
    const k = reading(trace.parse(path, { tail: TAIL_BYTES }))
    if (!k || k.ctx < minTokens()) return
    const sid = adapter.sessionId(payload)
    if (said(dbPath, sid, k.turn)) return
    const text = message(k)
    if (mode === 'desktop') desktop(text)
    const out: Obj = { terminalSequence: terminalSequence(text) }
    PolicyEngine.log(dbPath, 'kettle_events', { session_id: sid, source: adapter.name, ctx_tokens: k.ctx,
      at_risk_usd: Math.round(k.usd * 1e6) / 1e6, seconds_left: k.secondsLeft, action: `told:${k.turn}` })
    process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `kettle\n${errText(e)}`)
  }
}

export function main(args: string[]): number {
  hook(args[0] ?? 'claude-code')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
