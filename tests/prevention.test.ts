/** The prevention roadmap: pennywise's net savings, the overhead gate, escalation, learning and
 *  evaluation, the proxy in the background, the prompt-time controller, profiles, the audit and the
 *  Copilot premium-request forecast. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, SCRIPTS, useTemp, withEnv } from './helpers.ts'

import * as audit from '../scripts/audit.ts'
import * as controller from '../scripts/controller.ts'
import * as pennywise from '../scripts/pennywise.ts'
import * as statusline from '../scripts/statusline.ts'
import * as store from '../tokenomics/engine/store.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as profile from '../tokenomics/profile.ts'
import * as premium from '../scripts/premium.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { Capability, NATIVE, support } from '../tokenomics/platform/capabilities.ts'
import * as premiumEngine from '../tokenomics/engine/premium.ts'

type Ctx = Parameters<typeof useTemp>[0]

/** A fresh home and database, with pennywise routing in hook mode. */
const sandbox = (c: Ctx, extra: Record<string, string | undefined> = {}) => {
  const t = useTemp(c)
  const dbPath = join(t.home, 'db.sqlite')
  const vars = { TOKENOMICS_PENNYWISE: 'route', ANTHROPIC_BASE_URL: '', TOKENOMICS_DB: dbPath, TOKENOMICS_HOME: join(t.home, '.tk'),
    TOKENOMICS_CURRENCY: 'USD', TOKENOMICS_BUDGET_DAILY: undefined, TOKENOMICS_BUDGET_SESSION: undefined, TOKENOMICS_PENNYWISE_OVERHEAD: undefined,
    TOKENOMICS_PENNYWISE_LEARN: undefined, TOKENOMICS_ROUTER_TIERS: undefined, ...extra }
  return { t, dbPath, run: <T>(fn: () => T | Promise<T>) => withEnv(vars, fn) }
}
const events = (dbPath: string) => withDb(dbPath, (db) => db.all('SELECT action, saved_usd, tier, score FROM pennywise_events ORDER BY id'))

describe('pennywise: savings net of the hand-off', () => {
  test('the estimate: routing down from Opus saves, and a bigger context saves more', () => {
    const small = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 0)
    const big = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 150_000)
    assert.ok(small.saving > 0 && big.saving > small.saving)
    assert.ok(small.handoff > 0 && small.handoff < small.stay)
    assert.equal(Math.round((small.stay - small.handoff - small.routed) * 1e6), Math.round(small.saving * 1e6))
    // a small step down (Fable -> Opus) with a small context: the hand-off eats the saving
    assert.ok(pennywise.estimateHandoff('claude-fable-5-2', 'claude-opus-5-5', 0).saving < 0)
  })

  test('a route logs its saving, and the session total adds up', async (c) => {
    const s = sandbox(c)
    const out = (await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app' })))!
    assert.ok(out.systemMessage.includes('after the hand-off'), out.systemMessage)
    const [e] = events(s.dbPath)
    assert.equal(e.action, 'routed')
    assert.ok(e.saved_usd > 0)
    assert.equal(e.tier, 'SIMPLE')
    const sv = pennywise.savings(s.dbPath, { session: 's' })
    assert.equal(sv.routed, 1)
    assert.ok(Math.abs(sv.saved - e.saved_usd) < 1e-9)
    assert.equal(statusline.pennywiseSavedUsd.length, 1)
    await s.run(() => assert.ok(Math.abs(statusline.pennywiseSavedUsd('s') - e.saved_usd) < 1e-9))
  })

  test('a route the hand-off would eat is skipped (unless the gate is off)', async (c) => {
    const complex = 'refactor the auth module across all services and migrate the database schema'
    const s = sandbox(c, { TOKENOMICS_ROUTER_TIERS: 'COMPLEX=opus,REASONING=fable' })
    assert.equal(await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-fable-5-2', prompt: complex })), null)
    assert.equal(events(s.dbPath)[0].action, 'skipped-overhead')
    const off = sandbox(c, { TOKENOMICS_ROUTER_TIERS: 'COMPLEX=opus,REASONING=fable', TOKENOMICS_PENNYWISE_OVERHEAD: 'off' })
    const out = await off.run(() => pennywise.handle({ session_id: 's', model: 'claude-fable-5-2', prompt: complex }))
    assert.ok(out!.hookSpecificOutput.additionalContext.includes('model: "opus"'))
  })

  test('routing up records what quality cost extra', async (c) => {
    const s = sandbox(c)
    await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-haiku-5-5',
      prompt: 'design the architecture for a distributed queue and compare trade-offs' }))
    const [e] = events(s.dbPath)
    assert.equal(e.action, 'routed-up')
    assert.ok(e.saved_usd < 0)
    assert.ok(pennywise.savings(s.dbPath, { session: 's' }).extra > 0)
  })
})

describe('pennywise: measured, not just estimated', () => {
  const side = (id: string, model: string, u: object, sidechain = true) => JSON.stringify({ type: 'assistant', isSidechain: sidechain,
    timestamp: new Date().toISOString(), message: { id, model, usage: u } }) + '\n'
  const U = { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 30_000, output_tokens: 600 }

  test('the next prompt measures the routed subagent and logs it beside the estimate', async (c) => {
    const s = sandbox(c)
    const tp = join(s.t.home, 'sess.jsonl')
    writeFileSync(tp, side('m0', 'claude-opus-5-5', { input_tokens: 5, cache_read_input_tokens: 40_000 }, false))
    await s.run(async () => {
      await pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app', transcript_path: tp })
      // the subagent's turns: one streamed message on two lines (counted once), one more turn, in the per-agent file
      writeFileSync(tp, readFileSync(tp, 'utf8') + side('a1', 'claude-haiku-5-5', U) + side('a1', 'claude-haiku-5-5', U))
      mkdirSync(join(s.t.home, 'sess', 'subagents'), { recursive: true })
      writeFileSync(join(s.t.home, 'sess', 'subagents', 'agent-1.jsonl'), side('a2', 'claude-haiku-5-5', U))
      await pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'thanks', transcript_path: tp })
    })
    const [e] = withDb(s.dbPath, (db) => db.all('SELECT * FROM pennywise_events ORDER BY id'))
    assert.equal(e.action, 'routed')
    assert.equal(e.m_steps, 2)
    assert.equal(e.m_output, 1200)
    assert.equal(e.m_input, 40_020 - 12_000)
    assert.ok(e.measured_usd > 0 && e.est_routed_usd > 0)
    assert.ok(Math.abs(e.measured_saved_usd - (e.saved_usd + e.est_routed_usd - e.measured_usd)) < 1e-6)
    const m = pennywise.measuredSummary(s.dbPath, '2000-01-01')
    assert.equal(m.n, 1)
    assert.ok(Math.abs(m.measured - e.measured_usd) < 1e-9)
  })

  test('no subagent ran: nothing measured', (c) => {
    const t = useTemp(c)
    const tp = join(t.home, 'x.jsonl')
    writeFileSync(tp, side('m', 'claude-opus-5-5', U, false))
    assert.equal(pennywise.measureSidechain(tp, 0), null)
  })

  test('learn calibrates the task shape from measured routes, and the estimate follows it', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      const before = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 50_000)
      withDb(s.dbPath, (db) => {
        pennywise.ensureLog(db)
        for (let i = 0; i < 6; i++) db.run("INSERT INTO pennywise_events(session_id,ts,action,tier,m_steps,m_input,m_output) VALUES(?,?,'routed','SIMPLE',?,?,?)",
          `s${i}`, new Date().toISOString(), 10, 60_000, 4000)
      })
      const r = await pennywise.learn(s.dbPath)
      assert.deepEqual(r.work, { steps: 10, input: 60_000, output: 4000, secs: pennywise.WORK.secs, n: 6 })
      assert.deepEqual(pennywise.work(), { steps: 10, input: 60_000, output: 4000, secs: pennywise.WORK.secs })
      assert.ok(pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 50_000).saving > before.saving)
      await withEnv({ TOKENOMICS_PENNYWISE_LEARN: 'off' }, () => assert.deepEqual(pennywise.work(), pennywise.WORK))
    })
  })
})

