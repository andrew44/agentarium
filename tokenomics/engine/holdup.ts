/**
 * Hold-up: a prompt that pastes in what the agent could read for itself.
 *
 * A prompt stays in the conversation for the rest of the session. A 100,000-token log pasted in is
 * written to the cache once and then re-read at every later step, though the answer usually sits in
 * a few lines the agent could have found with grep. The rules here size the prompt and say what most
 * of it is, so the hook (scripts/holdup.ts) can suggest what to do instead:
 *
 *   log    timestamps, log levels or stack frames: save it to a file and say what you're after
 *   data   JSON, CSV or TSV: save it to a file; the agent reads a sample or queries it
 *   blob   base64 or hex, noise to the model: save it as a file, or attach the image itself
 *   diff   a unified diff: commit or stash it and name the branch; the agent runs git diff on what matters
 *   code   source code: give the path and the function or lines that matter
 *   doc    prose or Markdown (a spec, a report, an email thread): save it to a file and say which
 *          part or what question; the agent searches it instead of carrying all of it
 *   paste  anything else that big: give the path and say which part
 *
 * A kind wins when its lines (or runs, for a blob) make up at least 40% of the prompt's characters,
 * so a short question around a big paste is still judged by the paste.
 *
 * The other way a prompt runs up a bill is scope. "Refactor the whole codebase" or "fix all the bugs",
 * with no file, function or error named, sends the agent exploring, and every file it opens is re-read
 * at every later step. `tooBroad()` catches the blatant ones: a short prompt that sweeps the whole repo
 * (or every bug in it), names nothing to start from, sets no limit and no check that says it's done.
 * Line shapes and phrases only, no model call, nothing stored.
 */
import { rate } from './promptscore.ts'
import { ratesFor } from './pricing.ts'
import { approxTokens } from './trace.ts'

export type Kind = 'log' | 'data' | 'blob' | 'diff' | 'code' | 'doc' | 'paste'
export type Paste = { kind: Kind, tokens: number, lines: number, share: number }
export type Broad = { kind: 'broad', tokens: number, lines: number, found: string[] }

/** The share of the prompt's characters a kind needs to name it. */
const KIND_SHARE = 0.4
const BLOB_RUN = 200

// 2026-11-25T10:00:00, [10:00:00], Nov 25 10:00:00 (syslog), Nov 25, 2026 10:00:00 (java.util.logging), I1125 10:00:00 (glog), epoch seconds
const TIMESTAMP = new RegExp(String.raw`^\W{0,3}(\d{4}[-/.]\d{2}[-/.]\d{2}[T ]?\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|` +
  String.raw`[A-Z][a-z]{2} +\d{1,2},? (\d{4} )?\d{1,2}:\d{2}:\d{2}|[IWEF]\d{4} \d{2}:\d{2}:\d{2}|\d{10}(\.\d+)?\s)`)
