#!/usr/bin/env node
/**
 * agentarium / premium: Copilot's premium-request allowance, as a guard. Copilot bills premium
 * requests against a monthly allowance, not tokens, so this is its budget.
 *
 * Prompt hook (Copilot: userPromptSubmitted, run by the controller). Once this month's premium
 * requests reach AGENTARIUM_COPILOT_ALLOWANCE (each prompt counted at its model's multiplier, see
 * engine/premium.ts; the same figures as the status line and `agentarium copilot`), the next prompt is paused with what
 * was used and what to do. Send the same prompt again to carry on.
 *
 * VS Code honours the pause (its adapter declares `prompt_decision`). Copilot CLI ignores prompt-hook output today: the Copilot adapter declares no `prompt_decision`
 * capability, so until it does the guard only records 'would-pause' (once a session) and says
 * nothing. Nothing here changes when Copilot starts honouring the output, except the adapter.
 *
 * Usage (hook command):  premium.ts [source]      source = copilot | vscode (Claude Code bills tokens: nothing to do)
 * Env:
 *   AGENTARIUM_PREMIUM              block (default) | warn (a notice, no pause) | off
 *   AGENTARIUM_COPILOT_ALLOWANCE    premium requests a month (unset = the guard does nothing)
 *   AGENTARIUM_COPILOT_MULTIPLIER   requests per prompt, your model's multiplier (default 1)
 * Records what it did in premium_events. Always exits 0; a crash never blocks a prompt.
 */
import { copilotAllowance, copilotUsage, FORECAST_STEPS, premiumOutlook, type Premium } from './statusline.ts'
import { defaultDbPath } from '../agentarium/config.ts'
import { withDb } from '../agentarium/engine/db.ts'
import * as events from '../agentarium/engine/events.ts'
import type { PlatformAdapter } from '../agentarium/platform/adapter.ts'
import { BILLING_COPILOT_PREMIUM_REQUESTS, Capability } from '../agentarium/platform/capabilities.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'
import { errText, first, isMain, logErr, readPayload, sha1, type Obj } from '../agentarium/util.ts'

const mode = () => (process.env.AGENTARIUM_PREMIUM ?? 'block').trim().toLowerCase()

/** This session's earlier premium_events: the last action and the prompt it was about. */
function seen(dbPath: string, sid: string): { action: string, prompt_sha: string | null }[] {
  try {
    return withDb(dbPath, (db) => (db.tables().has('premium_events')
      ? db.all('SELECT action, prompt_sha FROM premium_events WHERE session_id=? ORDER BY id DESC LIMIT 20', sid) as { action: string, prompt_sha: string | null }[]
      : []), { readOnly: true })
  } catch {
    return []
  }
}

export function reason(p: Premium): string {
  return `premium: this month's Copilot premium requests are used up (${p.used} of ${p.allowance}). ` +
    'Further requests may be billed or slowed. Switch to an included (0x) model, or send the same prompt again to carry on.'
}

/** The guard's hook output for one prompt (null: nothing to say, or the platform can't say it). */
export function decide(payload: Obj, adapter: PlatformAdapter, dbPath = defaultDbPath(), d = new Date()): Obj | null {
  const m = mode()
  if (m === 'off' || adapter.billingModel !== BILLING_COPILOT_PREMIUM_REQUESTS) return null
  const a = copilotAllowance()
  if (!a) return null
  const u = copilotUsage(d, a.multiplier)
  const p = premiumOutlook(u?.prompts ?? 0, a, d, FORECAST_STEPS, u)
  if (!p.over) return null
  const sid = adapter.sessionId(payload)
  const digest = sha1(String(first(payload, ['prompt', 'userPrompt'], ''))).slice(0, 12)
  const before = seen(dbPath, sid)
  const log = (action: string) => events.log(dbPath, 'premium_events', { session_id: sid, source: adapter.name, used: p.used,
    allowance: p.allowance, prompt_sha: digest, action })
  if (!adapter.supports(Capability.PROMPT_DECISION)) {
    // the platform would drop the message: record it once a session, so reports can say what it would have done
    if (!before.some((e) => e.action === 'would-pause')) log('would-pause')
    return null
  }
  if (m === 'warn') {
    if (before.some((e) => e.action === 'warned')) return null
    log('warned')
    return adapter.notify(reason(p))
  }
  if (before[0]?.action === 'paused' && before[0].prompt_sha === digest) {     // the same prompt again: "I meant it"
    log('overridden')
    return null
  }
  if (before.some((e) => e.action === 'overridden')) return null               // carried on once: don't nag every prompt
  log('paused')
  return adapter.blockPrompt(reason(p))
}

export async function main(argv: string[]): Promise<number> {
  try {
    const adapter = getAdapter(argv[0] ?? 'copilot')
    const out = decide(readPayload(), adapter)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `premium\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
