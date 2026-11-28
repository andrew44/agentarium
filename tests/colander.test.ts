/** colander: which commands it strains, what it keeps of their output, and the hook on each platform. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, writeTranscript, type TempEnv } from './helpers.ts'

import * as hook from '../scripts/colander.ts'
import * as colander from '../agentarium/engine/colander.ts'
import { Db } from '../agentarium/engine/db.ts'
import { ratesFor } from '../agentarium/engine/pricing.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'
import { PolicyEngine } from '../agentarium/services/index.ts'

const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n')

/** node --test's TAP output: a suite of passing tests, each with the YAML block TAP prints under it. */
function tap(tests: number, extra = ''): string {
  return 'TAP version 13\n# Subtest: billing\n' + rep(tests, (i) =>
    `    # Subtest: case ${i} handles the error path\n    ok ${i + 1} - case ${i} handles the error path\n` +
    `      ---\n      duration_ms: 0.61${i}\n      type: 'test'\n      ...`) +
    `\n    1..${tests}\n${extra}ok 1 - billing\n  ---\n  duration_ms: 12.5\n  type: 'suite'\n  ...\n1..1\n` +
    `# tests ${tests}\n# suites 1\n# pass ${tests}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 98.4\n`
}

const FAILED = `    # Subtest: adds totals
    not ok 41 - adds totals
      ---
      duration_ms: 1.41
      type: 'test'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly deep-equal:
        + actual - expected
          {
        +   b: 2
        -   b: 3
          }
      code: 'ERR_ASSERTION'
      stack: |-
        TestContext.<anonymous> (file:///app/totals.test.mjs:5:49)
      ...
    # Subtest: later
    ok 42 - later # SKIP
`

describe('colander: which commands it strains', () => {
  test('test runners, builds, linters and installs, by program name only', () => {
    const cases: [string, string | null][] = [
      ['npm test', 'npm'], ['npm run build', 'npm'], ['npm run dev', null], ['npm ci', 'npm'], ['pnpm --filter web test', 'pnpm'],
      ['yarn', 'yarn'], ['yarn build', 'yarn'], ['yarn workspace web test', 'yarn'], ['bun test', 'bun'],
      ['npx jest --ci', 'jest'], ['npx create-react-app x', null], ['python3 -m pytest -q', 'pytest'], ['uv run pytest -x', 'pytest'],
      ['uv sync', 'uv'], ['pip install -r requirements.txt', 'pip'], ['cargo test', 'cargo'], ['cargo run', null],
      ['cargo +nightly build', 'cargo'], ['go test ./...', 'go'], ['go run .', null], ['./gradlew build', 'gradlew'],
      ['mvn -q verify', 'mvn'], ['docker compose build', 'docker'], ['docker compose logs api', null], ['node --test', 'node'],
      ['FOO=1 sudo make', 'make'], ['cd web && npm ci && npm test', 'npm'], ['bundle exec rspec', 'rspec'], ['dotnet test', 'dotnet'],
    ]
    for (const [cmd, want] of cases) assert.equal(colander.program(cmd), want, cmd)
  })

  test('content the agent asked for, filtered output and the bypass are left alone', () => {
    for (const cmd of ['cat build.log', 'git diff', 'grep -rn TODO src', 'npm test 2>&1 | tail -40', 'npm test | grep FAIL',
      `npm test ${colander.BYPASS}`, '', 'kubectl logs api']) {
      assert.equal(colander.program(cmd), null, cmd)
    }
  })

  test('more programs can be named', () => {
    assert.equal(colander.program('./scripts/ci.sh --all'), null)
    assert.equal(colander.program('./scripts/ci.sh --all', ['ci.sh']), 'ci.sh')
    assert.equal(colander.program('just check', ['just']), 'just')
  })
})

