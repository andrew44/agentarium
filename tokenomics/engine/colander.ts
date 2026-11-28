/**
 * colander: drain the noise out of what a command printed, and keep what matters.
 *
 * Platform-independent. A test run, build, lint or install that succeeds prints mostly lines nobody reads:
 * one per passing test, progress bars, download and compile chatter, the same warning forty times. Each of
 * them sits in the context and is paid for again at every later step. strain() keeps the first lines, the
 * last lines (where the summary is), every warning and anything that failed, and counts the rest. The hook
 * saves the full output to a file before it strains, and the footer says where, so the agent can grep it
 * instead of running the command again.
 *
 * program() decides which commands are worth straining: test runners, builds, type checkers, linters and
 * package installs, plus any you name. A command the agent already piped through a filter is left alone,
 * and so is one carrying `# colander-off`.
 */
import { basename } from 'node:path'

import { fmt } from '../util.ts'
import { shlexSplit } from './shlex.ts'

export const BYPASS = '# colander-off'
/** Output under this many characters (about 1,000 tokens) is never strained. */
export const MIN_CHARS = 4_000
/** Lines shown at most, before failures (which get room of their own). */
export const MAX_LINES = 60
/** A strain must leave out at least this share of the output, and this many characters, or it isn't worth it. */
const MIN_SHARE = 0.3
const MIN_SAVED = 1_000
/** Lines kept after a failure: the assertion, the diff and the first stack frames. */
const FAILURE_CONTEXT = 20
/** At most this many lines between passing tests count as a heading (describe, then nested describe). */
const HEADINGS = 3

const ALL = '*'
type Subs = string[] | typeof ALL

/** Programs whose output is mostly noise when they succeed, and the subcommands that count ('*': any).
 *  A two-word entry ('compose build') matches the first two words after the program. */