describe('pennywise: cache-aware hand-offs', () => {
  const turn = (ts: string, cc: object = {}) => JSON.stringify({ type: 'assistant', timestamp: ts,
    message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 90_000, cache_creation: cc } } }) + '\n'

  test('the cache state: warm, cold, the 1-hour cache and TOKENOMICS_CACHE_TTL', async (c) => {
    const t = useTemp(c)
    const tp = join(t.home, 't.jsonl')
    writeFileSync(tp, turn(new Date(Date.now() - 10 * 60_000).toISOString()))
    const lt = pennywise.lastTurn(tp)
    assert.equal(lt.ttl, 300)
    assert.deepEqual(pennywise.cacheState(lt), { cold: true, ttl: 300 })
    writeFileSync(tp, turn(new Date(Date.now() - 10 * 60_000).toISOString(), { ephemeral_1h_input_tokens: 4000 }))
    assert.deepEqual(pennywise.cacheState(pennywise.lastTurn(tp)), { cold: false, ttl: 3600 })
    await withEnv({ TOKENOMICS_CACHE_TTL: '60' }, () => assert.equal(pennywise.cacheState(pennywise.lastTurn(tp)).cold, true))
    assert.equal(pennywise.cacheState({ ts: null, ttl: 300 }).cold, true)
  })

  test('a cold cache costs both sides the same re-write; a task outlasting the cache costs the relay one', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      const warm = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 100_000, { cold: false, ttl: 300 })
      const cold = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 100_000, { cold: true, ttl: 300 })
      assert.ok(cold.stay > warm.stay && cold.handoff > warm.handoff)
      assert.ok(Math.abs(cold.saving - warm.saving) < 1e-5)       // the hand-off's call re-writes the context too
      // routed tasks that run 10 minutes: the relay lands on an expired 5-minute cache
      mkdirSync(join(s.t.home, '.tk'), { recursive: true })
      writeFileSync(pennywise.learnedPath(), JSON.stringify({ work: { ...pennywise.WORK, secs: 600 } }))
      const long = pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 100_000, { cold: false, ttl: 300 })
      assert.ok(long.handoff > warm.handoff)
      assert.equal(pennywise.estimateHandoff('claude-opus-5-5', 'claude-haiku-5-5', 100_000, { cold: false, ttl: 3600 }).handoff, warm.handoff)
    })
  })

  test('the hook logs the cache state, and skips a big warm hand-off whose relay would land cold', async (c) => {
    const s = sandbox(c)
    const tp = join(s.t.home, 'big.jsonl')
    writeFileSync(tp, turn(new Date().toISOString()).replace('90000', '600000'))
    const prompt = 'add a /health endpoint to the flask api'
    await s.run(async () => {
      await pennywise.handle({ session_id: 'a', model: 'claude-opus-5-5', prompt, transcript_path: tp })
      mkdirSync(join(s.t.home, '.tk'), { recursive: true })
      writeFileSync(pennywise.learnedPath(), JSON.stringify({ work: { ...pennywise.WORK, steps: 2, secs: 900 } }))
      assert.equal(await pennywise.handle({ session_id: 'b', model: 'claude-opus-5-5', prompt, transcript_path: tp }), null)
    })
    const rows = withDb(s.dbPath, (db) => db.all('SELECT session_id, action, cache, reason FROM pennywise_events ORDER BY id'))
    assert.deepEqual(rows.map((r) => [r.session_id, r.action, r.cache]), [['a', 'routed', 'warm'], ['b', 'skipped-overhead', 'warm']])
    assert.ok(rows[1].reason.includes('outlasts the 5-minute cache'), rows[1].reason)
  })
})

describe('pennywise: escalating on evidence, not only words', () => {
  let n = 0
  /** A tool call and its result, now, as transcript records (sidechain: made by the routed subagent). */
  const call = (command: string, result: string, error: boolean, sidechain = true) => {
    const id = `toolu_${++n}`
    const ts = new Date().toISOString()
    return JSON.stringify({ type: 'assistant', timestamp: ts, isSidechain: sidechain, message: { id: `msg_${n}`, model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n' +
      JSON.stringify({ type: 'user', timestamp: ts, isSidechain: sidechain,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: error }] } }) + '\n'
  }
  const routed = async (s: ReturnType<typeof sandbox>, tp: string) => {
    writeFileSync(tp, '')
    await pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app', transcript_path: tp })
  }

  test('a routed answer that ended on a failing test: the next prompt stays on the session\'s model', async (c) => {
    const s = sandbox(c)
    const tp = join(s.t.home, 'e.jsonl')
    const out = await s.run(async () => {
      await routed(s, tp)
      writeFileSync(tp, call('npm test', '2 passing\n1 failing', true) + call('git status', 'clean', false, false))
      return pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'now write a hello world in go', transcript_path: tp })
    })
    assert.ok(out!.systemMessage.includes('the last check it ran failed'), out!.systemMessage)
    const rows = withDb(s.dbPath, (db) => db.all('SELECT action, tier, reason FROM pennywise_events ORDER BY id'))
    assert.deepEqual(rows.map((r) => [r.action, r.tier]), [['routed', 'SIMPLE'], ['escalated', 'SIMPLE']])
    assert.ok(rows[1].reason.includes('the Haiku answer: the last check it ran failed'))
  })

  test('red then green is a pass, and a revert is a miss, read from the per-agent file', async (c) => {
    const s = sandbox(c)
    const tp = join(s.t.home, 'g.jsonl')
    await s.run(async () => {
      await routed(s, tp)
      writeFileSync(tp, call('npm test', '1 failing', true) + call('npm test', '3 passing', false))
      assert.equal(pennywise.missEvidence(tp, 's', 0), null)
      mkdirSync(join(s.t.home, 'g', 'subagents'), { recursive: true })
      writeFileSync(join(s.t.home, 'g', 'subagents', 'agent-1.jsonl'),
        JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'w', model: 'claude-haiku-5-5',
          content: [{ type: 'tool_use', id: 'tw', name: 'Edit', input: { file_path: '/p/a.ts' } }] } }) + '\n' +
        JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tw', content: 'ok', is_error: false }] } }) + '\n' +
        call('git checkout -- a.ts', '', false))
      assert.equal(pennywise.missEvidence(tp, 's', 0), 'its change was reverted')
    })
  })

  test('groundhog catching a loop after the route is a miss; nothing at all is not', async (c) => {
    const s = sandbox(c)
    const tp = join(s.t.home, 'h.jsonl')
    await s.run(async () => {
      await routed(s, tp)
      const since = Date.now() / 1000 - 1
      assert.equal(pennywise.missEvidence(tp, 's', since, s.dbPath), null)
      const ev = await import('../tokenomics/engine/events.ts')
      ev.log(s.dbPath, 'groundhog_events', { session_id: 's', source: 'claude-code', tool: 'Bash', rule: 'failing_command', loop_key: 'k', action: 'denied', detail: null })
      assert.equal(pennywise.missEvidence(tp, 's', since, s.dbPath), 'groundhog caught it going round in circles (failing command)')
      assert.equal(pennywise.missEvidence(tp, 'other', since, s.dbPath), null)
    })
  })

  test("the proxy's tool loop: two failing checks in a row move a routed-down conversation up one tier", () => {
    const r = new pennywise.Router({ tiers: { SIMPLE: 'haiku', MEDIUM: 'sonnet', COMPLEX: 'opus', REASONING: 'opus' },
      thresholds: { MEDIUM: 0.15, COMPLEX: 0.5, REASONING: 0.95 } }, { pressure: () => null })
    const sys = 'You are Claude Code'
    const ask = { role: 'user', content: 'create a hello world console app' }
    const use = (id: string, command: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] })
    const res = (id: string, text: string, err: boolean) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: err }] })
    const body = (msgs: object[]) => ({ model: 'pennywise', system: sys, messages: [ask, ...msgs] })
    assert.match(r.decide(body([]), 2000, 1000)[0], /haiku/)
    const one = [use('a', 'npm test'), res('a', '1 failing', true)]
    assert.match(r.decide(body(one), 2000, 1001)[0], /haiku/)                 // one red run: keep going
    const two = [...one, use('b', 'npm test'), res('b', '1 failing', true)]
    const [m, why] = r.decide(body(two), 2000, 1002)
    assert.match(m, /sonnet/)
    assert.equal(why, 'escalated: the Haiku work: its checks failed twice in a row')
    assert.match(r.decide(body([...two, use('c', 'ls'), res('c', 'x', false)]), 2000, 1003)[0], /sonnet/)   // the old evidence is spent
    assert.equal(pennywise.loopEvidence(body([use('d', 'git reset --hard')])), 'it reverted its own change')
    assert.equal(pennywise.loopEvidence(body([use('e', 'cat x'), res('e', 'groundhog: this is call number 4', true)])),
      'groundhog caught it going round in circles')
  })
})

