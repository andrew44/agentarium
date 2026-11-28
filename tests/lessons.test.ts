/** fishingrod: the lesson behind each notice, in full the first few times, then a pointer. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { runScript, useTemp, withEnv } from './helpers.ts'

import * as lessons from '../tokenomics/engine/lessons.ts'

const who = (sessionId: string) => ({ sessionId, source: 'claude-code' })

describe('fishingrod: the why behind each notice', () => {
  test('every lesson says why and what to do, in house style', () => {
    const all = lessons.all()
    assert.ok(all.length >= 10)
    assert.equal(new Set(all.map((l) => l.key)).size, all.length)
    for (const l of all) {
      assert.match(l.key, /^[a-z]+(-[a-z]+)*$/, l.key)
      assert.ok(l.why.length > 40 && l.how.length > 20, l.key)
      const text = lessons.text(l)
      assert.match(text, /^Why: [A-Z][\s\S]*\nNext time: \S/, l.key)
      assert.ok(!/[\u2013\u2014]/.test(text), `${l.key}: no en or em dashes`)
    }
    assert.equal(lessons.get('nope'), null)
  })

  test('the model lesson prices the two models it is about', () => {
    const l = lessons.get('model-down', { from: 'claude-opus-5-5', to: 'claude-haiku-5-5', fromName: 'Opus', toName: 'Haiku' })!
    assert.match(l.why, /^Opus costs about 40 times as much per input token as Haiku\./)
    assert.match(l.how, /\/model haiku/)
    assert.match(lessons.get('model-down')!.why, /several times/)            // unknown models: no made-up number
  })

  test('in full the first 3 times (once per session), then a pointer; logged without the prompt', async (ctx) => {
    const e = useTemp(ctx)
    await withEnv({ TOKENOMICS_FISHINGROD: undefined, TOKENOMICS_FISHINGROD_TIMES: undefined }, () => {
      const shown = ['s1', 's1', 's2', 's3', 's4'].map((s) => lessons.teach(e.db, 'new-task', who(s)))
      assert.match(shown[0], /^\nWhy: /)
      assert.equal(shown[1], '\n' + lessons.pointer('new-task'))              // already taught this session
      assert.match(shown[2], /^\nWhy: /)
      assert.match(shown[3], /^\nWhy: /)
      assert.match(shown[4], /tokenomics fishingrod new-task/)               // used up
      assert.match(lessons.teach(e.db, 'cold-cache', who('s4')), /^\nWhy: /) // each lesson counts on its own
      assert.equal(lessons.teach(e.db, 'no-such-lesson', who('s5')), '')
    })
    assert.deepEqual(Object.keys(e.rows('SELECT * FROM fishingrod_events')[0]).sort(), ['action', 'id', 'lesson', 'session_id', 'source', 'ts'])
    assert.equal(e.rows("SELECT * FROM fishingrod_events WHERE lesson='new-task' AND action='taught'").length, 3)
    assert.equal(lessons.taught(e.db).get('new-task')?.total, 3)
  })

  test('always and off, and a bad count falls back to 3', async (ctx) => {
    const e = useTemp(ctx)
    await withEnv({ TOKENOMICS_FISHINGROD: 'always' }, () => {
      for (const s of ['a', 'a', 'a', 'a']) assert.match(lessons.teach(e.db, 'big-task', who(s)), /^\nWhy: /)
    })
    await withEnv({ TOKENOMICS_FISHINGROD: 'off' }, () => {
      assert.equal(lessons.teach(e.db, 'big-task', who('b')), '')
    })
    assert.equal(e.rows("SELECT * FROM fishingrod_events WHERE session_id='b'").length, 0)
    await withEnv({ TOKENOMICS_FISHINGROD_TIMES: 'lots' }, () => assert.equal(lessons.times(), 3))
    await withEnv({ TOKENOMICS_FISHINGROD_TIMES: '0' }, () => assert.equal(lessons.times(), 0))
  })

  test('a notice carries the lesson: parrot', (ctx) => {
    const e = useTemp(ctx)
    const send = (sid: string) => runScript('parrot.ts', ['claude-code'],
      { input: JSON.stringify({ session_id: sid, cwd: e.home, prompt: 'Always run the linter before you commit anything' }), env: e.env() })
    send('s1')
    send('s2')
    const msg = JSON.parse(send('s3').stdout).systemMessage
    assert.match(msg, /^parrot: you've told the AI/)
    assert.match(msg, /\nWhy: Each session starts blank\. Only instruction files such as CLAUDE\.md load every time/)
    assert.match(msg, /\nNext time: Write standing rules into CLAUDE\.md/)
  })

  test('the fishingrod command lists and shows lessons', (ctx) => {
    const e = useTemp(ctx)
    const list = runScript('fishingrod.ts', [], { env: e.env() })
    assert.equal(list.status, 0)
    assert.match(list.stdout, /`new-task` Starting a new task in an old conversation/)
    const one = runScript('fishingrod.ts', ['cold-cache', '--json'], { env: e.env() })
    assert.equal(JSON.parse(one.stdout).key, 'cold-cache')
    assert.equal(runScript('fishingrod.ts', ['nope'], { env: e.env() }).status, 1)
  })
})