// a level that starts the line ([ERROR] ..., INFO:root:...), or logfmt and JSON log fields; code that
// merely mentions ERROR somewhere doesn't count
const LEVEL = /^\W{0,3}(TRACE|DEBUG|INFO|NOTICE|WARN(ING)?|ERROR|FATAL|CRIT(ICAL)?|SEVERE|PANIC)\b|\b(level|lvl|severity)=\w|"(level|severity|lvl)"\s*:/
const FRAME = /^(\s+at\s+\S|\s*File ".+", line \d+|Traceback \(most recent call last\)|\s*#\d+\s+0x[0-9a-f]+|goroutine \d+ \[|Caused by: |\s*\.\.\. \d+ more$)/
const JSON_LINE = /^\s*([{}[\]]+,?|"(?:[^"\\]|\\.)*"\s*:.*|"(?:[^"\\]|\\.)*",?|-?\d[\d.eE+-]*,?|true,?|false,?|null,?)\s*$/
const BLOB = new RegExp(`[A-Za-z0-9+/=_-]{${BLOB_RUN},}`, 'g')

// a hunk header is what makes the +, - and space lines around it a diff and not a list or code
const HUNK = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m
const DIFF_LINE = /^(diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |@@ |[+\- ]|\\ No newline)/
const CODE_LINE = new RegExp(String.raw`[{};]\s*$|=>|^\s*[)\]}]|^\s*(\/\/|\/\*|#!|#include\b)|^\s+\*(\s|\/|$)|` +
  String.raw`^\s*(import|export|from|const|let|var|function|def|class|return|if|elif|else|for|while|switch|case|try|catch|except|` +
  String.raw`public|private|protected|static|async|await|package|func|fn|use|struct|interface|type|module|require|@\w+)\b.*[(=:{<]`)
// six words or more, almost all letters: a sentence. Markdown markers (#, -, 1., >, |) in front are allowed
const PROSE_LINE = /^\s*(#{1,6}|[-*+]|\d+[.)]|>|\|)?\s*[A-Za-z"'(*_`[].*$/

const isLog = (line: string) => TIMESTAMP.test(line) || FRAME.test(line) || LEVEL.test(line)
const isJson = (line: string) => JSON_LINE.test(line) || (line.length > BLOB_RUN && /^\s*[{[]/.test(line) && line.includes('":'))

/** Lines of a delimited table: the commas (or tabs) per line most lines share, when that is 2 or more,
 *  on lines with no more than two spaces a field. Prose has commas too, but long runs of words between
 *  them, and rarely the same number on line after line. */
function tableLines(lines: string[]): Set<number> {
  const counts = lines.map((l) => {
    const tabs = l.split('\t').length - 1
    const cells = tabs >= 2 ? tabs : l.split(',').length - 1
    return l.split(' ').length - 1 <= 2 * (cells + 1) ? cells : 0
  })
  const freq = new Map<number, number>()
  for (const c of counts) if (c >= 2) freq.set(c, (freq.get(c) ?? 0) + 1)
  let mode = 0
  for (const [c, n] of freq) if (n > (freq.get(mode) ?? 0)) mode = c
  return new Set(mode ? counts.flatMap((c, i) => (c === mode ? [i] : [])) : [])
}

const isProse = (line: string) => {
  if (!PROSE_LINE.test(line)) return false
  const words = line.trim().split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w))
  const letters = (line.match(/[A-Za-z\s,.'’;:!?()"-]/g) ?? []).length
  return words.length >= 6 && letters / line.length >= 0.85
}

/** How big the prompt is and what most of it is. */
export function measure(prompt: string): Paste {
  const chars = prompt.length
  const lines = prompt.split(/\r?\n/)
  const table = tableLines(lines)
  const hunks = HUNK.test(prompt)
  const size: Record<Exclude<Kind, 'paste' | 'blob'>, number> = { log: 0, data: 0, diff: 0, code: 0, doc: 0 }
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    // first match wins: a diff of code is a diff, a stack frame in a document is still a log line
    const kind = hunks && DIFF_LINE.test(line) ? 'diff'
      : isLog(line) ? 'log'
      : isJson(line) || table.has(i) ? 'data'
      : CODE_LINE.test(line) ? 'code'
      : isProse(line) ? 'doc'
      : null
    if (kind) size[kind] += line.length
  }
  let blob = 0
  for (const m of prompt.matchAll(BLOB)) if (/[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0])) blob += m[0].length
  const sizes: [Kind, number][] = [['blob', blob], ...Object.entries(size) as [Kind, number][]]
  const [kind, top] = sizes.reduce((best, s) => (s[1] > best[1] ? s : best))
  const share = chars ? top / chars : 0
  return { kind: share >= KIND_SHARE ? kind : 'paste', tokens: approxTokens(chars), lines: lines.length,
    share: Math.round(share * 100) / 100 }
}

/** The paste to speak up about, or null: under `minTokens`, empty, or a slash command. */
export function check(prompt: string, minTokens: number): Paste | null {
  if (!prompt.trim() || prompt.trimStart().startsWith('/')) return null
  if (approxTokens(prompt.length) < minTokens) return null
  return measure(prompt)
}

// the whole repo, every file in it or every bug: phrases that set no edge to the work
const SWEEP: [RegExp, string][] = [
  [/\b(?:whole|entire) (?:code ?base|repo(?:sitory)?|project|app(?:lication)?|code|system|solution)\b|\b(?:code ?base|repo|project)[- ]wide\b|\b(?:across|throughout) the (?:code ?base|repo(?:sitory)?|project|app)\b/i, 'the whole codebase'],
  [/\b(?:every|each) (?:single )?(?:file|module|component|class|page|endpoint|screen)\b|\ball (?:the |of the )?(?:files|modules|components|classes|pages|endpoints|screens|code)\b|\beverywhere\b/i, 'every file'],
  [/\b(?:all|every) (?:the |of the )?(?:bugs?|issues|problems)\b/i, 'every bug'],
  [/\b(?:fix|refactor|improve|clean ?up|tidy|optimi[sz]e|rewrite|review|audit|moderni[sz]e) everything\b/i, 'everything'],
]
const SWEEP_VERB = /\b(?:fix|review|refactor|improve|clean ?up|tidy|optimi[sz]e|rewrite|audit|document|moderni[sz]e|update|upgrade|go through|check|analy[sz]e|explain|understand|read|look (?:at|through|over)|convert|migrate|port|find|add|remove|rename|redesign|restructure|simplify)\b/i
// a check that says when it's done, or a reference back to work already shown: bounded after all
const BOUNDED = /\b(?:tests?|lint\w*|build|typecheck|tsc|ci|compiler|eslint|clippy|mypy)\b|\bthe same\b|\blike (?:you did|before|that|this)\b/i
/** Longer than this and the prompt probably carries the detail the rules can't see. */
export const BROAD_MAX_CHARS = 400

/** A short prompt that sweeps the whole repo and names nothing to start from, or null. */
export function tooBroad(prompt: string): Broad | null {
  const text = prompt.trim()
  if (!text || text.startsWith('/') || text.length > BROAD_MAX_CHARS) return null
  const found = SWEEP.filter(([re]) => re.test(text)).map(([, what]) => what)
  if (!found.length || !SWEEP_VERB.test(text) || BOUNDED.test(text)) return null
  const r = rate(text).criteria
  const target = r.find((c) => c.key === 'target')!.found
  const fenced = r.find((c) => c.key === 'scope')!.found.some((f) => !f.endsWith('(-)'))
  if (target.length || fenced) return null
  return { kind: 'broad', tokens: approxTokens(text.length), lines: text.split(/\r?\n/).length, found }
}

export type Price = { sendUsd: number, stepUsd: number, taskUsd: number, steps: number }

/** What the paste costs on a token-billed model: written to the cache with the prompt, then re-read
 *  at every later step. `steps` is how many requests a task takes in this session (1 when unknown). */
export function price(tokens: number, model: string | null | undefined, opts: { ttl1h?: boolean, steps?: number } = {}): Price {
  const r = ratesFor(model)
  const steps = Math.max(1, Math.round(opts.steps ?? 1))
  const sendUsd = tokens * (opts.ttl1h ? r.cache_write_1h : r.cache_write_5m) / 1e6
  const stepUsd = tokens * r.cache_read / 1e6
  return { sendUsd, stepUsd, taskUsd: sendUsd + stepUsd * (steps - 1), steps }
}

const WHAT: Record<Kind, string> = {
  log: 'a pasted log',
  data: 'pasted data (JSON, CSV or a table)',
  blob: 'base64 or hex, which the model reads as noise',
  diff: 'a pasted diff',
  code: 'pasted source code',
  doc: 'a pasted document',
  paste: 'pasted text',
}

const INSTEAD: Record<Kind, string> = {
  log: "Save it to a file, or give the path of the log it came from, and say what you're after: " +
    'the agent can grep it and read only the lines that matter.',
  data: 'Save it to a file and say what you need from it: the agent can read a sample, or query it with jq or a short script.',
  blob: "Save it as a file and give the path; if it's an image, attach the image itself.",
  diff: 'Commit or stash it and name the branch or commit (or the files): the agent runs git diff on just the part that matters.',
  code: "Give the path and the function or lines that matter: the agent reads just those, and the file's later changes too.",
  doc: 'Save it to a file (or give the path it came from) and say which section or question matters: ' +
    'the agent searches it and reads only those parts.',
  paste: "If it's in a file, give the path and say which part matters: the agent reads just that.",
}

const n = (v: number) => Math.round(v).toLocaleString('en-GB')

/** The notice. `money` formats USD in the display currency; leave it out where the platform isn't
 *  billed by the token (Copilot), and the cost is told in context instead of money. */
export function message(p: Paste, opts: { paused: boolean, cost?: Price | null, money?: (usd: number) => string }): string {
  const { paused, cost, money } = opts
  const size = `about ${n(p.tokens)} tokens over ${n(p.lines)} lines, mostly ${WHAT[p.kind]}`
  let carry: string
  if (cost && money) {
    const task = cost.steps > 1 ? ` (about ${money(cost.taskUsd)} over a task like your last ones, ${cost.steps} steps)` : ''
    carry = paused
      ? `Sent, all of it joins the conversation: about ${money(cost.sendUsd)} to send, then ${money(cost.stepUsd)} at every later step until you /clear${task}.`
      : `It's in the conversation now, re-read at every later step (about ${money(cost.stepUsd)} a step); /compact drops it once you have what you need.`
  } else {
    carry = paused
      ? 'Sent, all of it joins the conversation and is re-read at every later step, filling the context window.'
      : "It's in the conversation now, re-read at every later step; a new chat drops it once you have what you need."
  }
  return paused
    ? `hold-up: this prompt is ${size}. ${carry} ${INSTEAD[p.kind]} Send the prompt again to go ahead as it is.`
    : `hold-up: that prompt was ${size}. ${carry} Cheaper next time: ${INSTEAD[p.kind].charAt(0).toLowerCase()}${INSTEAD[p.kind].slice(1)}`
}

const SCOPE: Record<string, string> = {
  'the whole codebase': 'the whole codebase', 'every file': 'every file', 'every bug': 'every bug in it',
  'everything': 'everything',
}

/** The notice for a prompt that sweeps the repo. No money: what the exploring costs depends on the repo,
 *  so it says what happens instead of guessing a price. */
export function broadMessage(b: Broad, opts: { paused: boolean }): string {
  const what = b.found.map((f) => SCOPE[f] ?? f).join(' and ')
  const why = 'names no file, function or error to start from and no check that says it\'s done, so the agent explores: ' +
    'every file it opens joins the conversation and is re-read at every later step.'
  const instead = 'Name where to start and how you\'ll know it worked, or split it into steps you can check one at a time ' +
    '("in src/auth/, fix the failing login test; `npm test -- auth` should pass"). For the same change in every file, ' +
    'ask for a script that makes it.'
  return opts.paused
    ? `hold-up: this prompt asks for ${what} but ${why} ${instead} Send the prompt again to go ahead as it is.`
    : `hold-up: that prompt asked for ${what} but ${why} Cheaper next time: ${instead.charAt(0).toLowerCase()}${instead.slice(1)}`
}
