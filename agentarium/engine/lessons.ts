/**
 * Lessons: the why and the how behind each notice, so the user learns the habit instead of being told off.
 *
 * Give a man a fish and you feed him for a day. A notice that only says "this prompt is expensive"
 * fixes one prompt; one that says why it costs what it does, and what to type next time, fixes the
 * habit. Each prompt-time helper (hold-up, ballast, parrot, haggle, pennywise, doggybag, budget) appends
 * `teach()` to its message:
 *
 *   the first AGENTARIUM_FISHINGROD_TIMES times (3) a lesson comes up, the full lesson: "Why: ... Next time: ..."
 *   after that, or when it was already taught in this session, a one-line pointer to `agentarium fishingrod <key>`
 *
 * AGENTARIUM_FISHINGROD = on (default) | always (the full lesson every time) | off (no lessons, no pointer).
 * What was shown is logged to `fishingrod_events` (the lesson key, never the prompt). Never throws.
 */
import * as events from './events.ts'
import { withDb } from './db.ts'
import { ratesFor } from './pricing.ts'

export type Lesson = { key: string, topic: string, why: string, how: string, example?: string }
/** For the model lessons: the model ids to price, and the names to show (the ids if none). */
export type Context = { from?: string | null, to?: string | null, fromName?: string, toName?: string }

/** How many times dearer per input token `a` is than `b` (null when unknown or not dearer). */
function ratio(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  try {
    const x = ratesFor(a).input
    const y = ratesFor(b).input
    return x > 0 && y > 0 && x > y ? Math.round(x / y * 10) / 10 : null
  } catch {
    return null
  }
}

const LESSONS: ((c: Context) => Lesson)[] = [
  () => ({
    key: 'new-task', topic: 'Starting a new task in an old conversation',
    why: 'the model keeps no memory between requests, so every step re-sends the whole conversation. The last task\'s tokens ' +
      'are billed again at each step of the new one, though it doesn\'t need them, and they give it more to wade through.',
    how: 'when a task is done, /clear before the next one (doggybag keeps a note of where you got to). If part of it still ' +
      'matters, /compact and say what to keep.',
    example: '/compact keep only the decisions about the API shape',
  }),
  () => ({
    key: 'heavy-context', topic: 'A long conversation',
    why: 'each step costs roughly in proportion to the conversation\'s length: at 150,000 tokens a step costs about 15 times ' +
      'what it does at 10,000, and a model follows a long conversation less closely than a short one.',
    how: '/compact at natural break points (a feature done, the tests passing) and name what to keep. One task per conversation ' +
      'keeps them short to begin with.',
    example: '/compact keep the plan and the failing test',
  }),
  () => ({
    key: 'cold-cache', topic: 'Coming back after the cache went cold',
    why: 'the prompt cache keeps your conversation for 5 minutes after the last request (an hour on some plans). Inside that ' +
      'window it is re-read at a small fraction of the input price; after it, the whole conversation is written to the cache ' +
      'again at 1.25 times the full input price.',
    how: 'before a break, leave it: doggybag packs a note, and /clear when you come back starts from that note instead of ' +
      'the whole conversation. Or send the next prompt before the statusline\'s cache countdown runs out.',
  }),
  () => ({
    key: 'repeated-rule', topic: 'Telling the AI the same rule every session',
    why: 'each session starts blank. Only instruction files such as CLAUDE.md load every time, so a rule typed in a prompt ' +
      'lasts one session, and when it\'s forgotten you pay for the wrong work and then the correction.',
    how: 'write standing rules into CLAUDE.md, one short line each, worded as a rule.',
    example: '- Use pnpm, never npm.',
  }),
  () => ({
    key: 'correction', topic: 'Correcting the AI',
    why: 'a correction pays twice: once for the steps that went the wrong way and again to redo them, and both re-read the ' +
      'whole conversation. Most corrections come from something the prompt left the AI to guess.',
    how: 'say what "done" looks like up front: the file to change, the behaviour you expect, the test that should pass and ' +
      'what not to touch. If it\'s a rule for every session, put it in CLAUDE.md.',
    example: 'Fix the date parsing in src/parse.ts so "2026-11-21" works; `npm test -- parse` should pass; don\'t change the exports.',
  }),
  () => ({
    key: 'repeated-prompt', topic: 'Pasting the same prompt again and again',
    why: 'a long prompt retyped drifts a little each time, and small changes give different results. A slash command sends ' +
      'the same words every time and costs one line to call.',
    how: 'save it as .claude/commands/<name>.md, with $ARGUMENTS where the part that changes goes, then type /<name>.',
  }),
  () => ({
    key: 'big-task', topic: 'A broad, open-ended task',
    why: 'an agent\'s cost is mostly reading: every step re-reads the conversation plus the files and tool output it pulled ' +
      'in. A broad prompt makes it explore, and each file it opens is paid for again at every later step.',
    how: 'name the files, the change and how to check it. Split a big job into steps you can check one at a time.',
    example: 'instead of "clean up the auth code": "In src/auth/session.ts, move token refresh into refreshToken(); ' +
      '`npm test -- auth` should pass; don\'t touch the routes."',
  }),
  (c) => {
    const x = ratio(c.from, c.to)
    const small = (c.toName ?? 'haiku').toLowerCase()
    return {
      key: 'model-down', topic: 'A small job on a big model',
      why: `${x ? `${c.fromName ?? c.from} costs about ${x} times as much per input token as ${c.toName ?? c.to}` : 'the largest models cost several times as much per token as the small ones'}. ` +
        'A lookup, a rename, a one-file fix or a format change comes out the same on the smaller model.',
      how: `match the model to the job: /model ${small} (or start the prompt with '${small}:') for lookups and mechanical edits; ` +
        'keep the big model for design, hard bugs and work across many files.',
    }
  },
  () => ({
    key: 'model-up', topic: 'A hard job on a small model',
    why: 'a small model on a hard task often needs several attempts and corrections, each re-reading the conversation. ' +
      'One good answer from a stronger model usually costs less than three weak ones.',
    how: 'for design, debugging across files or tricky reasoning, start the prompt with \'opus:\' or switch with /model; ' +
      'drop back to the smaller model for the routine steps after.',
  }),
  () => ({
    key: 'prefix-change', topic: 'Editing instruction files mid-session',
    why: 'the prompt cache keys on the start of each request: instruction files such as CLAUDE.md, settings, MCP servers ' +
      'and the skill listing. Change any of them and the next request that picks the change up writes the whole ' +
      'conversation to the cache again at 1.25 times the input price, instead of reading it at a tenth.',
    how: 'note the change you want and make it at the end of the session, or just before a /clear, when the cache is ' +
      'being rebuilt anyway.',
  }),
  () => ({
    key: 'subagent', topic: 'Sending a subagent',
    why: 'a subagent starts with an empty cache: it loads its own system prompt and tool definitions, then reads whatever ' +
      'files it needs again. Two subagents on the same job pay all of that twice, and one sent to look a single thing up ' +
      'pays it for an answer one Grep would give.',
    how: 'use a subagent for a broad search or a separate piece of work, one per job. For a single lookup, ask for the ' +
      'Read or Grep directly.',
  }),
  () => ({
    key: 'big-paste', topic: 'Pasting a big log or file into the prompt',
    why: 'a prompt stays in the conversation for the rest of the session. A pasted log is written to the cache once and ' +
      're-read at every later step, all of it, though the answer is usually in a few lines: 100,000 tokens re-read over ' +
      '30 steps is 3 million tokens.',
    how: 'name the file and what you\'re looking for, and let the agent search it. For terminal output, send it to a file ' +
      'first (`npm test > test.log 2>&1`) and point at that.',
    example: 'The worker crashes at start-up; the log is logs/worker.log. Find the first error and what led up to it.',
  }),
  () => ({
    key: 'over-budget', topic: 'Running through the budget',
    why: 'most spend comes from two habits: long conversations re-read at every step, and the biggest model doing small jobs.',
    how: '`agentarium report` shows where today\'s money went. /clear between tasks and a smaller model for routine work ' +
      'stretch the same budget furthest.',
  }),
]