const NOISY: Record<string, Subs> = {
  // JavaScript and TypeScript
  jest: ALL, vitest: ALL, mocha: ALL, ava: ALL, tap: ALL, karma: ALL, jasmine: ALL, c8: ALL, nyc: ALL,
  playwright: ['test'], cypress: ['run'], tsc: ALL, 'vue-tsc': ALL, 'svelte-check': ALL, eslint: ALL, biome: ALL,
  stylelint: ALL, prettier: ALL, webpack: ALL, rollup: ALL, parcel: ['build'], vite: ['build'], next: ['build', 'lint'],
  nuxt: ['build'], nuxi: ['build'], astro: ['build', 'check'], ng: ['test', 'build', 'lint'], 'react-scripts': ['test', 'build'],
  turbo: ALL, nx: ALL, lerna: ALL,
  // Python
  pytest: ALL, 'py.test': ALL, unittest: ALL, nose2: ALL, tox: ALL, nox: ALL, mypy: ALL, pyright: ALL, ruff: ALL,
  flake8: ALL, pylint: ALL, pip: ['install', 'download', 'wheel'], pip3: ['install', 'download', 'wheel'],
  uv: ['sync', 'pip install', 'add', 'lock'], poetry: ['install', 'add', 'update', 'lock'], pipenv: ['install', 'sync'],
  hatch: ['test', 'build'], conda: ['install', 'create', 'update'], mamba: ['install', 'create', 'update'],
  micromamba: ['install', 'create', 'update'],
  // compiled languages and their build tools
  go: ['test', 'build', 'vet', 'install', 'generate', 'mod download', 'mod tidy', 'get'], 'golangci-lint': ALL,
  cargo: ['test', 'build', 'check', 'clippy', 'nextest', 'bench', 'doc', 'install', 'fetch', 'update'],
  make: ALL, cmake: ALL, ctest: ALL, ninja: ALL, meson: ['compile', 'test', 'setup'], configure: ALL,
  bazel: ['build', 'test'], bazelisk: ['build', 'test'], mvn: ALL, mvnw: ALL, gradle: ALL, gradlew: ALL, sbt: ALL, ant: ALL,
  lein: ['test', 'uberjar', 'deps'], dotnet: ['test', 'build', 'restore', 'publish', 'pack'], msbuild: ALL, xcodebuild: ALL,
  swift: ['build', 'test'], zig: ['build'], dune: ['build', 'test', 'runtest'], stack: ['build', 'test', 'install'],
  cabal: ['build', 'test', 'install'], mix: ['test', 'compile', 'deps.get', 'deps.compile'], rebar3: ['compile', 'eunit', 'ct'],
  flutter: ['test', 'build', 'pub get'], dart: ['test', 'pub get'], deno: ['test', 'check', 'lint'],
  // Ruby and PHP
  rspec: ALL, rake: ALL, rails: ['test'], bundle: ['install', 'update'], gem: ['install'], phpunit: ALL, pest: ALL,
  composer: ['install', 'update', 'require'],
  // containers and systems
  docker: ['build', 'pull', 'push', 'buildx build', 'compose build', 'compose pull'], podman: ['build', 'pull', 'push'],
  terraform: ['init'], brew: ['install', 'upgrade', 'update'], 'apt-get': ['install', 'update', 'upgrade'],
  apt: ['install', 'update', 'upgrade'],
}
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PKG_SUBS = new Set(['test', 't', 'tst', 'install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'rebuild', 'dedupe', 'prune'])
/** A package.json script worth straining, by its name (`npm run build`, `pnpm lint`). */
const SCRIPT_RE = /test|spec|build|lint|check|types?\b|tsc|e2e|ci\b|compile|coverage|verify|bundle/i
/** Programs that run another program: look at that one instead. */
const WRAPPERS: Record<string, Subs> = {
  npx: ALL, bunx: ALL, pnpx: ALL, uvx: ALL, npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'],
  uv: ['run'], poetry: ['run'], pipenv: ['run'], hatch: ['run'], pdm: ['run'], rye: ['run'], bundle: ['exec'],
}
/** Flags whose value is the next word, so it isn't taken for the subcommand (`pnpm --filter web test`). */
const FLAG_VALUE = new Set(['--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--project', '-P'])
const SEGMENTS = /&&|\|\||;|\n/

function words(segment: string): string[] | null {
  try {
    return shlexSplit(segment)
  } catch {
    return null
  }
}

/** The positional words after the program, flags (and their values) skipped. */
function positionals(ws: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i]
    if (w === '--') continue
    if (w.startsWith('-') || w.startsWith('+')) {
      if (FLAG_VALUE.has(w)) i++
      continue
    }
    out.push(w)
  }
  return out
}

const programName = (w: string) => basename(w).replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase()

function subsMatch(subs: Subs, pos: string[]): boolean {
  if (subs === ALL) return true
  const one = pos[0] ?? ''
  const two = pos.slice(0, 2).join(' ')
  return subs.includes(one) || subs.includes(two)
}