describe('pennywise: escalation and learning', () => {
  test('"that didn\'t work" after a route down hands the next prompt back to the session\'s model', async (c) => {
    const s = sandbox(c)
    await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app' }))
    const out = (await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: "that didn't work, it still fails" })))!
    assert.ok(out.systemMessage.includes("didn't land"), out.systemMessage)
    assert.ok(!('hookSpecificOutput' in out))                  // no hand-off: Opus does it
    assert.deepEqual(events(s.dbPath).map((e) => e.action), ['routed', 'escalated'])
    // only once: the next "still wrong" has no routed answer to blame
    assert.equal(await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'still wrong' })), null)
  })

  test('the failure cue', () => {
    for (const p of ["that didn't work", 'still failing', 'tests still fail', "it's wrong", 'try again'])
      assert.ok(pennywise.FAILED_RE.test(p), p)
    for (const p of ['create a hello world app', 'wrong-way sign generator', 'add a retry']) assert.ok(!pennywise.FAILED_RE.test(p), p)
  })

  test("'keep-model:' on a prompt pennywise would route down is a label", async (c) => {
    const s = sandbox(c)
    assert.equal(await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'keep-model: create a hello world console app' })), null)
    assert.deepEqual(events(s.dbPath).map((e) => [e.action, e.tier]), [['kept', 'SIMPLE']])
  })

  test('learn: misses lower the threshold above, and loadConfig picks it up', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      withDb(s.dbPath, (db) => {
        pennywise.ensureLog(db)
        const ts = new Date().toISOString()
        for (let i = 0; i < 10; i++) db.run("INSERT INTO pennywise_events(session_id,ts,action,tier) VALUES(?,?,'routed','SIMPLE')", `s${i}`, ts)
        for (let i = 0; i < 6; i++) db.run("INSERT INTO pennywise_events(session_id,ts,action,tier) VALUES(?,?,'escalated','SIMPLE')", `s${i}`, ts)
      })
      const base = pennywise.loadConfig().thresholds.MEDIUM
      const r = await pennywise.learn(s.dbPath)
      assert.deepEqual(r.stats.SIMPLE, { holds: 4, misses: 6 })
      assert.ok(r.offsets.MEDIUM < 0)
      assert.ok(existsSync(pennywise.learnedPath()))
      assert.ok(pennywise.loadConfig().thresholds.MEDIUM < base)
      await withEnv({ TOKENOMICS_PENNYWISE_LEARN: 'off' }, () => assert.equal(pennywise.loadConfig().thresholds.MEDIUM, base))
    })
  })

  test('learn per project: a project with enough routes gets its own thresholds, the rest use the global ones', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      withDb(s.dbPath, (db) => {
        pennywise.ensureLog(db)
        const ts = new Date().toISOString()
        const add = (project: string, action: string, n: number) => {
          for (let i = 0; i < n; i++) db.run("INSERT INTO pennywise_events(session_id,ts,action,tier,project) VALUES(?,?,?,'SIMPLE',?)", `${project}${i}`, ts, action, project)
        }
        add('distsys', 'routed', 10)
        add('distsys', 'escalated', 6)          // misses a lot: route higher there
        add('frontend', 'routed', 9)            // holds: no change there, whatever the global offset
        add('tiny', 'escalated', 2)             // too few routes of its own
      })
      const base = pennywise.loadConfig().thresholds.MEDIUM
      const r = await pennywise.learn(s.dbPath)
      assert.ok(r.offsets.MEDIUM < 0)                                         // globally, SIMPLE misses too often
      assert.ok(r.projects!.distsys.offsets.MEDIUM < r.offsets.MEDIUM)
      assert.equal(r.projects!.frontend.offsets.MEDIUM, 0)
      assert.equal(r.projects!.tiny, undefined)
      assert.ok(pennywise.loadConfig('distsys').thresholds.MEDIUM < pennywise.loadConfig().thresholds.MEDIUM)
      assert.equal(pennywise.loadConfig('frontend').thresholds.MEDIUM, base)
      assert.equal(pennywise.loadConfig('tiny').thresholds.MEDIUM, pennywise.loadConfig().thresholds.MEDIUM)
    })
  })

  test("the hook logs the repository's name, never its path", async (c) => {
    const s = sandbox(c)
    const repo = join(s.t.home, 'work', 'shop-api')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    await s.run(() => pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app', cwd: join(repo, 'src') }))
    assert.deepEqual(withDb(s.dbPath, (db) => db.all('SELECT project FROM pennywise_events')).map((r) => r.project), ['shop-api'])
  })

  test('learn: too few routes move nothing; a dry run writes nothing', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      withDb(s.dbPath, (db) => {
        pennywise.ensureLog(db)
        db.run("INSERT INTO pennywise_events(session_id,ts,action,tier) VALUES('a',?,'escalated','SIMPLE')", new Date().toISOString())
      })
      const r = await pennywise.learn(s.dbPath, { dryRun: true })
      assert.deepEqual(r.offsets, {})
      assert.ok(!existsSync(pennywise.learnedPath()))
    })
  })

  test('eval: the labelled set routes mostly right, and rarely too low', () => {
    const r = pennywise.evaluate()
    assert.ok(r.total >= 40)
    assert.ok(r.accuracy >= 0.85, `accuracy ${r.accuracy}`)
    assert.ok(r.under <= 3, `routed too low: ${JSON.stringify(r.misses)}`)
  })
})

