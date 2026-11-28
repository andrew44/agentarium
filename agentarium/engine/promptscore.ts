/**
 * Prompt score: how much a prompt is likely to cost to carry out, judged from its text alone.
 *
 * Five criteria, each worth up to 2 points, for a score out of 10 (one decimal place):
 *
 *   target   says where to look (a file, a function, a line, the error), so the agent reads
 *            instead of searching the repo
 *   done     says what finished looks like (a passing test, an expected result), so there is no
 *            second round to find out
 *   scope    one bounded task, not "improve everything" or five asks at once, so the agent
 *            doesn't wander into work nobody asked for
 *   lean     no tokens that carry nothing: pleasantries, repeats, a whole log or file pasted
 *            where a path or the 20 lines that matter would do
 *   output   asks for the answer it needs (a diff, a short reply) and no more effort than the job
 *            takes: output costs five times input and is never cached
 *
 * Plain rules over the text, so the same prompt always gets the same score. Shared by rate-my-prompt
 * (the script and the skill) and anything else that wants to judge a prompt before it is sent.
 */

export type CriterionKey = 'target' | 'done' | 'scope' | 'lean' | 'output'
export type Criterion = { key: CriterionKey, label: string, score: number, max: number, found: string[], tip: string | null }
export type Rating = { score: number, max: number, verdict: string, chars: number, tokens: number, criteria: Criterion[], tips: string[] }

export const MAX_PER = 2
export const LONG_PASTE = 1500      // characters in one fenced block (about 375 tokens) before it counts as a paste
export const HUGE_PROMPT = 6000     // characters (about 1,500 tokens) before the prompt itself is heavy
export const ROUTINE_CHARS = 300    // a prompt this short rarely needs "think hard"

const LABELS: Record<CriterionKey, string> = {
  target: 'Points at the code', done: 'Says what done looks like', scope: 'One bounded task',
  lean: 'No padding', output: 'Asks for lean output',
}
const TIPS: Record<CriterionKey, string> = {
  target: 'Name the file, function or error ("in `src/auth/login.ts`, `checkToken()`") so the agent reads one file instead of searching for it.',
  done: 'Say how you will know it worked ("`npm test` passes", "returns 404 for an unknown id") so it stops once, not after a second round.',
  scope: 'Ask for one thing and fence it ("only this function, leave the tests alone"). Split a list of jobs into separate prompts.',
  lean: 'Drop the pleasantries and repeats, and give a path or the lines that matter instead of pasting a whole file or log.',
  output: 'Ask for the shape you need ("reply with the diff only", "no summary") and leave out "think hard" for routine work.',
}

const TARGET_IN_FILE = 'You named the file: add the function or the error ("`checkToken()` in it", "the TypeError on line 42") ' +
  'so the agent goes straight to the lines that matter.'

const clamp = (v: number) => Math.max(0, Math.min(MAX_PER, v))
const r1 = (v: number) => Math.round(v * 10) / 10
const hits = (text: string, rules: [RegExp, string][]) => rules.filter(([re]) => re.test(text)).map(([, what]) => what)