/** Every lesson, or one by key (null if unknown). */
export function all(c: Context = {}): Lesson[] {
  return LESSONS.map((f) => f(c))
}

export function get(key: string, c: Context = {}): Lesson | null {
  return all(c).find((l) => l.key === key) ?? null
}

/** The full lesson as text, for a notice. */
export function text(l: Lesson): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return `Why: ${cap(l.why)}\nNext time: ${cap(l.how)}${l.example ? ` For example: ${l.example}` : ''}`
}

/** The one-line pointer once the full lesson has been seen enough. */
export const pointer = (key: string) => `(Why, and what to do next time: agentarium fishingrod ${key})`

export function mode(): 'on' | 'always' | 'off' {
  const v = (process.env.AGENTARIUM_FISHINGROD ?? '').trim().toLowerCase()
  return v === 'off' || v === 'always' ? v : 'on'
}

export function times(): number {
  const raw = (process.env.AGENTARIUM_FISHINGROD_TIMES ?? '').trim()
  const v = raw ? Number(raw) : NaN
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : 3
}

/** How often each lesson was taught in full: { key: { total, sessions: Set } }. */
export function taught(dbPath: string): Map<string, { total: number, sessions: Set<string> }> {
  const out = new Map<string, { total: number, sessions: Set<string> }>()
  try {
    withDb(dbPath, (db) => {
      if (!db.tables().has('fishingrod_events')) return
      for (const r of db.all("SELECT lesson, session_id FROM fishingrod_events WHERE action='taught'")) {
        const k = String(r.lesson)
        const e = out.get(k) ?? { total: 0, sessions: new Set<string>() }
        e.total++
        e.sessions.add(String(r.session_id))
        out.set(k, e)
      }
    }, { readOnly: true })
  } catch {
    // no database yet: nothing taught
  }
  return out
}

/** What to add to a notice about `key`: '\n' + the lesson, '\n' + a pointer, or '' (off, unknown key). Never throws. */
export function teach(dbPath: string, key: string, who: { sessionId: string, source: string }, c: Context = {}): string {
  try {
    const m = mode()
    const l = get(key, c)
    if (m === 'off' || !l) return ''
    const seen = taught(dbPath).get(key)
    const full = m === 'always' || (!seen?.sessions.has(who.sessionId) && (seen?.total ?? 0) < times())
    events.log(dbPath, 'fishingrod_events', { session_id: who.sessionId, source: who.source, lesson: key, action: full ? 'taught' : 'pointer' })
    return '\n' + (full ? text(l) : pointer(key))
  } catch {
    return ''
  }
}
