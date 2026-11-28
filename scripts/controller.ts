#!/usr/bin/env node
/**
 * agentarium / controller: one decision and one message per prompt.
 *
 * Claude Code's UserPromptSubmit used to start eight Node.js processes per prompt (till,
 * pennywise, budget, doggybag, haggle, blinkers, ballast, parrot), each reading the session on its
 * own, in parallel, each free to add its own message. The controller runs them in one process, in
 * an order that lets the stronger decision win:
 *
 *   1. till        records the prompt (never says anything)
 *   2. budget      a limit reached pauses the prompt: nothing else runs
 *   3. holdup      a huge paste (a log, a document, a data dump) or a blatantly broad ask pauses the prompt
 *   4. pennywise   picks the model (it already routes down harder as the budget runs out)
 *   5. haggle      prices the task; a quote over the cap pauses the prompt
 *   6. ballast · doggybag · blinkers · parrot   advice for the next steps
 *
 * Copilot CLI gets the same: one process for its prompt hook, with the helpers that work there
 * (COPILOT_STEPS): till records the prompt, premium pauses it once the month's premium
 * requests are used up (when Copilot honours prompt-hook output; until then it only records),
 * doggybag arms its cold-cache check, blinkers notes what the task asked for.
 * VS Code (VSCODE_STEPS) runs the same without doggybag, and its prompt hook does honour a pause,
 * so hold-up runs there too.
 *
 * The first helper to pause (block) the prompt decides alone. Otherwise every notice is joined into
 * one message, and every piece of context into one block, so the user sees one line per prompt.
 * Each helper keeps its own switch (AGENTARIUM_BUDGET_MODE, AGENTARIUM_PENNYWISE, ...), and a
 * helper that throws is skipped: the others still run, and a crash never blocks a prompt.
 *
 * Every prompt also times each step (loading it included: each prompt is a fresh process) and
 * records the times in controller_events, so `agentarium doctor` can name a helper that slows
 * every prompt down.
 *
 * Usage (hook command):   controller.ts prompt [source]        source = claude-code (default) | copilot | vscode
 *                         controller.ts explain [source]          print the order and what each step does
 *                         controller.ts latency [--json]          each step's median and p90 time, slow ones flagged
 * Env: AGENTARIUM_CONTROLLER_SKIP     comma-separated helpers to leave out, e.g. "parrot,blinkers"
 *      AGENTARIUM_CONTROLLER_TIMING   on (default) | off: don't record step times
 *      AGENTARIUM_CONTROLLER_SLOW_MS  a step whose median time is at least this is flagged (default 150)
 * Always exits 0. Errors go to <db>.err.
 */
import { existsSync } from 'node:fs'

import { defaultDbPath } from '../agentarium/config.ts'
import { withDb } from '../agentarium/engine/db.ts'
import { errText, isMain, isObj, logErr, now, readStdin, setStdin, type Obj } from '../agentarium/util.ts'

type Step = { name: string, run: (source: string) => Promise<unknown> | unknown, blocks: boolean, about: string }

const HOLDUP: Step = { name: 'holdup', blocks: true, about: 'pauses a prompt that pastes in a huge log, document or file, or asks for the whole repo',
  run: async (s) => (await import('./holdup.ts')).main([s]) }

/** The prompt-time helpers, in decision order. Imported lazily so a broken one can't stop the rest. */
export const STEPS: Step[] = [
  { name: 'till', blocks: false, about: 'records the prompt',
    run: async (s) => (await import('./till.ts')).main(['prompt', s]) },
  { name: 'budget', blocks: true, about: 'pauses the prompt once a daily or session limit is reached',
    run: async (s) => (await import('./budget.ts')).main([s]) },
  HOLDUP,
  { name: 'pennywise', blocks: true, about: 'routes the prompt to the model it needs (harder down on a tight budget)',
    run: async () => (await import('./pennywise.ts')).main([]) },
  { name: 'haggle', blocks: true, about: "prices the task and pauses a quote over the cap",
    run: async (s) => (await import('./haggle.ts')).main(['prompt', s]) },
  { name: 'ballast', blocks: false, about: "flags a new task carrying the last one's context",
    run: async (s) => (await import('./ballast.ts')).main([s]) },
  { name: 'doggybag', blocks: true, about: 'offers a fresh start from the notes when the cache went cold',
    run: async (s) => (await import('./doggybag.ts')).main(['prompt', s]) },
  { name: 'blinkers', blocks: false, about: 'notes what the task asked for, for the scope guard',
    run: async (s) => (await import('./blinkers.ts')).main(['prompt', s]) },
  { name: 'parrot', blocks: false, about: 'spots instructions repeated across sessions',
    run: async (s) => (await import('./parrot.ts')).main([s]) },
]