describe('pennywise: a growing evaluation set', () => {
  const mine = () => JSON.parse(readFileSync(pennywise.myEvalPath(), 'utf8')).prompts
  const miss = async (s: ReturnType<typeof sandbox>) => {
    await pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'create a hello world console app' })
    return pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: "that didn't work" })
  }

  test('an escalation is kept as a labelled case: hash and score only, unless you opt in to the text', async (c) => {
    const s = sandbox(c, { TOKENOMICS_PENNYWISE_EVAL: undefined })
    await s.run(async () => {
      const out = (await miss(s))!
      assert.ok(out.systemMessage.includes('router eval --mine'), out.systemMessage)
      const [k] = mine()
      assert.deepEqual([k.tier, k.from, typeof k.sha, typeof k.score, 'prompt' in k], ['MEDIUM', 'escalated', 'string', 'number', false])
      assert.ok(!readFileSync(pennywise.myEvalPath(), 'utf8').includes('hello world'))
      await pennywise.handle({ session_id: 's', model: 'claude-opus-5-5', prompt: 'keep-model: fix the typo in the README' })
      assert.deepEqual(mine().map((p: any) => [p.tier, p.from]), [['MEDIUM', 'escalated'], ['MEDIUM', 'kept']])
      // a hash-only case is placed by its recorded score
      const r = pennywise.evaluate(undefined, pennywise.myEvalPath())
      assert.equal(r.total, 2)
      assert.equal(r.under, 2)
    })
    const t = sandbox(c, { TOKENOMICS_PENNYWISE_EVAL: 'text' })
    await t.run(async () => {
      await miss(t)
      assert.equal(mine()[0].prompt, 'create a hello world console app')
      const r = pennywise.evaluate(undefined, pennywise.myEvalPath())
      assert.deepEqual(r.misses.map((m) => [m.want, m.got]), [['MEDIUM', 'SIMPLE']])
    })
    const off = sandbox(c, { TOKENOMICS_PENNYWISE_EVAL: 'off' })
    await off.run(async () => {
      await miss(off)
      assert.ok(!existsSync(pennywise.myEvalPath()))
    })
  })

  test('eval --check fails on a regression, --mine reads your set, --export shares the cases with text', async (c) => {
    const s = sandbox(c, { TOKENOMICS_PENNYWISE_EVAL: 'text' })
    const env = { ...process.env, TOKENOMICS_HOME: join(s.t.home, '.tk') }
    const run = (...a: string[]) => runScript('pennywise.ts', ['eval', ...a], { env })
    assert.equal(run('--check').status, 0)
    const bad = run('--check', '--min-accuracy', '0.99')
    assert.equal(bad.status, 1)
    assert.ok(bad.stdout.includes('FAILED'), bad.stdout)
    assert.ok(run('--mine').stdout.includes('no cases yet'))
    await s.run(() => miss(s))
    const m = run('--mine').stdout
    assert.ok(m.includes('0/1 prompts on the right tier') && m.includes('routed too low: 1'), m)
    assert.deepEqual(JSON.parse(run('--mine', '--export').stdout).prompts, [{ tier: 'MEDIUM', prompt: 'create a hello world console app' }])
    assert.ok(readFileSync(join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8').includes('pennywise.ts eval --check'))
  })
})

describe('pennywise proxy: savings, escalation, on/off', () => {
  const body = (msgs: object[]) => ({ model: 'pennywise', system: 's', messages: msgs })

  test('a routed request carries its saving; a failure moves the next turn up a tier', () => {
    const router = new pennywise.Router(pennywise.loadConfig(), { pressure: () => null })
    const first = [{ role: 'user', content: 'create a hello world console app' }]
    const [m] = router.decide(body(first), 40_000, 0)
    assert.match(m, /haiku/)
    assert.ok(router.lastSaving > 0)
    const again = [...first, { role: 'assistant', content: 'done' }, { role: 'user', content: "that didn't work" }]
    const [m2, why] = router.decide(body(again), 40_000, 10)
    assert.match(m2, /sonnet/)
    assert.ok(why.startsWith('escalated'), why)
  })

  test('on/off edits only the keys pennywise owns', (c) => {
    const t = useTemp(c)
    const f = join(t.home, '.claude', 'settings.json')
    mkdirSync(join(t.home, '.claude'), { recursive: true })
    writeFileSync(f, JSON.stringify({ model: 'opus', env: { FOO: '1' } }))
    pennywise.setProxyEnv(f, true, 8799)
    let s = JSON.parse(readFileSync(f, 'utf8'))
    assert.deepEqual(s.env, { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8799', ANTHROPIC_MODEL: 'pennywise' })
    pennywise.setProxyEnv(f, false, 8799)
    s = JSON.parse(readFileSync(f, 'utf8'))
    assert.deepEqual(s, { model: 'opus', env: { FOO: '1' } })
    writeFileSync(f, '{nope')
    assert.throws(() => pennywise.setProxyEnv(f, true, 8799), /valid JSON/)
  })

  test('ensure leaves other base URLs alone', async () => {
    await withEnv({ ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_MODEL: undefined }, () => pennywise.ensure())
    await withEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'claude-opus-5-5', TOKENOMICS_ROUTER_PORT: undefined },
      () => pennywise.ensure())   // a different local proxy: not ours, so nothing is started
  })
})

describe('controller: one decision per prompt', () => {
  test('the hooks run the controller, and it runs every prompt-time helper', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    assert.equal(hooks.UserPromptSubmit.length, 1)
    assert.ok(hooks.UserPromptSubmit[0].hooks[0].command.includes('controller.ts prompt claude-code'))
    assert.deepEqual(controller.STEPS.map((s) => s.name), ['spendlens', 'budget', 'holdup', 'pennywise', 'haggle', 'ballast', 'doggybag', 'blinkers', 'parrot'])
    for (const s of controller.STEPS) assert.ok(existsSync(join(SCRIPTS, `${s.name}.ts`)), s.name)
  })

  test('combine: the first block decides alone; otherwise one message and one context', () => {
    const ctx = (t: string) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: t } })
    const merged = controller.combine([['a', [{ systemMessage: 'one' }]], ['b', [ctx('x'), { systemMessage: 'two' }]], ['c', [ctx('y')]]])
    assert.deepEqual(merged.output, { systemMessage: 'one\ntwo', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x\n\ny' } })
    const blocked = controller.combine([['a', [{ systemMessage: 'one' }]], ['budget', [{ decision: 'block', reason: 'over' }]], ['c', [ctx('y')]]])
    assert.deepEqual([blocked.output, blocked.decidedBy], [{ decision: 'block', reason: 'over' }, 'budget'])
    assert.equal(controller.combine([['a', []]]).output, null)
  })

  test('a prompt pennywise routes: one message, in-process', async (c) => {
    const s = sandbox(c)
    const raw = JSON.stringify({ session_id: 's', cwd: s.t.home, model: 'claude-opus-5-5', prompt: 'create a hello world console app' })
    const d = await s.run(() => controller.decide(raw))
    assert.ok(d.output!.systemMessage.includes('pennywise: routing down to Haiku'))
    assert.ok(d.output!.hookSpecificOutput.additionalContext.includes('model: "haiku"'))
    assert.equal(d.ran.length, 9)
    assert.ok(withDb(s.dbPath, (db) => db.get("SELECT 1 AS x FROM sessions WHERE session_id='s'")))   // spendlens recorded it
  })

  test('a budget at its limit pauses the prompt before pennywise runs', async (c) => {
    const s = sandbox(c, { TOKENOMICS_BUDGET_SESSION: '1', TOKENOMICS_BUDGET_MODE: undefined })
    const db = store.connect(s.dbPath)
    try {
      db.run("INSERT INTO sessions(session_id) VALUES('s')")
      store.setCost(db, 's', 2, 'claude-opus-5-5')
    } finally {
      db.close()
    }
    const raw = JSON.stringify({ session_id: 's', cwd: s.t.home, model: 'claude-opus-5-5', prompt: 'create a hello world console app' })
    const d = await s.run(() => controller.decide(raw))
    assert.equal(d.output!.decision, 'block')
    assert.equal(d.decidedBy, 'budget')
    assert.deepEqual(d.ran, ['spendlens', 'budget'])
  })

  test('the hook command: quiet on bad input, skips what it is told to', async (c) => {
    const s = sandbox(c)
    const raw = JSON.stringify({ session_id: 's', cwd: s.t.home, model: 'claude-opus-5-5', prompt: 'create a hello world console app' })
    const d = await s.run(() => controller.decide(raw, 'claude-code', new Set(['pennywise'])))
    assert.ok(!d.ran.includes('pennywise'))
    for (const bad of ['', 'nope', '[1]']) assert.equal((await s.run(() => controller.decide(bad))).output, null)
  })
})