function match(input: string[], extra: Set<string>, depth: number): string | null {
  let ws = input
  while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) ws = ws.slice(1)          // FOO=1 cmd ...
  while (ws.length && ['sudo', 'time', 'nice', 'command', 'env'].includes(ws[0])) ws = ws.slice(1)
  if (!ws.length || depth > 3) return null
  const cmd = programName(ws[0])
  if (extra.has(cmd) || extra.has(basename(ws[0]))) return cmd
  const pos = positionals(ws)
  if (/^python[\d.]*$|^py$/.test(cmd)) {                                               // python -m pytest
    const i = ws.indexOf('-m')
    return i > 0 && i + 1 < ws.length ? match(ws.slice(i + 1), extra, depth + 1) : null
  }
  if (cmd === 'node' && ws.includes('--test')) return cmd
  const wrap = Object.hasOwn(WRAPPERS, cmd) ? WRAPPERS[cmd] : undefined
  if (wrap && (wrap === ALL || wrap.includes(pos[0] ?? ''))) {
    const start = wrap === ALL ? 1 : ws.indexOf(pos[0]) + 1
    let rest = ws.slice(start)
    while (rest.length && rest[0].startsWith('-')) rest = rest.slice(FLAG_VALUE.has(rest[0]) ? 2 : 1)
    const inner = match(rest, extra, depth + 1)
    if (inner || wrap === ALL) return inner
  }
  if (PKG_MANAGERS.has(cmd)) {
    let [sub = '', next = ''] = pos
    if (cmd === 'yarn' && sub === 'workspace') [sub, next] = [pos[2] ?? '', pos[3] ?? '']
    if (cmd === 'yarn' && !sub) return cmd                                               // bare `yarn` installs
    if (PKG_SUBS.has(sub)) return cmd
    if (sub === 'run' || sub === 'run-script') return SCRIPT_RE.test(next) ? cmd : null
    return cmd !== 'npm' && SCRIPT_RE.test(sub) ? cmd : null                             // `pnpm lint`, `yarn build`
  }
  const subs = Object.hasOwn(NOISY, cmd) ? NOISY[cmd] : undefined
  return subs && subsMatch(subs, pos) ? cmd : null
}

/** The program a command runs that colander strains (`npm`, `pytest`, `cargo` ...), or null. Only the
 *  program's name is ever kept. `extra` names more programs to strain (TOKENOMICS_COLANDER_COMMANDS). */
export function program(command: string, extra: Iterable<string> = []): string | null {
  if (!command || command.includes(BYPASS)) return null
  const more = new Set([...extra].map((x) => x.trim()).filter(Boolean).flatMap((x) => [x, basename(x), programName(x)]))
  let found: string | null = null
  for (const raw of command.split(SEGMENTS)) {
    const seg = raw.trim()
    if (!seg || seg.startsWith('#')) continue
    if (seg.includes('|')) return null                     // the agent already chose what to see
    const ws = words(seg)
    if (!ws) continue
    found ??= match(ws, more, 0)
  }
  return found
}

// ---- straining -------------------------------------------------------------------------------

type Kind = 'keep' | 'pass' | 'noise' | 'plain' | 'blank'
type Why = 'pass' | 'noise' | 'repeat' | 'elided'

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Colours and cursor codes out; a line a progress bar redrew (with \r) keeps only what it showed last. */
export function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map((line) => {
    let l = line
    if (l.includes('\r')) l = l.split('\r').filter((p) => p.trim()).at(-1) ?? ''
    if (l.includes('\b')) l = l.replace(/[^\b]\b/g, '')
    return l.trimEnd()
  }).join('\n')
}