describe('colander: what it keeps', () => {
  test('a passing TAP run comes down to its summary', () => {
    const s = colander.strain(tap(400))
    assert.ok(s.rawChars > 40_000 && s.keptChars < 600, `${s.rawChars} -> ${s.keptChars}`)
    assert.match(s.text, /^TAP version 13\n… [\d,]+ lines left out …\n# tests 400\n/)
    assert.match(s.text, /# fail 0[\s\S]*# duration_ms 98\.4$/)
    assert.ok(!s.text.includes('duration_ms: 0.6'))
    assert.equal(s.passing, 401)
    assert.ok(colander.worth(s.rawChars, s.keptChars))
  })

  test('a failure keeps its error, diff and stack; a skipped test stays in sight', () => {
    const s = colander.strain(tap(120, FAILED))
    for (const want of ['not ok 41 - adds totals', 'Expected values to be strictly deep-equal', '+   b: 2', '-   b: 3',
      "code: 'ERR_ASSERTION'", 'totals.test.mjs:5:49', 'ok 42 - later # SKIP', '# tests 120']) {
      assert.ok(s.text.includes(want), want)
    }
    assert.ok(s.failures >= 1)
    assert.ok(!s.text.includes('case 7 handles'))
  })

  test('the spec reporter, jest and mocha: passes and the describe headings between them go', () => {
    const spec = `▶ totals\n${rep(60, (i) => `  ✔ adds row ${i} (0.${i}ms)`)}\n  ✖ adds totals (1.2ms)\n` +
      '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n    3 !== 4\n\n' +
      '        at TestContext.<anonymous> (file:///app/totals.test.mjs:9:12)\n✖ totals (3.1ms)\nℹ tests 61\nℹ pass 60\nℹ fail 1\n'
    const s = colander.strain(spec)
    assert.ok(s.text.includes('3 !== 4') && s.text.includes('totals.test.mjs:9:12') && s.text.includes('ℹ fail 1'))
    assert.ok(!s.text.includes('adds row 7'))
    const jest = rep(20, (f) => ` PASS  src/f${f}.test.ts\n  Feature ${f}\n    Nested ${f}\n` + rep(10, (i) => `      ✓ case ${i} (${i} ms)`)) +
      '\n\nTest Suites: 20 passed, 20 total\nTests:       200 passed, 200 total\nTime:        9.1 s\n'
    const j = colander.strain(jest)
    assert.ok(!/Feature 3|Nested 3/.test(j.text), j.text)
    assert.match(j.text, /Tests: {7}200 passed, 200 total/)
  })

  test('pytest, cargo and go: the warnings and the verdict stay, the chatter goes', () => {
    const pytest = '=== test session starts ===\ncollected 200 items\n\n' +
      rep(200, (i) => `tests/test_m.py::test_${i} PASSED${' '.repeat(30)}[ ${i % 100}%]`) +
      '\n\n=== warnings summary ===\n  /app/m.py:41: DeprecationWarning: datetime.utcnow() is deprecated\n=== 200 passed, 1 warning in 8.31s ===\n'
    const p = colander.strain(pytest)
    assert.ok(p.text.includes('DeprecationWarning') && p.text.includes('200 passed, 1 warning'))
    assert.equal(p.passing, 200)
    const cargo = rep(150, (i) => `   Compiling crate${i} v0.${i}.3`) + '\nwarning: unused variable: `x`\n --> src/lib.rs:10:9\n' +
      '    Finished `test` profile [unoptimized] target(s) in 41.20s\n\nrunning 90 tests\n' + rep(90, (i) => `test tests::case_${i} ... ok`) +
      '\n\ntest result: ok. 90 passed; 0 failed; 0 ignored; finished in 0.31s\n'
    const c = colander.strain(cargo)
    assert.ok(c.text.includes('unused variable') && c.text.includes('src/lib.rs:10:9') && c.text.includes('test result: ok. 90 passed'))
    assert.deepEqual([c.noise, c.passing], [149, 90])                 // the first line always shows
    const go = rep(100, (i) => `=== RUN   TestThing${i}\n--- PASS: TestThing${i} (0.00s)`) + '\nPASS\nok  \tgithub.com/acme/app\t0.412s\n'
    assert.match(colander.strain(go).text, /PASS\nok {2}\tgithub.com\/acme\/app\t0\.412s$/)
  })

  test('the same warning forty times shows three times and a count; the last lines always stay', () => {
    const npm = rep(40, (i) => `npm warn deprecated pkg${i}@1.0.${i}: This package is no longer supported.`) +
      '\n\nadded 1312 packages in 41s\n6 vulnerabilities (2 moderate, 4 high)\n'
    const s = colander.strain(npm)
    assert.equal(s.text.split('\n').filter((l) => l.startsWith('npm warn deprecated')).length, 3)
    assert.match(s.text, /… 37 more like the line above …/)
    assert.match(s.text, /6 vulnerabilities/)
    const vite = rep(100, (i) => `dist/assets/chunk-${i}.js   ${i}.1 kB`) + '\n✓ built in 12.41s\n'
    assert.match(colander.strain(vite).text, /✓ built in 12\.41s$/)
  })

  test('a long middle is cut to the head, the tail and what matters', () => {
    const log = rep(500, (i) => `step ${i}: ${['resolve', 'emit', 'hash', 'link'][i % 4]} module ${i * 7919 % 1000}`)
      .replace('step 249: emit', 'step 249: error: could not emit')
    const s = colander.strain(log, 40)
    assert.ok(s.keptLines <= 40, String(s.keptLines))
    assert.ok(s.text.includes('step 249: error: could not emit'))
    assert.ok(s.text.startsWith('step 0:') && s.text.endsWith(log.split('\n').at(-1)!))
    assert.ok(s.elided > 400)
  })

  test('colours, redrawn progress bars and tiny outputs', () => {
    assert.equal(colander.clean('\x1b[32m✓ ok\x1b[0m\r\nDownloading 10%\rDownloading 100%\n'), '✓ ok\nDownloading 100%\n')
    const s = colander.strain('hello\nworld\n')
    assert.equal(s.text, 'hello\nworld')
    assert.ok(!colander.worth(s.rawChars, s.keptChars))
    assert.equal(colander.strain('').rawLines, 0)
  })

  test('the footer says what was left out and where the rest is', () => {
    const s = colander.strain(tap(100))
    assert.match(colander.footer(s, '/tmp/x.log'), /^\[colander: showed \d+ of [\d,]+ lines \(about \d+ of [\d,]+ tokens\), leaving out 101 lines of passing tests and [\d,]+ of progress and runner output\. The full output is in \/tmp\/x\.log: grep it/)
    assert.ok(colander.footer(s, null).includes(colander.BYPASS))
  })
})

describe('colander: adapters', () => {
  const out = { stdout: 'short', stderr: '' }

  test('Claude Code: Bash output in, the same shape back with every other field kept', () => {
    const cc = getAdapter('claude-code')
    const r = { stdout: 'a', stderr: 'b', interrupted: false, isImage: false, bashEditDiff: null }
    assert.deepEqual(cc.toolOutput({ tool_response: r }), { stdout: 'a', stderr: 'b' })
    assert.equal(cc.toolOutput({ tool_response: 'Exit code 1\nboom' }), null)
    assert.equal(cc.toolOutput({ tool_response: { ...r, isImage: true } }), null)
    assert.deepEqual(cc.replaceOutput({ tool_response: r }, out),
      { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...r, stdout: 'short', stderr: '' } } })
  })

  test('Copilot CLI: a successful result is replaced through modifiedResult; VS Code cannot replace one', () => {
    const cp = getAdapter('copilot')
    assert.deepEqual(cp.toolOutput({ toolResult: { resultType: 'success', textResultForLlm: 'x' } }), { stdout: 'x', stderr: '' })
    assert.equal(cp.toolOutput({ toolResult: { resultType: 'failure', textResultForLlm: 'x' } }), null)
    assert.deepEqual(cp.toolOutput({ tool_result: { result_type: 'success', text_result_for_llm: 'y' } }), { stdout: 'y', stderr: '' })
    assert.deepEqual(cp.replaceOutput({ toolResult: { resultType: 'success', textResultForLlm: 'long' } }, out),
      { modifiedResult: { resultType: 'success', textResultForLlm: 'short' } })
    assert.equal(getAdapter('vscode').replaceOutput({ tool_response: { stdout: 'a' } }, out), null)
  })
})

describe('colander: the hook', () => {
  const claude = (command: string, stdout: string, extra: object = {}) =>
    ({ session_id: 's1', hook_event_name: 'PostToolUse', cwd: '/app', tool_name: 'Bash', tool_input: { command },
      tool_response: { stdout, stderr: '', interrupted: false, isImage: false }, ...extra })

  function run(t: TempEnv, source: string, payload: object, env = {}) {
    const p = runScript('colander.ts', [source], { input: JSON.stringify(payload), env: t.env(env) })
    assert.equal(p.status, 0, p.stderr)
    assert.equal(p.stderr, '')
    return p.stdout.trim() ? JSON.parse(p.stdout) : null
  }
  const events = (t: TempEnv) => (existsSync(t.db) ? t.rows('SELECT * FROM colander_events') : [])

  test('Claude Code: a passing test run is strained, saved in full for the agent, and priced', (c) => {
    const t = useTemp(c)
    const transcript = writeTranscript(t.home, 's1', [{ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [],
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 500, cache_read_input_tokens: 40_000 } } }])
    const full = tap(300)
    const o = run(t, 'claude-code', claude('npm test -- --coverage', full, { transcript_path: transcript }))
    const u = o.hookSpecificOutput.updatedToolOutput
    assert.deepEqual(Object.keys(u), ['stdout', 'stderr', 'interrupted', 'isImage'])
    assert.ok(u.stdout.length < 1_200, String(u.stdout.length))
    const path = /The full output is in (\S+\.log):/.exec(u.stdout)![1]
    assert.equal(readFileSync(path, 'utf8'), full.trimEnd())
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    const [e] = events(t)
    assert.deepEqual([e.program, e.source, e.tool, e.action], ['npm', 'claude-code', 'Bash', 'strained'])
    assert.ok(!JSON.stringify(e).includes('coverage'))
    const want = (Number(e.raw_tokens) - Number(e.kept_tokens)) * ratesFor('claude-opus-5-5').cache_write_5m / 1e6
    assert.ok(Math.abs(Number(e.saved_usd) - want) < 1e-5, `${e.saved_usd} vs ${want}`)
    // the output was longer than Claude Code passes on, so the saving counts only what the model would have read
    assert.ok(full.length > 30_000)
    assert.equal(Number(e.raw_tokens), 7_500)
    run(t, 'claude-code', claude('npm test', full), { BASH_MAX_OUTPUT_LENGTH: '100000' })
    assert.equal(Number(events(t)[1].raw_tokens), Math.ceil(full.trimEnd().length / 4))
  })

  test('leaves alone what it should', (c) => {
    const t = useTemp(c)
    const big = tap(300)
    assert.equal(run(t, 'claude-code', claude('npm test', 'ok\n')), null)                                    // small
    assert.equal(run(t, 'claude-code', claude('cat results.tap', big)), null)                                // content asked for
    assert.equal(run(t, 'claude-code', claude('npm test | tail -50', big)), null)                            // already filtered
    assert.equal(run(t, 'claude-code', claude(`npm test ${colander.BYPASS}`, big)), null)                    // bypass
    assert.equal(run(t, 'claude-code', claude('npm test', big, { tool_input: { command: 'npm test', run_in_background: true } })), null)
    assert.equal(run(t, 'claude-code', claude('npm test', big), { AGENTARIUM_COLANDER: 'off' }), null)
    assert.equal(run(t, 'claude-code', { ...claude('npm test', big), tool_response: 'Exit code 1\n' + big }), null)   // failed
    assert.equal(run(t, 'claude-code', { session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/a' },
      tool_response: { file: { content: big } } }), null)
    assert.equal(run(t, 'vscode', { ...claude('npm test', big), hook_event_name: 'PostToolUse' }), null)    // can't replace
    assert.deepEqual(events(t), [])
    assert.ok(!existsSync(hook.logDir()) || !readdirSync(join(t.home, '.agentarium')).includes('colander'))
  })

  test('Copilot CLI: modifiedResult, counted in tokens and never in money', (c) => {
    const t = useTemp(c)
    const o = run(t, 'copilot', { sessionId: 'c1', cwd: '/app', toolName: 'bash', toolArgs: { command: 'pytest -v' },
      toolResult: { resultType: 'success', textResultForLlm: tap(300) } })
    assert.equal(o.modifiedResult.resultType, 'success')
    assert.match(o.modifiedResult.textResultForLlm, /# tests 300[\s\S]*\[colander: showed/)
    const [e] = events(t)
    assert.deepEqual([e.program, e.source, e.saved_usd], ['pytest', 'copilot', null])
  })

  test('AGENTARIUM_COLANDER_COMMANDS adds programs, and old logs are cleared out', (c) => {
    const t = useTemp(c)
    const dir = join(t.home, '.agentarium', 'colander')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'npm-old.log')
    writeFileSync(old, 'x')
    utimesSync(old, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000))
    assert.equal(run(t, 'claude-code', claude('./scripts/ci.sh', tap(300))), null)
    assert.ok(run(t, 'claude-code', claude('./scripts/ci.sh', tap(300)), { AGENTARIUM_COLANDER_COMMANDS: 'ci.sh, just' }))
    assert.ok(!existsSync(old))
    assert.equal(readdirSync(dir).length, 1)
  })

  test('report and strain on the command line', (c) => {
    const t = useTemp(c)
    run(t, 'claude-code', claude('cargo test', tap(300)))
    const r = JSON.parse(runScript('colander.ts', ['report', '--json'], { env: t.env() }).stdout)
    assert.equal(r.runs, 1)
    assert.equal(r.programs[0].program, 'cargo')
    assert.ok(r.raw_tokens > r.kept_tokens * 20)
    const text = runScript('cli.ts', ['colander'], { env: t.env() }).stdout
    assert.match(text, /colander: strained 1 command output \(last 7 days\)/)
    const s = runScript('cli.ts', ['colander', 'strain', '--command', 'npm test'], { input: tap(200), env: t.env() })
    assert.equal(s.status, 0, s.stderr)
    assert.match(s.stdout, /^colander strains `npm test` \(as npm\)[\s\S]*# tests 200[\s\S]*colander: showed \d+ of/)
    assert.match(runScript('colander.ts', ['strain', '--command', 'git diff'], { env: t.env() }).stdout, /leaves `git diff` alone/)
    // too small to strain: shown as the model gets it, whole, never "17 of 16 tokens"
    const small = runScript('cli.ts', ['colander', 'strain'], { input: tap(2), env: t.env() }).stdout
    assert.ok(small.includes('ok 2 '), small)
    assert.match(small, /Too little to leave out, so the model gets it unchanged/)
  })

  test('the dashboard and the weekly report count what it kept out', (c) => {
    const t = useTemp(c)
    run(t, 'claude-code', claude('npm test', tap(300)))
    const db = new Db(t.db)
    try {
      const h = PolicyEngine.activity(db, '2000-01-01').helpers.find((x) => x.helper === 'colander')!
      assert.equal(h.stopped, 1)
      assert.ok(h.tokens > 7_000 && h.tokens < 7_500 && h.saved_usd > 0, String(h.tokens))   // capped at what Claude Code passes on
    } finally {
      db.close()
    }
    const rep = JSON.parse(runScript('report.ts', ['--json', '--days', '0'], { env: t.env() }).stdout)
    if (!rep.empty) assert.equal(rep.helpers.colander.strained, 1)
  })

  test('is registered for Claude Code and Copilot CLI', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse
    assert.ok(hooks.some((g: any) => g.matcher === 'Bash' && g.hooks.some((h: any) => h.command.endsWith('colander.ts claude-code'))))
    const cp = JSON.parse(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8')).hooks.postToolUse
    assert.ok(cp.some((h: any) => h.bash === 'sh scripts/run.sh colander.ts copilot' && h.powershell.includes('scripts\\colander.ts copilot')))
  })
})