describe('controller latency in tokenomics doctor', () => {
  test('each prompt times its steps, and doctor flags the slow one', async (c) => {
    const s = sandbox(c, { TOKENOMICS_CONTROLLER_TIMING: undefined, TOKENOMICS_CONTROLLER_SLOW_MS: undefined })
    await s.run(async () => {
      const raw = JSON.stringify({ session_id: 'lat', cwd: s.t.home, prompt: 'hello' })
      const d = await controller.decide(raw)
      assert.deepEqual(d.timings!.map(([n]) => n), [...controller.STEPS.map((x) => x.name), 'total'])
      assert.ok(d.timings!.every(([, ms]) => ms >= 0))
      await controller.decide(raw)
      const rows = controller.latency(s.dbPath)
      const total = rows.find((r) => r.step === 'total')!
      assert.equal(total.prompts, 2)
      assert.equal(rows.length, controller.STEPS.length + 1)
      // a fake history: parrot takes 400 ms of every 500 ms prompt
      withDb(s.dbPath, (db) => {
        db.run('DELETE FROM controller_events')
        for (let i = 0; i < 5; i++) {
          for (const [step, ms] of [['parrot', 400 + i], ['budget', 20], ['total', 500]] as const)
            db.run("INSERT INTO controller_events(ts,session_id,run,source,step,ms) VALUES('t','lat',?,'claude-code',?,?)", `r${i}`, step, ms)
        }
      })
      const lat = controller.latency(s.dbPath)
      const parrot = lat.find((r) => r.step === 'parrot')!
      assert.deepEqual([parrot.median, parrot.slow, Math.round(parrot.share * 100)], [402, true, 80])
      assert.equal(lat.find((r) => r.step === 'budget')!.slow, false)
      const lines = controller.latencyLines(lat).join('\n')
      assert.ok(lines.includes('~500 ms a prompt'), lines)
      assert.ok(lines.includes('parrot') && lines.includes('TOKENOMICS_CONTROLLER_SKIP=parrot'), lines)
      assert.ok(lines.indexOf('parrot') < lines.indexOf('budget'))                    // slowest first
      await withEnv({ TOKENOMICS_CONTROLLER_SLOW_MS: '500' }, () => assert.equal(controller.latency(s.dbPath).find((r) => r.step === 'parrot')!.slow, false))
    })
  })

  test('TOKENOMICS_CONTROLLER_TIMING=off records nothing; doctor says so', async (c) => {
    const s = sandbox(c, { TOKENOMICS_CONTROLLER_TIMING: 'off' })
    await s.run(async () => {
      await controller.decide(JSON.stringify({ session_id: 'x', prompt: 'hello' }))
      assert.deepEqual(controller.latency(s.dbPath), [])
      assert.deepEqual(controller.latencyLines([]), ['  prompt time  nothing recorded yet (the controller times each prompt)'])
    })
  })
})