const PASS = [
  /^\s*(?:[✓✔√☑✅]|\(pass\))\s+\S/i,           // jest, vitest, mocha, node --test (spec reporter)
  /^\s*PASS\s+\S/,                               // jest: one line per passing file
  /^\s*ok \d+\b/,                                // TAP: node --test, tap, ava
  /^\s*--- PASS: /,                              // go test -v
  /^test \S.* \.\.\. ok$/,                       // cargo test
  /\sPASSED(?:\s+\[\s*\d+%\])?$/,                // pytest -v, gradle
  /^\s*Passed\s+\S/,                             // dotnet test
  /^\S+\.py\s+[.sx]+\s*(?:\[\s*\d+%\])?$/,       // pytest: a file and its dots (an F or an E is kept)
  /^[.*]{4,}$/,                                  // rspec, minitest
]
const NOISE = [
  /^\s*# Subtest: /, /^\s*\d+\.\.\d+$/,                                        // TAP structure
  /^\s*▶ /,                                                                    // node --test: a suite starting
  /^\s*=== (?:RUN|PAUSE|CONT|NAME)\s/,                                         // go test -v
  /^\s*(?:Compiling|Checking|Documenting|Fresh|Updating|Locking|Adding|Blocking|Downloaded|Downloading|Unpacking|Packaging|Verifying|Archiving|Installing|Installed|Replacing|Removing)\s+\S+ v?\d/,  // cargo
  /^\s*(?:Collecting|Downloading|Using cached|Requirement already satisfied|Obtaining|Preparing metadata|Building wheel|Created wheel|Stored in directory|Getting requirements|Installing build dependencies|Looking in indexes|Attempting uninstall|Found existing installation|Uninstalling)\b/,  // pip
  /^npm (?:http|timing|sill|silly|verb|info)\b/, /^Progress: resolved \d+/, /^[+-]{8,}$/, /^\[\d+\/\d+\] /, /^➤ YN0000: [│┌└]/,  // npm, pnpm, yarn
  /^> Task \S+(?: (?:UP-TO-DATE|NO-SOURCE|FROM-CACHE|SKIPPED))?$/,                // gradle
  /^\[INFO\] (?:Download(?:ing|ed) from|Progress|Copying|Using '|skip non existing|Nothing to compile|No sources to compile|Building jar|Changes detected|Compiling \d+ source|Installing \S+ to)/,  // maven
  /^go: (?:downloading|finding|extracting) /,
  /^#\d+ (?:sha256:|extracting|\[internal\]|transferring|resolve |DONE \d|CACHED|naming to|writing image|exporting|load (?:build|metadata|\.dockerignore))/,  // docker buildkit
  /^\S+: (?:Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists|Downloading|Extracting)/,  // docker pull
  /^\s*(?:Receiving|Resolving|Counting|Compressing|Enumerating|Writing) (?:objects|deltas):/,
  /^\s*[[(|]?[#=>\-.█▓▒░■□⣿ ]{6,}[\])|]?\s*\d{1,3}(?:\.\d+)?\s?%/, /\d{1,3}(?:\.\d+)?%\s*[|[][#=>\-█▓▒░ ]{4,}[|\]]/,  // progress bars
  /^[\s⠁-⣿|/\\.-]*[⠁-⣿][\s⠁-⣿|/\\.-]*$/,                                       // a spinner frame
  /^\s*\d{1,3}(?:\.\d+)?\s?%$/,
]
/** The YAML block TAP prints under a passing test. */
const TAP_YAML = /^\s*(?:---|\.\.\.|duration_ms: [\d.]+|type: '(?:test|suite)')$/
const KEEP_WORDS = /\b(?:errors?|err!|fail(?:s|ed|ing|ures?)?|fatal|panic(?:ked)?|exception|traceback|warn(?:ings?)?|deprecat\w*|vulnerabilit\w*|skip(?:ped)?|todo|pending|flaky|cannot|can't|couldn't|unable|not found|no such|denied|refused|abort\w*|timed? ?out|segmentation|unresolved|conflict)\b/i
const KEEP_MARK = /^\s*(?:[✗✕×✖❌⚠●!]|not ok\b|FAIL\b|E\s{2,}|>\s{3,}|ℹ\s|at\s+\S.*[:(]\d+|Caused by|-->\s)/
const SUMMARY = /^\s*(?:Tests?:|Test Suites:|Test Files|Suites?:|Snapshots:|Time:|Duration|Ran \d|# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|Test run|Total|Summary|Coverage|BUILD\b|Finished\b|Done\b|Compiled\b|Built\b|added \d|removed \d|changed \d|up to date|audited \d|found \d|Successfully\b|ok\s+\S+\s+[\d.]+s|PASS$|=+ .+ =+$)|\b\d+ (?:passed|failed|passing|failing|pending|skipped|tests?|errors?|warnings?|suites?|todo|cancelled|examples?|assertions?)\b/i
/** A line that opens a failure: what follows it is kept too. */
const FAILURE = /^\s*(?:[✗✕×✖❌●]|not ok\b|FAIL\b|--- FAIL|FAILED\b|E\s{2,}|Traceback|thread '.*' panicked|panic:|error(?:\[\w+\])?:|\w*Error:|AssertionError)/

function kindOf(line: string): Kind {
  if (!line.trim()) return 'blank'
  if (/#\s*(?:SKIP|TODO)\b/i.test(line)) return 'keep'              // TAP: `ok 13 - later # SKIP` didn't run
  if (PASS.some((r) => r.test(line))) return 'pass'
  if (NOISE.some((r) => r.test(line))) return 'noise'
  if (KEEP_MARK.test(line) || KEEP_WORDS.test(line) || SUMMARY.test(line)) return 'keep'
  return 'plain'
}

/** Lines that say the same thing: numbers aside, or warnings that start the same way. */
function family(line: string): string {
  const flat = line.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ')
  return /warn|deprecat/i.test(flat) ? flat.split(' ').slice(0, 3).join(' ') : flat
}

export type Strained = {
  text: string
  rawChars: number           // of the cleaned output
  keptChars: number          // of the text above
  rawLines: number
  keptLines: number          // real lines shown (markers not counted)
  passing: number            // passing-test lines left out
  noise: number              // progress, download, compile and test-runner lines left out
  repeats: number            // lines that said the same as the one before
  elided: number             // ordinary lines left out of a long middle
  failures: number           // lines that opened a failure (all kept)
}

const MARK: Record<Why, [string, string]> = {
  pass: ['passing-test line', 'passing-test lines'], noise: ['progress line', 'progress lines'],
  repeat: ['more like the line above', 'more like the line above'], elided: ['more line', 'more lines'],
}

function marker(counts: Record<Why, number>): string {
  const n = counts.pass + counts.noise + counts.repeat + counts.elided
  const only = (Object.keys(counts) as Why[]).filter((k) => counts[k])
  const label = only.length === 1 ? MARK[only[0]][n === 1 ? 0 : 1] : n === 1 ? 'line left out' : 'lines left out'
  return `… ${fmt(n)} ${label} …`
}

/** What colander would show of `raw`: at most `maxLines` lines, plus every failure and its context. */
export function strain(raw: string, maxLines = MAX_LINES): Strained {
  const text = clean(raw)
  const lines = text ? text.split('\n') : []
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const kinds = lines.map(kindOf)
  const why: (Why | null)[] = lines.map(() => null)

  // passing tests and noise go, with the YAML TAP prints under each passing test
  let failures = 0
  let context = 0
  for (let i = 0; i < lines.length; i++) {
    if (FAILURE.test(lines[i])) {
      failures++
      context = FAILURE_CONTEXT
      kinds[i] = 'keep'
      continue
    }
    if (context > 0 && (kinds[i] === 'plain' || kinds[i] === 'keep')) {
      kinds[i] = 'keep'
      context--
      continue
    }
    if (kinds[i] === 'pass' || kinds[i] === 'noise') {
      why[i] = kinds[i] as Why
      if (kinds[i] === 'pass' && /^\s*ok \d+/.test(lines[i])) {
        while (i + 1 < lines.length && TAP_YAML.test(lines[i + 1])) why[++i] = 'noise'
      }
    }
  }
  // a heading between passing tests (a describe block's name) goes with them
  for (let i = 1; i < lines.length; i++) {
    if (why[i] || kinds[i] === 'keep' || why[i - 1] !== 'pass') continue
    let j = i
    while (j < lines.length && !why[j] && kinds[j] !== 'keep') j++
    if (j < lines.length && why[j] === 'pass' && lines.slice(i, j).filter((l) => l.trim()).length <= HEADINGS) {
      for (let k = i; k < j; k++) why[k] = 'noise'
    }
    i = j
  }
  // a blank line next to a gap goes with it; so does a run of the same line past its second
  let prev = -1
  let runKey = ''
  let run = 0
  for (let i = 0; i < lines.length; i++) {
    if (why[i]) continue
    if (kinds[i] === 'blank') {
      const prevHidden = i > 0 && why[i - 1] !== null
      if (prevHidden || (prev >= 0 && kinds[prev] === 'blank')) why[i] = 'noise'
      else prev = i
      continue
    }
    const key = family(lines[i])
    run = key === runKey ? run + 1 : 1
    runKey = key
    if (run > (kinds[i] === 'keep' ? 3 : 2)) why[i] = 'repeat'
    prev = i
  }
  // the first line says what ran and the last is usually the verdict (`✓ built in 12s`): never left out
  const solid = lines.flatMap((l, i) => (l.trim() ? [i] : []))
  for (const i of [...solid.slice(0, 1), ...solid.slice(-1)]) {
    why[i] = null
    kinds[i] = 'keep'
  }

  // too long still: keep the head, the tail and what matters in the middle
  const shown = lines.flatMap((_, i) => (why[i] ? [] : [i]))
  if (shown.length > maxLines) {
    const head = Math.max(3, Math.round(maxLines * 0.15))
    const tail = Math.round(maxLines * 0.5)
    let budget = failures ? maxLines * 2 : maxLines - head - tail
    for (const i of shown.slice(head, shown.length - tail)) {
      if (kinds[i] === 'keep' && budget > 0) budget--
      else why[i] = 'elided'
    }
  }

  const out: string[] = []
  const counts: Record<Why, number> = { pass: 0, noise: 0, repeat: 0, elided: 0 }
  const total: Record<Why, number> = { pass: 0, noise: 0, repeat: 0, elided: 0 }
  let gap = 0
  let kept = 0
  const flush = () => {
    if (!gap) return
    if (counts.pass + counts.noise + counts.repeat + counts.elided) out.push(marker(counts))   // blank lines alone need no marker
    for (const k of Object.keys(counts) as Why[]) {
      total[k] += counts[k]
      counts[k] = 0
    }
    gap = 0
  }
  for (let i = 0; i < lines.length; i++) {
    const w = why[i]
    if (w) {
      if (kinds[i] !== 'blank') counts[w]++
      gap++
      continue
    }
    flush()
    out.push(lines[i])
    kept++
  }
  flush()
  const result = out.join('\n')
  return { text: result, rawChars: text.length, keptChars: result.length, rawLines: lines.length, keptLines: kept,
    passing: total.pass, noise: total.noise, repeats: total.repeat, elided: total.elided, failures }
}

/** Worth showing the strained text instead of the output? Only when it leaves out a real share of it. */
export function worth(rawChars: number, keptChars: number): boolean {
  const saved = rawChars - keptChars
  return rawChars >= MIN_CHARS && saved >= MIN_SAVED && saved >= rawChars * MIN_SHARE
}

const approxTokens = (chars: number) => Math.ceil(chars / 4)

type Counts = Pick<Strained, 'rawChars' | 'keptChars' | 'rawLines' | 'keptLines' | 'passing' | 'noise' | 'repeats' | 'elided'>

/** "showed 19 of 2,824 lines (about 106 of 19,574 tokens), leaving out ..." */
export function summary(s: Counts): string {
  const parts: string[] = []
  if (s.passing) parts.push(`${fmt(s.passing)} lines of passing tests`)
  if (s.noise) parts.push(`${fmt(s.noise)} of progress and runner output`)
  if (s.repeats + s.elided) parts.push(`${fmt(s.repeats + s.elided)} others`)
  const left = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? 'nothing'
  return `showed ${fmt(s.keptLines)} of ${fmt(s.rawLines)} lines (about ${fmt(approxTokens(s.keptChars))} of ` +
    `${fmt(approxTokens(s.rawChars))} tokens), leaving out ${left}`
}

/** The note under the strained text, for the model: what was left out, and where the rest is. */
export function footer(s: Counts, logPath: string | null): string {
  const where = logPath
    ? `The full output is in ${logPath}: grep it or read part of it rather than running the command again.`
    : `The full output wasn't saved: if you need it, run the command again with \`${BYPASS}\` at the end.`
  return `[colander: ${summary(s)}. ${where}]`
}
