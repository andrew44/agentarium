/** rate-my-prompt (alias judge): the five criteria, the score out of 10 and the script. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { rate } from '../tokenomics/engine/promptscore.ts'
import { lastPrompt } from '../scripts/ratemyprompt.ts'
import { ROOT, runScript, useTemp, user, writeTranscript } from './helpers.ts'

const GOOD = 'In `src/auth/login.ts`, `checkToken()` throws TypeError on an expired token. It should return 401 instead. ' +
  'Only change that function. Reply with the diff only.'
const BAD = 'Hi! Could you please improve the whole codebase and also make it better? Explain everything in detail. Thanks so much'
const byKey = (p: string) => Object.fromEntries(rate(p).criteria.map((c) => [c.key, c.score]))

describe('rate-my-prompt', () => {
  test('a score out of 10, five criteria of 2, one decimal place at most', () => {
    for (const p of [GOOD, BAD, 'fix it', 'why does the cache go cold after an hour?', 'x'.repeat(30_000)]) {
      const r = rate(p)
      assert.equal(r.max, 10)
      assert.equal(r.criteria.length, 5)
      assert.ok(r.score >= 0 && r.score <= 10, String(r.score))
      assert.equal(Math.round(r.score * 10) / 10, r.score)
      for (const c of r.criteria) assert.ok(c.score >= 0 && c.score <= 2)
      assert.equal(r.score, Math.round(r.criteria.reduce((s, c) => s + c.score, 0) * 10) / 10)
    }
  })

  test('a targeted, bounded prompt beats a vague one', () => {
    const good = rate(GOOD)
    const bad = rate(BAD)
    assert.ok(good.score >= 8.5, String(good.score))
    assert.ok(bad.score < 4.5, String(bad.score))
    assert.match(good.verdict, /^lean/)
    assert.match(bad.verdict, /^costly/)
    assert.equal(bad.tips.length, 5)
  })

  test('each criterion reacts to its own signal', () => {
    assert.ok(byKey('fix `parse()` in src/a.ts').target > byKey('fix the parser').target)
    assert.ok(byKey('fix the parser so tests pass').done > byKey('fix the parser').done)
    assert.ok(byKey('fix the parser').scope > byKey('fix the parser and also refactor the entire codebase').scope)
    assert.ok(byKey('fix the parser').lean > byKey('Hello! Could you please fix the parser? Thanks').lean)
    assert.ok(byKey('fix the parser, diff only').output > byKey('fix the parser and walk me through it').output)
    assert.ok(byKey('rename x to y').output > byKey('ultrathink: rename x to y').output)
    const pasted = 'why does this fail?\n```\n' + 'log line\n'.repeat(400) + '```'
    assert.ok(byKey(pasted).lean < 2)
  })

  test('the same prompt always gets the same score', () => {
    assert.deepEqual(rate(GOOD), rate(GOOD))
  })

  test('the script: argument, stdin, --last, and judge as an alias', (c) => {
    const t = useTemp(c)
    const arg = runScript('ratemyprompt.ts', [GOOD, '--json'], { env: t.env() })
    assert.equal(arg.status, 0, arg.stderr)
    assert.equal(JSON.parse(arg.stdout).score, rate(GOOD).score)
    const piped = runScript('ratemyprompt.ts', ['--json'], { env: t.env(), input: BAD })
    assert.equal(JSON.parse(piped.stdout).score, rate(BAD).score)
    assert.equal(runScript('ratemyprompt.ts', [], { env: t.env() }).status, 2)

    const tr = writeTranscript(t.home, 's1', [user(GOOD), user('/judge my last prompt')])
    assert.equal(lastPrompt(tr), GOOD)
    const last = runScript('ratemyprompt.ts', ['--last', '--transcript', tr], { env: t.env() })
    assert.match(last.stdout, new RegExp(`rate-my-prompt: ${rate(GOOD).score}/10`))

    for (const name of ['rate-my-prompt', 'judge', 'ratemyprompt']) {
      const p = runScript('cli.ts', [name, 'fix it'], { env: t.env() })
      assert.equal(p.status, 0, `${name}: ${p.stderr}`)
      assert.match(p.stdout, /rate-my-prompt: [\d.]+\/10/)
    }
    for (const name of ['rate-my-prompt', 'judge']) {
      const skill = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
      assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: `))
      assert.ok(skill.includes('run.sh" ratemyprompt.ts'))
    }
  })
})