describe('the controller on Copilot', () => {
  const prompt = (sid: string, text: string) => JSON.stringify({ sessionId: sid, cwd: '/tmp', prompt: text, hookEventName: 'userPromptSubmitted' })
  const prompts = (dbPath: string) => withDb(dbPath, (db) => db.get("SELECT COUNT(*) AS n FROM telemetry_events WHERE platform='copilot' AND type='prompt'")!.n)

  test("Copilot's prompt hook is one process running its own steps", async (c) => {
    const cp = JSON.parse(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8')).hooks.userPromptSubmitted
    assert.equal(cp.length, 1)
    assert.ok(cp[0].bash.endsWith('controller.ts prompt copilot') && cp[0].powershell.includes('controller.ts prompt copilot'))
    assert.deepEqual(controller.stepsFor('copilot').map((s) => s.name), ['spendlens', 'premium', 'doggybag', 'blinkers'])
    assert.equal(controller.stepsFor('claude-code'), controller.STEPS)
    const s = sandbox(c)
    const d = await s.run(() => controller.decide(prompt('cp1', 'add a retry to the uploader'), 'copilot'))
    assert.deepEqual(d.ran, ['spendlens', 'premium', 'doggybag', 'blinkers'])
    assert.equal(d.output, null)
    assert.equal(prompts(s.dbPath), 1)
  })

  test('the allowance used up: recorded once while Copilot ignores the output, paused once it honours it', async (c) => {
    const s = sandbox(c, { TOKENOMICS_COPILOT_ALLOWANCE: '2', TOKENOMICS_COPILOT_MULTIPLIER: '1', TOKENOMICS_PREMIUM: undefined })
    const cp = getAdapter('copilot')
    assert.equal(cp.supports(Capability.PROMPT_DECISION), false)
    assert.equal(getAdapter('claude-code').supports(Capability.PROMPT_DECISION), true)
    const honours = Object.assign(Object.create(cp), { capabilities: { ...cp.capabilities, [Capability.PROMPT_DECISION]: support(NATIVE) },
      blockPrompt: (reason: string) => ({ decision: 'block', reason }) })
    const actions = () => withDb(s.dbPath, (db) => (db.tables().has('premium_events')
      ? db.all('SELECT action FROM premium_events ORDER BY id').map((r) => r.action) : []))
    await s.run(async () => {
      await controller.decide(prompt('cp2', 'one'), 'copilot')
      assert.deepEqual(actions(), [])                                                       // 1 of 2: not used up yet
      await controller.decide(prompt('cp2', 'two'), 'copilot')
      await controller.decide(prompt('cp2', 'three'), 'copilot')
      await controller.decide(prompt('cp2', 'four'), 'copilot')
      assert.deepEqual(actions(), ['would-pause'])                                          // once a session, and silent
      const payload = { sessionId: 'cp3', prompt: 'fix the flaky test' }
      const out = premium.decide(payload, honours, s.dbPath)!
      assert.equal(out.decision, 'block')
      assert.ok(out.reason.includes('used up (4 of 2)'), out.reason)
      assert.equal(premium.decide(payload, honours, s.dbPath), null)                        // the same prompt again: carry on
      assert.equal(premium.decide({ sessionId: 'cp3', prompt: 'next' }, honours, s.dbPath), null)
      assert.deepEqual(actions(), ['would-pause', 'paused', 'overridden'])
      assert.equal(premium.decide(payload, getAdapter('claude-code'), s.dbPath), null)     // Claude Code bills tokens
      await withEnv({ TOKENOMICS_PREMIUM: 'off' }, () => assert.equal(premium.decide({ sessionId: 'cp4', prompt: 'x' }, honours, s.dbPath), null))
    })
  })
})

describe('Copilot: each prompt at its own model\'s multiplier', () => {
  test('the per-model map: exact, then the longest key the model contains, then the default', () =>
    withEnv({ TOKENOMICS_COPILOT_MULTIPLIERS: 'claude-opus=10, claude-opus-4.8=27,gpt-4.1=0,bad,x=y', TOKENOMICS_COPILOT_MULTIPLIER: '2' }, () => {
      assert.deepEqual(premiumEngine.multiplierFor('gpt-4.1'), { multiplier: 0, known: true })
      assert.deepEqual(premiumEngine.multiplierFor('Claude-Opus-4.8'), { multiplier: 27, known: true })
      assert.deepEqual(premiumEngine.multiplierFor('claude-opus-4.1'), { multiplier: 10, known: true })
      assert.deepEqual(premiumEngine.multiplierFor('gemini-3-pro'), { multiplier: 2, known: false })
      assert.deepEqual(premiumEngine.multiplierFor(null), { multiplier: 2, known: false })
      assert.equal(premiumEngine.multipliers().size, 3)
    }))

  test("the model, read from Copilot's session state, else its config, else nothing", async (c) => {
    const t = useTemp(c)
    const home = join(t.home, 'copilot')
    const cp = getAdapter('copilot')
    await withEnv({ TOKENOMICS_COPILOT_HOME: home }, () => {
      assert.equal(cp.sessionModel({ sessionId: 's1' }), null)
      mkdirSync(join(home, 'session-state', 's1'), { recursive: true })
      writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'gpt-5' }))
      assert.equal(cp.sessionModel({ sessionId: 's1' }), 'gpt-5')
      writeFileSync(join(home, 'session-state', 's1', 'events.jsonl'), [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' } },
        { type: 'user.message', data: { content: 'the model is great' } },
        { type: 'session.model_change', data: { newModel: 'claude-haiku-4.5' } },
        { type: 'assistant.message', data: { content: 'ok' } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n')
      assert.equal(cp.sessionModel({ sessionId: 's1' }), 'claude-haiku-4.5')
      assert.equal(cp.sessionModel({ sessionId: '../s1' }), 'gpt-5')                   // never a path outside session-state
      assert.equal(cp.sessionModel({ sessionId: 's1', model: 'o4' }), 'o4')
      assert.equal(getAdapter('claude-code').sessionModel({ model: 'x' }), null)
    })
  })

  test('spendlens records each prompt at its multiplier; the outlook adds them up', async (c) => {
    const t = useTemp(c)
    const home = join(t.home, 'copilot')
    const s = sandbox(c, { TOKENOMICS_COPILOT_HOME: home, TOKENOMICS_COPILOT_MULTIPLIERS: 'claude-haiku-4.5=0.33,claude-opus=10',
      TOKENOMICS_COPILOT_MULTIPLIER: '1', TOKENOMICS_COPILOT_ALLOWANCE: '300' })
    const state = join(home, 'session-state', 'cpm')
    mkdirSync(state, { recursive: true })
    const use = (model: string) => writeFileSync(join(state, 'events.jsonl'), JSON.stringify({ type: 'session.model_change', data: { newModel: model } }) + '\n')
    const ask = (p: string) => controller.decide(JSON.stringify({ sessionId: 'cpm', cwd: '/tmp', prompt: p }), 'copilot')
    await s.run(async () => {
      use('claude-opus-4.8')
      await ask('one')
      await ask('two')
      use('claude-haiku-4.5')
      await ask('three')
      const rows = withDb(s.dbPath, (db) => db.all("SELECT model, premium FROM telemetry_events WHERE type='prompt' ORDER BY id"))
      assert.deepEqual(rows.map((r) => [r.model, r.premium]), [['claude-opus-4.8', 10], ['claude-opus-4.8', 10], ['claude-haiku-4.5', 0.33]])
      const u = statusline.copilotUsage(new Date(), 1)!
      assert.deepEqual(u, { prompts: 3, requests: 20.33, last: 0.33 })
      const p = statusline.premiumOutlook(u.prompts, statusline.copilotAllowance()!, new Date(), 10, u)
      assert.equal(p.used, 20.3)
      assert.equal(p.next, 3.3)
    })
  })

  test('Copilot Fusion: the model it routed to, billed at that model, with Fusion as the router', async (c) => {
    const t = useTemp(c)
    const home = join(t.home, 'copilot')
    const cp = getAdapter('copilot')
    const state = join(home, 'session-state', 'fu')
    const write = (evs: object[]) => writeFileSync(join(state, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
    mkdirSync(state, { recursive: true })
    await withEnv({ TOKENOMICS_COPILOT_HOME: home }, () => {
      write([{ type: 'session.start', data: { selectedModel: 'copilot-fusion-high' } }])
      assert.deepEqual(cp.sessionRoute({ sessionId: 'fu' }), { model: 'copilot-fusion-high', router: 'copilot-fusion-high' })   // nothing routed yet
      write([
        { type: 'session.start', data: { selectedModel: 'copilot-fusion-high' } },
        { type: 'assistant.usage', data: { model: 'gpt-5' } },
        { type: 'assistant.usage', data: { model: 'claude-sonnet-4.6' } },
      ])
      assert.deepEqual(cp.sessionRoute({ sessionId: 'fu' }), { model: 'claude-sonnet-4.6', router: 'copilot-fusion-high' })
      assert.equal(cp.sessionModel({ sessionId: 'fu' }), 'claude-sonnet-4.6')
      assert.deepEqual(cp.sessionRoute({ sessionId: 'fu', model: 'copilot-fusion' }), { model: 'claude-sonnet-4.6', router: 'copilot-fusion' })
      write([
        { type: 'session.start', data: { selectedModel: 'copilot-fusion' } },
        { type: 'assistant.usage', data: { model: 'claude-sonnet-4.6' } },
        { type: 'session.model_change', data: { newModel: 'gpt-4.1' } },
      ])
      assert.deepEqual(cp.sessionRoute({ sessionId: 'fu' }), { model: 'gpt-4.1', router: null })                    // picked by hand again
      writeFileSync(join(state, 'events.jsonl'), JSON.stringify({ type: 'assistant.usage', data: { model: 'gpt-5' } }) + '\n')
      writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'copilot-fusion' }))
      assert.deepEqual(cp.sessionRoute({ sessionId: 'fu' }), { model: 'gpt-5', router: 'copilot-fusion' })          // Fusion is the default
      assert.deepEqual(getAdapter('vscode').sessionRoute({ model: 'copilot-fusion' }), { model: 'copilot-fusion', router: 'copilot-fusion' })
      assert.deepEqual(getAdapter('claude-code').sessionRoute({ model: 'x' }), { model: null, router: null })
    })

    const s = sandbox(c, { TOKENOMICS_COPILOT_HOME: home, TOKENOMICS_COPILOT_MULTIPLIERS: 'claude-sonnet=1,gpt-5=0', TOKENOMICS_COPILOT_MULTIPLIER: '3' })
    await s.run(async () => {
      write([{ type: 'session.start', data: { selectedModel: 'copilot-fusion' } }, { type: 'assistant.usage', data: { model: 'gpt-5' } }])
      writeFileSync(join(home, 'config.json'), '{}')
      await controller.decide(JSON.stringify({ sessionId: 'fu', cwd: '/tmp', prompt: 'one' }), 'copilot')
      const rows = withDb(s.dbPath, (db) => db.all("SELECT model, router, premium FROM telemetry_events WHERE type='prompt'"))
      assert.deepEqual(rows.map((r) => [r.model, r.router, r.premium]), [['gpt-5', 'copilot-fusion', 0]])
      assert.deepEqual(statusline.copilotRoute('fu'), { model: 'gpt-5', router: 'copilot-fusion' })
      assert.equal(statusline.copilotRoute('other'), null)
      const info = statusline.gather({ session_id: 'fu', model: { id: 'copilot-fusion', display_name: 'Copilot Fusion' } }, {}, {})
      assert.equal(info.model, 'Copilot Fusion → gpt-5')
      assert.equal(statusline.gather({ session_id: 'fu', model: { id: 'gpt-4.1', display_name: 'GPT-4.1' } }, {}, {}).model, 'GPT-4.1')
    })
    assert.equal(statusline.fusionLabel('copilot-fusion-high'), 'Fusion High')
    assert.equal(statusline.fusionLabel('copilot-fusion'), 'Fusion')
  })

  test('an older database gets the new columns, and its prompts count at the default', (c) => {
    const t = useTemp(c)
    const path = join(t.home, 'old.sqlite')
    withDb(path, (db) => {
      db.exec("CREATE TABLE telemetry_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, v INTEGER, type TEXT, platform TEXT, session_id TEXT, project TEXT, developer TEXT, billing_model TEXT, tool TEXT, tool_kind TEXT, command_kind TEXT, path TEXT, ok INTEGER, prompt_chars INTEGER)")
      db.run("INSERT INTO telemetry_events(ts,type,platform) VALUES(?,'prompt','copilot')", new Date().toISOString())
    })
    return withEnv({ TOKENOMICS_DB: path }, async () => {
      assert.deepEqual(statusline.copilotUsage(new Date(), 4), { prompts: 1, requests: 4, last: null })
      const telemetry = await import('../tokenomics/services/telemetry.ts')
      withDb(path, (db) => telemetry.ensure(db))
      assert.ok(withDb(path, (db) => db.columns('telemetry_events').has('premium')))
      assert.deepEqual(statusline.copilotUsage(new Date(), 4), { prompts: 1, requests: 4, last: null })
    })
  })
})