/** Copilot's prompt-time helpers. Its prompt-hook output is ignored today, so these are the ones
 *  that do their work without it: recording, the allowance guard (records until Copilot honours a
 *  pause), doggybag's arming and blinkers' note of the task. */
export const COPILOT_STEPS: Step[] = [
  { name: 'till', blocks: false, about: 'records the prompt',
    run: async (s) => (await import('./till.ts')).main(['prompt', s]) },
  { name: 'premium', blocks: true, about: "pauses the prompt once the month's premium requests are used up",
    run: async (s) => (await import('./premium.ts')).main([s]) },
  { name: 'doggybag', blocks: false, about: 'arms the cold-cache check for the next prompt',
    run: async (s) => (await import('./doggybag.ts')).main(['arm', s]) },
  { name: 'blinkers', blocks: false, about: 'notes what the task asked for, for the scope guard',
    run: async (s) => (await import('./blinkers.ts')).main(['prompt', s]) },
]

/** VS Code's prompt-time helpers. It honours a pause, so premium and hold-up can stop the prompt; the
 *  helpers that read a Claude Code transcript (doggybag, haggle, ballast) have nothing to read there. */
export const VSCODE_STEPS: Step[] = COPILOT_STEPS.filter((s) => s.name !== 'doggybag')
  .flatMap((s) => (s.name === 'premium' ? [s, HOLDUP] : [s]))

/** The steps for a platform: Copilot CLI's, VS Code's, or Claude Code's (the default). */
export const stepsFor = (source: string) => (source === 'copilot' ? COPILOT_STEPS : source === 'vscode' ? VSCODE_STEPS : STEPS)

/** Run `fn` with stdout captured; returns what it wrote. */
async function capture(fn: () => Promise<unknown> | unknown): Promise<string> {
  const chunks: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((c: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined
    cb?.()
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = write
  }
  return chunks.join('')
}

/** Every JSON object a helper printed (one per line). */
export function outputs(text: string): Obj[] {
  const out: Obj[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (isObj(v)) out.push(v)
    } catch {
      // not JSON: UserPromptSubmit stdout would be injected as context, so keep it as that
      out.push({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } })
    }
  }
  return out
}

export type Decided = { output: Obj | null, ran: string[], decidedBy: string | null,
  /** milliseconds each step took, in order, then 'total' */
  timings?: [string, number][] }

/** Merge helper outputs: the first block wins alone; otherwise one message and one context. */
export function combine(results: [string, Obj[]][]): Decided {
  const messages: string[] = []
  const context: string[] = []
  const ran: string[] = []
  for (const [name, outs] of results) {
    ran.push(name)
    for (const o of outs) {
      if (o.decision === 'block' || o.continue === false) return { output: o, ran, decidedBy: name }
      if (typeof o.systemMessage === 'string' && o.systemMessage.trim()) messages.push(o.systemMessage.trim())
      const add = isObj(o.hookSpecificOutput) ? o.hookSpecificOutput.additionalContext : undefined
      if (typeof add === 'string' && add.trim()) context.push(add.trim())
    }
  }
  if (!messages.length && !context.length) return { output: null, ran, decidedBy: null }
  const output: Obj = {}
  if (messages.length) output.systemMessage = messages.join('\n')
  if (context.length) output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n\n') }
  return { output, ran, decidedBy: null }
}

/** Run the prompt-time helpers on one payload, in order; stop at the first that pauses the prompt. */
export async function decide(raw: string, source = 'claude-code', skip = new Set<string>()): Promise<Decided> {
  const results: [string, Obj[]][] = []
  const timings: [string, number][] = []
  const exit = process.exitCode
  const start = performance.now()
  setStdin(raw)
  try {
    for (const step of stepsFor(source)) {
      if (skip.has(step.name)) continue
      let outs: Obj[] = []
      const t0 = performance.now()
      try {
        outs = outputs(await capture(() => step.run(source)))
      } catch (e) {
        logErr(defaultDbPath(), `controller: ${step.name}\n${errText(e)}`)
      }
      timings.push([step.name, performance.now() - t0])
      results.push([step.name, outs])
      if (step.blocks && outs.some((o) => o.decision === 'block' || o.continue === false)) break
    }
  } finally {
    setStdin(null)
    process.exitCode = exit
  }
  timings.push(['total', performance.now() - start])
  record(raw, source, timings)
  return { ...combine(results), timings }
}

// ---- latency ------------------------------------------------------------------------------------

const KEEP_ROWS = 20_000
export const slowMs = () => Number(process.env.AGENTARIUM_CONTROLLER_SLOW_MS) > 0 ? Number(process.env.AGENTARIUM_CONTROLLER_SLOW_MS) : 150

