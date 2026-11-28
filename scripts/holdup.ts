#!/usr/bin/env node
/**
 * tokenomics / hold-up: pause a prompt that pastes in what the agent could read for itself.
 *
 * A pasted 100,000-token log joins the conversation for good: written to the cache with the prompt,
 * then re-read at every later step, though the agent could have grepped the file for the ten lines
 * that matter. hold-up sizes the prompt before it is sent, says what most of it is (a log, data, an
 * encoded blob, a diff, source code, a document or other pasted text), what carrying it costs and what
 * to do instead. It also catches a short prompt that is blatantly too broad ("refactor the whole
 * codebase", "fix all the bugs") with nothing named to start from. Send the same prompt again to go
 * ahead as it is. Rules: tokenomics/engine/holdup.ts.
 *
 * Prompt hook, run by the controller: Claude Code (UserPromptSubmit) and VS Code, which bills premium
 * requests, so there it says what the paste does to the context but never what it costs. Copilot CLI
 * ignores prompt-hook output, so it has no hold-up step. A notice can't take a paste back once it is
 * sent, so the default is to pause: once per prompt and only above the threshold. Prompts starting
 * with "/" are never checked.
 *
 *   holdup.ts [source]          hook (stdin: hook JSON)
 *
 * Env: TOKENOMICS_HOLDUP             block (default: pause once; send it again to go ahead) |
 *                                    warn (a notice; the prompt goes ahead) | off
 *      TOKENOMICS_HOLDUP_MIN_TOKENS  speak up from this prompt size (default 10000, about 40 KB)
 *      TOKENOMICS_HOLDUP_BROAD       block | warn | off for a prompt that is too broad (default: as TOKENOMICS_HOLDUP)
 * Logged to holdup_events: the size, the kind ('broad' for scope) and a hash of the prompt (to know a
 * resend), never the text.
 * Always exits 0; a crash never blocks a prompt.
 */
import { defaultDbPath } from '../tokenomics/config.ts'
import { lastContext, stepsPerPrompt } from '../tokenomics/engine/ballast.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as holdup from '../tokenomics/engine/holdup.ts'
import * as lessons from '../tokenomics/engine/lessons.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { BILLING_ANTHROPIC_TOKENS, Capability } from '../tokenomics/platform/capabilities.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { errText, first, isMain, logErr, readPayload, sha1, type Obj } from '../tokenomics/util.ts'

const TAIL_BYTES = 2 * 1024 * 1024
export const minTokens = () => PolicyEngine.threshold('TOKENOMICS_HOLDUP_MIN_TOKENS', 10_000, { min: 500 })

/** Was this exact prompt paused before in this session? Then sending it again means go ahead. */
function pausedBefore(dbPath: string, sid: string, digest: string): boolean {
  try {
    return withDb(dbPath, (db) => db.tables().has('holdup_events') &&
      Boolean(db.get("SELECT 1 FROM holdup_events WHERE session_id=? AND prompt_sha=? AND action='block' LIMIT 1", sid, digest)),
    { readOnly: true })
  } catch {
    return false
  }
}

/** The paste priced on the session's model, with the steps a task has taken so far in it. */
function cost(payload: Obj, tokens: number): holdup.Price {
  const path = first(payload, ['transcript_path', 'transcriptPath'])
  let t: trace.Trace | null = null
  if (path) {
    try {
      t = trace.parse(String(path), { tail: TAIL_BYTES })
    } catch {
      t = null
    }
  }
  const last = t ? lastContext(t) : null
  const model = last?.model || (typeof payload.model === 'string' ? payload.model : null)
  return holdup.price(tokens, model, { ttl1h: last?.ttl1h, steps: t ? stepsPerPrompt(t) : 1 })
}

function hook(source: string): void {
  const mode = PolicyEngine.mode('TOKENOMICS_HOLDUP', 'block', ['block', 'warn', 'off'])
  const broadMode = PolicyEngine.mode('TOKENOMICS_HOLDUP_BROAD', mode, ['block', 'warn', 'off'])
  if (mode === 'off' && broadMode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const prompt = String(first(payload, ['prompt', 'userPrompt'], '') || '')
    const paste = mode === 'off' ? null : holdup.check(prompt, minTokens())
    if (paste) return speak(paste, mode, source, payload, prompt, dbPath)
    const broad = broadMode === 'off' ? null : holdup.tooBroad(prompt)
    if (broad) speak(broad, broadMode, source, payload, prompt, dbPath)
  } catch (e) {
    logErr(dbPath, `holdup\n${errText(e)}`)
  }
}

/** Pause or warn about one finding, unless this exact prompt was paused before (then it goes ahead). */
function speak(p: holdup.Paste | holdup.Broad, mode: string, source: string, payload: Obj, prompt: string, dbPath: string): void {
  const adapter = getAdapter(source)
  const sid = adapter.sessionId(payload)
  const digest = sha1(prompt.trim())
  const row = { session_id: sid, source: adapter.name, kind: p.kind, est_tokens: p.tokens, lines: p.lines, prompt_sha: digest }
  if (pausedBefore(dbPath, sid, digest)) {
    PolicyEngine.log(dbPath, 'holdup_events', { ...row, usd: null, action: 'resent' })
    return
  }
  // a platform that can't pause a prompt gets the notice instead: never stricter than it can be
  const pause = mode === 'block' && adapter.supports(Capability.PROMPT_DECISION)
  const tokenBilled = adapter.billingModel === BILLING_ANTHROPIC_TOKENS
  // a broad prompt's cost is in the exploring to come, not in the prompt: nothing to price yet
  const price = tokenBilled && p.kind !== 'broad' ? cost(payload, p.tokens) : null
  const { fmt } = CostEngine.display()
  // the lessons are about the prompt cache and re-reading, which only token billing prices
  const msg = p.kind === 'broad'
    ? holdup.broadMessage(p, { paused: pause }) + (tokenBilled ? lessons.teach(dbPath, 'big-task', { sessionId: sid, source: adapter.name }) : '')
    : holdup.message(p, { paused: pause, cost: price, money: fmt }) +
      (price ? lessons.teach(dbPath, 'big-paste', { sessionId: sid, source: adapter.name }) : '')
  const action: PolicyEngine.Action = pause ? 'block' : 'warn'
  const out = PolicyEngine.enforce(adapter, action, msg)
  PolicyEngine.log(dbPath, 'holdup_events', { ...row, usd: price ? Math.round(price.taskUsd * 1e6) / 1e6 : null,
    action: PolicyEngine.effective(adapter, action) })
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

export function main(args: string[]): number {
  hook(args[0] ?? 'claude-code')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