describe('profiles and the config file', () => {
  test('env beats config.json beats the profile', (c) => {
    const t = useTemp(c)
    const f = join(t.home, 'config.json')
    writeFileSync(f, JSON.stringify({ profile: 'frugal', settings: { budget_daily: 20, TOKENOMICS_DIET: 'warn', bad: { x: 1 } } }))
    const r = profile.resolve({ TOKENOMICS_BALLAST: 'off' }, f)
    assert.equal(r.profile, 'frugal')
    assert.deepEqual(r.values.TOKENOMICS_BUDGET_DAILY, { value: '20', from: 'config' })
    assert.deepEqual(r.values.TOKENOMICS_DIET, { value: 'warn', from: 'config' })          // config over the profile's "block"
    assert.deepEqual(r.values.TOKENOMICS_BALLAST, { value: 'off', from: 'env' })           // env over the profile's "block"
    assert.deepEqual(r.values.TOKENOMICS_PENNYWISE_UP, { value: 'off', from: 'profile' })
    assert.ok(r.errors.some((e) => e.includes('settings.bad')))
    const env: NodeJS.ProcessEnv = { TOKENOMICS_PROFILE: 'quality' }
    profile.applyProfile(env)
    assert.equal(env.TOKENOMICS_PENNYWISE_BUDGET, 'off')
    assert.ok(profile.resolve({ TOKENOMICS_PROFILE: 'stingy' }, f).errors.some((e) => e.includes('unknown profile')))
  })

  test('per project: the longest folder prefix wins, a bare name matches TOKENOMICS_PROJECT', (c) => {
    const t = useTemp(c)
    const f = join(t.home, 'config.json')
    const api = join(t.home, 'work', 'api')
    writeFileSync(f, JSON.stringify({ profile: 'balanced', projects: { [join(t.home, 'work')]: 'frugal', [api]: 'quality', shop: 'frugal' } }))
    const none = join(t.home, 'none.json')
    const at = (cwd: string, env: NodeJS.ProcessEnv = {}) => profile.resolve(env, f, cwd, none)
    assert.deepEqual([at(join(api, 'src')).profile, at(join(api, 'src')).from, at(join(api, 'src')).project], ['quality', 'project', api])
    assert.equal(at(join(t.home, 'work', 'web')).profile, 'frugal')
    assert.equal(at(join(t.home, 'work-other')).profile, 'balanced')            // a prefix of the name is not the folder
    assert.equal(at(join(t.home, 'elsewhere')).from, 'config')
    assert.equal(at(join(t.home, 'x'), { TOKENOMICS_PROJECT: 'shop' }).profile, 'frugal')
    assert.equal(at(join(api, 'src'), { TOKENOMICS_PROFILE: 'frugal' }).from, 'env')
    assert.equal(profile.projectProfile({ '~/work/api': 'quality' }, join(homedir(), 'work', 'api', 'x'))?.profile, 'quality')
    assert.equal(at(join(api, 'src')).values.TOKENOMICS_ROUTER_TIERS.value, profile.PROFILES.quality.TOKENOMICS_ROUTER_TIERS)
  })

  test('per phase: opted in, today past the warning share switches to the budget profile for the day', async (c) => {
    const t = useTemp(c)
    const f = join(t.home, 'config.json')
    const phase = join(t.home, 'budget_phase.json')
    writeFileSync(f, JSON.stringify({ profile: 'quality', settings: { budget_profile: 'frugal' } }))
    assert.equal(profile.resolve({}, f, t.home, phase).profile, 'quality')        // not marked yet
    // the budget hook marks the day once it passes 80% of the daily budget
    const db = join(t.home, 'db.sqlite')
    const s = store.connect(db)
    s.run("INSERT INTO cost_events(session_id,ts,day,usd) VALUES('a','t',?,9)", new Date().toLocaleDateString('sv'))
    s.close()
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOKENOMICS_')))
    const env = { ...base, TOKENOMICS_DB: db, TOKENOMICS_HOME: t.home, TOKENOMICS_BUDGET_DAILY: '10', TOKENOMICS_CURRENCY: 'USD',
      TOKENOMICS_BUDGET_PROFILE: 'frugal' }
    runScript('budget.ts', ['claude-code'], { input: JSON.stringify({ session_id: 'a', prompt: 'hi' }), env })
    assert.ok(profile.inBudgetPhase(phase))
    const r = profile.resolve({}, f, t.home, phase)
    assert.deepEqual([r.profile, r.from], ['frugal', 'phase'])
    assert.equal(profile.resolve({ TOKENOMICS_PROFILE: 'quality' }, f, t.home, phase).profile, 'quality')   // the env still wins
    writeFileSync(phase, JSON.stringify({ day: '2001-01-01', pct: 90 }))
    assert.equal(profile.resolve({}, f, t.home, phase).profile, 'quality')        // yesterday's mark is spent
    // not opted in: nothing is marked
    const t2 = useTemp(c)
    runScript('budget.ts', ['claude-code'], { input: JSON.stringify({ session_id: 'a', prompt: 'hi' }),
      env: { ...base, TOKENOMICS_DB: db, TOKENOMICS_HOME: t2.home, TOKENOMICS_BUDGET_DAILY: '10', TOKENOMICS_CURRENCY: 'USD' } })
    assert.ok(!existsSync(join(t2.home, 'budget_phase.json')))
  })

  test('names', () => {
    assert.equal(profile.envName('budget_daily'), 'TOKENOMICS_BUDGET_DAILY')
    assert.equal(profile.envName('TOKENOMICS_DIET'), 'TOKENOMICS_DIET')
    assert.equal(profile.envName('PATH'), null)
  })

  test('the frugal profile routes routine work to Haiku', async () => {
    const env: NodeJS.ProcessEnv = { TOKENOMICS_PROFILE: 'frugal' }
    profile.applyProfile(env)
    await withEnv({ TOKENOMICS_ROUTER_TIERS: env.TOKENOMICS_ROUTER_TIERS, TOKENOMICS_PENNYWISE_LEARN: 'off' },
      () => assert.equal(pennywise.score('add a /health endpoint to the flask api').model, 'haiku'))
  })
})

describe('audit', () => {
  test('every section is a helper, and the headline finds the money', () => {
    for (const s of audit.SECTIONS) {
      assert.ok(existsSync(join(SCRIPTS, `${audit.script(s.name)}.ts`)), s.name)
      assert.ok(existsSync(join(ROOT, 'skills', s.name, 'SKILL.md')), s.name)       // the section is named after its skill
    }
    assert.equal(audit.script('cold-snap'), audit.script('coldsnap'))            // --only takes the old name too
    assert.equal(audit.headline({ a: { overhead_per_month_usd: 12.5, sessions: 400 }, b: [{ cost_usd: 3 }] }), 12.5)
    assert.equal(audit.headline({ sessions: 40 }), 0)
  })

  test('nothing recorded: one quiet line', () => {
    const md = audit.markdown([{ name: 'waffle', about: 'output', ok: true, json: {}, markdown: 'No output recorded yet.', money: 0 },
      { name: 'ballast', about: 'carry', ok: false, json: null, markdown: '', money: 0 }])
    assert.ok(md.includes('Nothing to report yet: waffle, ballast'))
    assert.ok(!md.includes('## waffle'))
  })
})