const PATH = /(?:^|[\s`'"(])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]*\w|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|ps1|sql|md|json|ya?ml|toml|html|css|scss|vue|svelte)\b/i
const TARGET: [RegExp, string][] = [
  [PATH, 'a file path'],
  [/`[^`\n]{2,60}`|\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|\b\w+\(\)/, 'a named symbol'],
  [/\bline \d+|\blines? \d+\s*[-–]\s*\d+|:\d+\b/i, 'a line number'],
  [/\b\w*(?:Error|Exception)\b|\btraceback\b|\bstack trace\b|\bfails? with\b|\bexit code \d+/i, 'the error'],
]
const TARGET_WEIGHT = [1.2, 0.6, 0.3, 0.4]

const DONE: [RegExp, string][] = [
  [/\bso (?:that|it)\b/i, 'the purpose'],
  [/\b(?:should|must) (?:now |still |then |also |not )?(?:return|be|show|print|pass|work|fail|accept|reject|log|throw|respond|load)/i, 'the expected behaviour'],
  [/\bexpect(?:ed)?\b|\binstead\b|\bbut (?:got|it|returns?|shows?)\b/i, 'expected vs actual'],
  [/\b(?:tests?|specs?|build|lint|typecheck|ci)\b[^.\n]{0,40}\b(?:pass|passes|green|succeeds?)\b|\buntil\b[^.\n]{0,30}\bpass/i, 'a check that passes'],
  [/\bdone when\b|\bacceptance\b|\bsuccess (?:is|means)\b|\bmake sure\b|\bverify\b/i, 'a finish line'],
]

const FENCE: [RegExp, string][] = [
  [/\b(?:only|just)\b[^.\n]{0,40}\b(?:change|touch|edit|fix|update|the)\b|\bnothing else\b/i, 'a limit'],
  [/\b(?:don'?t|do not|never|without) (?:change|touch|edit|modify|refactor|rename|add)\b|\bleave [^.\n]{1,30} (?:alone|as is)\b/i, 'something to leave alone'],
]
const SPRAWL: [RegExp, string][] = [
  [/\b(?:the )?(?:whole|entire) (?:codebase|repo(?:sitory)?|project|app|code)\b|\beverywhere\b|\ball (?:the )?files\b/i, 'the whole codebase'],
  [/\b(?:improve|clean ?up|tidy|optimi[sz]e|refactor|modernise|modernize)\b(?![^.\n]{0,40}\b(?:in|of) [\w./-]+\.\w+)/i, 'an open-ended verb'],
  [/\b(?:make it|make this) (?:better|nicer|good|cleaner)\b|\bany (?:issues|problems|bugs)\b|\bfix (?:all|everything)\b|\beverything\b/i, 'no end point'],
]
const ALSO = /\b(?:and also|also|additionally|as well as|on top of that|while you'?re at it|another thing)\b/gi

const FILLER: [RegExp, string][] = [
  [/\b(?:please|kindly)\b/i, 'please'],
  [/\b(?:could|would|can) you (?:please )?(?:possibly )?\b|\bwould you mind\b|\bi was wondering\b|\bif (?:it'?s )?possible\b/i, 'a polite wind-up'],
  [/\bthanks?(?: you)?(?: (?:so much|in advance|a lot))?\b|\bcheers\b|\bmuch appreciated\b/i, 'thanks'],
  [/\b(?:hi|hello|hey)\b[ ,!]|\bi hope\b|\bbasically\b|\bi think maybe\b|\bjust wanted to\b|\bif you don'?t mind\b/i, 'small talk'],
]

const TERSE: [RegExp, string][] = [
  [/\b(?:brief(?:ly)?|concise(?:ly)?|short (?:answer|reply)|keep it short|one (?:line|sentence|word)|in (?:a few|\d+) (?:words|lines|sentences)|tl;?dr)\b/i, 'a short reply'],
  [/\b(?:diff|patch) only\b|\bonly (?:the|a) (?:diff|patch|code|answer|changed lines)\b|\bjust (?:the|a) (?:diff|patch|code|answer|fix|number|name)\b/i, 'only the part needed'],
  [/\bno (?:summary|recap|explanation|preamble|commentary)\b|\bdon'?t (?:explain|summari[sz]e|recap)\b|\bskip the (?:explanation|summary)\b/i, 'no recap'],
]
const VERBOSE: [RegExp, string][] = [
  [/\bexplain (?:in (?:great |full )?detail|everything|thoroughly|step by step)\b|\bwalk me through\b|\bin (?:great|full|as much) detail\b|\bdetailed (?:explanation|breakdown|summary)\b/i, 'a long explanation'],
  [/\b(?:the |a )?(?:full|whole|entire|complete) (?:file|listing|code|source|script)\b|\brewrite (?:the )?(?:whole|entire)\b/i, 'the whole file back'],
  [/\bsummari[sz]e (?:everything|all|what you (?:did|changed))\b|\bat the end,? (?:summari[sz]e|recap|list)\b/i, 'a recap'],
]
const EFFORT = /\b(?:ultrathink|megathink|think (?:really |very )?hard(?:er)?|think deeply|think step by step)\b/i

function target(text: string): Criterion {
  const found = TARGET.map(([re, what], i) => [re.test(text), what, TARGET_WEIGHT[i]] as const).filter(([hit]) => hit)
  // a named file already saves the search: the next saving is the place in it
  const tip = found.some(([, what]) => what === 'a file path') ? TARGET_IN_FILE : undefined
  return finish('target', 0.2 + found.reduce((s, [, , w]) => s + w, 0), found.map(([, what]) => what), tip)
}

function done(text: string): Criterion {
  const found = hits(text, DONE)
  // a plain question has its own finish line: the answer
  const question = /\?\s*$/.test(text.trim()) && text.length < 600
  const score = (question ? 1.6 : 0.2) + found.length * 0.7
  return finish('done', score, question ? ['a question to answer', ...found] : found)
}

function scope(text: string): Criterion {
  const fences = hits(text, FENCE)
  const sprawl = hits(text, SPRAWL)
  const also = (text.match(ALSO) ?? []).length
  const items = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+\S/gm) ?? []).length
  let score = 1.6 + fences.length * 0.3 - Math.min(1.2, sprawl.length * 0.5) - Math.min(0.75, also * 0.25)
  if (items > 3) score -= Math.min(0.8, (items - 3) * 0.2)
  const found = [...fences, ...sprawl.map((s) => `${s} (-)`)]
  if (also) found.push(`${also} "also" (-)`)
  if (items > 3) found.push(`${items} separate items (-)`)
  return finish('scope', score, found)
}

function lean(text: string): Criterion {
  const filler = hits(text, FILLER)
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].length)
  const pasted = blocks.filter((n) => n > LONG_PASTE).length
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20)
  const repeats = sentences.length - new Set(sentences).size
  let score = 2 - Math.min(0.8, filler.length * 0.2) - Math.min(1.2, pasted * 0.6) - Math.min(0.6, repeats * 0.3)
  if (text.length > HUGE_PROMPT) score -= text.length > HUGE_PROMPT * 3 ? 1 : 0.5
  const found = filler.map((f) => `${f} (-)`)
  if (pasted) found.push(`${pasted} long paste${pasted > 1 ? 's' : ''} (-)`)
  if (repeats) found.push(`${repeats} repeated sentence${repeats > 1 ? 's' : ''} (-)`)
  if (text.length > HUGE_PROMPT) found.push(`about ${Math.round(text.length / 4).toLocaleString('en-GB')} tokens long (-)`)
  return finish('lean', score, found)
}

function output(text: string): Criterion {
  const terse = hits(text, TERSE)
  const verbose = hits(text, VERBOSE)
  const effort = EFFORT.test(text) && text.length < ROUTINE_CHARS
  const score = 1.2 + Math.min(0.8, terse.length * 0.5) - Math.min(1, verbose.length * 0.5) - (effort ? 0.5 : 0)
  const found = [...terse, ...verbose.map((v) => `${v} (-)`)]
  if (effort) found.push('"think hard" on a short task (-)')
  return finish('output', score, found)
}

function finish(key: CriterionKey, raw: number, found: string[], tip = TIPS[key]): Criterion {
  const score = r1(clamp(raw))
  return { key, label: LABELS[key], score, max: MAX_PER, found, tip: score < 1.5 ? tip : null }
}

export function verdict(score: number): string {
  if (score >= 8.5) return 'lean: little to trim'
  if (score >= 6.5) return 'good: one or two easy savings'
  if (score >= 4.5) return 'leaky: the agent will search, guess or over-explain'
  return 'costly: expect extra turns'
}

/** Score a prompt out of 10, at most one decimal place. */
export function rate(prompt: string): Rating {
  const text = prompt.trim()
  const criteria = [target(text), done(text), scope(text), lean(text), output(text)]
  const score = r1(criteria.reduce((s, c) => s + c.score, 0))
  const tips = criteria.filter((c) => c.tip).sort((a, b) => a.score - b.score).map((c) => c.tip!)
  return { score, max: 5 * MAX_PER, verdict: verdict(score), chars: text.length, tokens: Math.ceil(text.length / 4), criteria, tips }
}