/** Store one prompt's step times in controller_events. Never throws; off with AGENTARIUM_CONTROLLER_TIMING=off. */
function record(raw: string, source: string, timings: [string, number][]): void {
  if ((process.env.AGENTARIUM_CONTROLLER_TIMING ?? 'on').trim().toLowerCase() === 'off') return
  try {
    let sid = ''
    try {
      const d = JSON.parse(raw)
      sid = isObj(d) ? String(d.session_id ?? d.sessionId ?? '') : ''
    } catch {
      sid = ''
    }
    withDb(defaultDbPath(), (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS controller_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session_id TEXT,
        run TEXT, source TEXT, step TEXT, ms REAL)`)
      const ts = now()
      const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      db.transaction(() => {
        for (const [step, ms] of timings) db.run('INSERT INTO controller_events(ts,session_id,run,source,step,ms) VALUES(?,?,?,?,?,?)', ts, sid, run, source, step,
          Math.round(ms * 10) / 10)
        db.run('DELETE FROM controller_events WHERE id <= (SELECT MAX(id) FROM controller_events) - ?', KEEP_ROWS)
      })
    })
  } catch (e) {
    logErr(defaultDbPath(), `controller timing\n${errText(e)}`)
  }
}

export type StepLatency = { step: string, source: string, prompts: number, median: number, p90: number, share: number, slow: boolean }

const pct = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))] : 0
}

/** Each step's median and p90 time over the last `prompts` prompts per platform, and its share
 *  of the median prompt. A step is slow when its median is at least slowMs(). */
export function latency(dbPath = defaultDbPath(), prompts = 200): StepLatency[] {
  if (!existsSync(dbPath)) return []
  try {
    return withDb(dbPath, (db) => {
      if (!db.tables().has('controller_events')) return []
      const out: StepLatency[] = []
      for (const { source } of db.all('SELECT DISTINCT source FROM controller_events ORDER BY source')) {
        const rows = db.all(`SELECT step, ms FROM controller_events WHERE source=? AND run IN
          (SELECT run FROM controller_events WHERE source=? AND step='total' ORDER BY id DESC LIMIT ?)`, source, source, prompts)
        const by = new Map<string, number[]>()
        for (const r of rows) by.set(String(r.step), [...(by.get(String(r.step)) ?? []), Number(r.ms)])
        const total = pct(by.get('total') ?? [], 0.5)
        for (const [step, ms] of by) {
          if (step === 'total') continue
          const median = pct(ms, 0.5)
          out.push({ step, source: String(source), prompts: ms.length, median, p90: pct(ms, 0.9), share: total > 0 ? median / total : 0,
            slow: median >= slowMs() })
        }
        out.push({ step: 'total', source: String(source), prompts: (by.get('total') ?? []).length, median: total,
          p90: pct(by.get('total') ?? [], 0.9), share: 1, slow: false })
      }
      return out
    }, { readOnly: true })
  } catch {
    return []
  }
}

/** The latency table as lines for `agentarium doctor`, or one line when nothing is recorded. */
export function latencyLines(rows = latency()): string[] {
  if (!rows.length) return ['  prompt time  nothing recorded yet (the controller times each prompt)']
  const L: string[] = []
  for (const src of [...new Set(rows.map((r) => r.source))]) {
    const rs = rows.filter((r) => r.source === src)
    const total = rs.find((r) => r.step === 'total')!
    L.push(`  prompt time  ${src}: ~${Math.round(total.median)} ms a prompt (p90 ${Math.round(total.p90)} ms, last ${total.prompts} prompts)`)
    for (const r of rs.filter((x) => x.step !== 'total').sort((a, b) => b.median - a.median)) {
      L.push(`    ${r.step.padEnd(10)} ${String(Math.round(r.median)).padStart(5)} ms  p90 ${String(Math.round(r.p90)).padStart(5)} ms  ` +
        `${String(Math.round(r.share * 100)).padStart(3)}%` + (r.slow ? `  ! slows every prompt: AGENTARIUM_CONTROLLER_SKIP=${r.step} leaves it out` : ''))
    }
  }
  return L
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = 'prompt', source = 'claude-code'] = argv
  if (cmd === 'latency') {
    const rows = latency()
    process.stdout.write(argv.includes('--json') ? JSON.stringify(rows, null, 2) + '\n' : latencyLines(rows).join('\n') + '\n')
    return 0
  }
  if (cmd === 'explain') {
    process.stdout.write(stepsFor(source).map((s, i) => `${i + 1}. ${s.name.padEnd(10)} ${s.about}${s.blocks ? ' (can pause the prompt)' : ''}`).join('\n') + '\n')
    return 0
  }
  try {
    const skip = new Set((process.env.AGENTARIUM_CONTROLLER_SKIP ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
    const d = await decide(readStdin(), source, skip)
    if (d.output) process.stdout.write(JSON.stringify(d.output) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `controller\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