describe('Copilot: premium requests, forecast like a budget', () => {
  const a = { monthly: 300, multiplier: 1 }

  test('pace, projection and the day it runs out', () => {
    const mid = statusline.premiumOutlook(150, a, new Date('2026-11-11T00:00:00Z'))     // 10 days in: 15 a day
    assert.deepEqual([mid.used, mid.left, mid.per_day, mid.projected, mid.runs_out], [150, 150, 15, 450, '2026-11-21'])
    const calm = statusline.premiumOutlook(30, a, new Date('2026-11-21T00:00:00Z'))
    assert.equal(calm.runs_out, null)
    const over = statusline.premiumOutlook(100, { monthly: 300, multiplier: 4 }, new Date('2026-11-21T00:00:00Z'))
    assert.deepEqual([over.over, over.runs_out, over.next], [true, 'now', 40])
  })

  test('the statusline row', () => {
    const style = new statusline.Style('dark', false)
    const row = statusline.renderPremium(statusline.premiumOutlook(150, a, new Date('2026-11-11T00:00:00Z')), style)
    assert.ok(row.includes('150 of 300 premium requests left this month'), row)
    assert.ok(row.includes('runs out ~21 Nov'), row)
    assert.equal(statusline.renderPremium(null, style), '')
  })

  test('no allowance set, no forecast', async () => {
    await withEnv({ TOKENOMICS_COPILOT_ALLOWANCE: undefined }, () => assert.equal(statusline.copilotAllowance(), null))
    await withEnv({ TOKENOMICS_COPILOT_ALLOWANCE: '300', TOKENOMICS_COPILOT_MULTIPLIER: undefined },
      () => assert.deepEqual(statusline.copilotAllowance(), { monthly: 300, multiplier: 1 }))
  })
})

describe('the band and statusline show what pennywise saved', () => {
  const cfg = { ...statusline.DEFAULT_CFG, currency: 'GBP', usd_gbp: 0.76 }
  const info: statusline.Info = { model: 'Opus 5.5', total: 4e6, cost: 1.46, symbol: '£', estimated: false, pct: 20, ttl: 300, remaining: 250,
    raw: { modelId: 'claude-opus-5-5', ctx: 40_000, window: 200_000, requests: 10, output: 6_000, rate: 0.76 } }

  test('saved, in the display currency, on the row and in the JSON', async () => {
    await withEnv({ TOKENOMICS_BUDGET_DAILY: undefined, TOKENOMICS_BUDGET_SESSION: undefined }, () => {
      const o = statusline.outlook(info, cfg, { savedUsd: 1 })!
      assert.ok(Math.abs(o.saved - 0.76) < 1e-9)
      assert.equal(statusline.outlookJson(o, '£')!.saved, '£0.76')
      assert.ok(statusline.renderOutlook(o, info, new statusline.Style('dark', false)).includes('£0.76 saved by pennywise'))
      assert.equal(statusline.outlookJson(statusline.outlook(info, cfg, { savedUsd: 0 })!, '£')!.saved, null)
    })
  })
})

describe("haggle's agreed price is a budget the outlook counts down", () => {
  const cfg = { ...statusline.DEFAULT_CFG, currency: 'GBP', usd_gbp: 0.76 }
  const info: statusline.Info = { model: 'Opus 5.5', total: 4e6, cost: 1.46, symbol: '£', estimated: false, pct: 20, ttl: 300, remaining: 250,
    sid: 'task-s', raw: { modelId: 'claude-opus-5-5', ctx: 40_000, window: 200_000, requests: 10, output: 6_000, rate: 0.76 } }
  const none = { TOKENOMICS_BUDGET_DAILY: undefined, TOKENOMICS_BUDGET_SESSION: undefined, TOKENOMICS_BUDGET_MONTHLY: undefined }

  test('the open contract, read from the database', async (c) => {
    const s = sandbox(c)
    await s.run(async () => {
      assert.equal(statusline.taskContractUsd('task-s'), null)
      const contract = await import('../tokenomics/engine/contract.ts')
      withDb(s.dbPath, (db) => {
        contract.start(db, 'task-s', { tier: 'COMPLEX', turns: 10, low: 0.5, mid: 1, high: 2, breakdown: { input: 0, tools: 0, output: 0 },
          calibration: 1, samples: 0 }, 1, 2.5, true, null, 0)
        db.run("UPDATE contracts SET spent_usd=1.5 WHERE session_id='task-s'")
      })
      assert.deepEqual(statusline.taskContractUsd('task-s'), { limit: 2.5, spent: 1.5 })
      await withEnv(none, () => {
        const o = statusline.outlook(info, cfg)!
        assert.equal(o.budget!.kind, 'task')
        assert.ok(Math.abs(o.budget!.left - 0.76) < 1e-9)
      })
      withDb(s.dbPath, (db) => contract.close(db, 'task-s'))
      assert.equal(statusline.taskContractUsd('task-s'), null)
    })
  })

  test('"£0.80 of £2.00 left this task", on the row, in the JSON and in the tip; the tighter budget wins', async () => {
    await withEnv(none, () => {
      const task = { limit: 2 / 0.76, spent: 1.2 / 0.76 }
      const o = statusline.outlook(info, cfg, { task, savedUsd: 0 })!
      assert.equal(o.budget!.kind, 'task')
      const row = statusline.renderOutlook(o, info, new statusline.Style('dark', false))
      assert.ok(row.includes('£0.80 of £2.00 left this task'), row)
      assert.ok(row.includes(`~${o.budget!.steps_left} step`), row)
      assert.equal(statusline.outlookJson(o, '£')!.budget.kind, 'task')
      assert.ok(statusline.tipText(o, '£').includes('£0.80 of £2.00 left this task'))
      if (o.budget!.steps_left! < o.steps) assert.ok(o.tip!.why.includes("task's agreed budget"), o.tip!.why)
    })
    await withEnv({ ...none, TOKENOMICS_BUDGET_SESSION: '1.50' }, () => {
      // the session has £0.04 left, the task more: the session's budget is the tighter
      const o = statusline.outlook(info, cfg, { task: { limit: 10, spent: 0 }, savedUsd: 0 })!
      assert.equal(o.budget!.kind, 'session')
    })
    await withEnv({ ...none, TOKENOMICS_BUDGET_MODE: 'off' }, () => {
      assert.equal(statusline.outlook(info, cfg, { task: { limit: 2, spent: 1 }, savedUsd: 0 })!.budget!.kind, 'task')
    })
  })
})

describe('pennywise proxy: escalation stays within what was asked for', () => {
  test('after an Opus answer, "try again" stays on Opus for a "pennywise" request', () => {
    const router = new pennywise.Router(pennywise.loadConfig(), { pressure: () => null })
    const body = (msgs: object[]) => ({ model: 'pennywise', system: 's', messages: msgs })
    const hard = [{ role: 'user', content: 'refactor the auth module across all services and migrate the database schema' }]
    assert.match(router.decide(body(hard), 40_000, 0)[0], /opus/)
    const [m, why] = router.decide(body([...hard, { role: 'assistant', content: 'done' }, { role: 'user', content: 'try again' }]), 40_000, 10)
    assert.match(m, /opus/)
    assert.ok(!why.startsWith('escalated'), why)
  })
})
