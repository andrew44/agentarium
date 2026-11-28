/** Pricing, currency, budget, diet and the spend report. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { assistant, ROOT, runScript, SCRIPTS, useTemp, user, withEnv, writeTranscript, type Env } from './helpers.ts'

import * as report from '../scripts/report.ts'
import * as statusline from '../scripts/statusline.ts'
import { settings } from '../agentarium/config.ts'
import * as allowance from '../agentarium/engine/allowance.ts'
import * as budget from '../agentarium/engine/budget.ts'
import * as currency from '../agentarium/engine/currency.ts'
import * as diet from '../agentarium/engine/diet.ts'
import { TOOL_READ, TOOL_SHELL, tokenUsage, toolCall } from '../agentarium/engine/evidence.ts'
import * as pricing from '../agentarium/engine/pricing.ts'
import * as session from '../agentarium/engine/session.ts'
import * as store from '../agentarium/engine/store.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'

const SONNET = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-7, msg ?? `${a} != ${b}`)

function sonnetMsg(mid: string, usage: object = SONNET) {
  const rec = assistant(mid, [], usage)
  rec.message.model = 'claude-sonnet-5-5'
  return rec
}

describe('pricing', () => {
  test('the engine and the status line agree for every model', () => {
    // statusline.ts keeps its own copy of the lookup (it is installed as a single file).
    const models = Object.keys(JSON.parse(readFileSync(join(ROOT, 'data', 'model-prices.json'), 'utf8')).models)
    const names = [...models, 'claude-opus-4-1-20250805', 'Opus 5.5', 'claude-opus-5-5[1m]', 'gpt-5', 'mystery',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-haiku-5-5']
    const cfgs = [{}, { prices: { 'claude-opus-5-5': [3, 15, 0.1], haiku: [1, 2] } }]
    for (const fast of [false, true]) {
      for (const big of [false, true]) {
        const raw = { input_tokens: 1000 + (big ? 200_000 : 0), output_tokens: 500, cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 9000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 2000 },
          speed: fast ? 'fast' : 'standard' }
        const tu = tokenUsage({ inputTokens: raw.input_tokens, outputTokens: 500, cacheCreationTokens: 3000,
          cacheReadTokens: 9000, cacheCreation1hTokens: 1000, fast })
        for (const model of names) {
          for (const cfg of cfgs) {
            close(pricing.usageCostUsd(tu, model, cfg), statusline.usageCostUsd(raw, model, cfg),
              `${model} fast=${fast} big=${big} cfg=${Object.keys(cfg).length}`)
          }
        }
      }
    }
  })

  test('versions are priced separately', () => {
    const cases: Record<string, [number, number, number]> = {
      'claude-fable-5-2': [8, 40, 0.20], 'claude-mythos-5-2': [8, 40, 0.20],
      'claude-fable-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1.00],
      'claude-fable-5-20260101': [10, 50, 1.00],                     // a date is not version 5.2
      'claude-opus-5-5': [4, 20, 0.20], 'claude-opus-5': [5, 25, 0.50], 'claude-opus-4-8': [5, 25, 0.50],
      'claude-opus-4-1-20250805': [15, 75, 1.50], 'claude-opus-4-20250514': [15, 75, 1.50],
      'claude-opus-4-5@20251101': [5, 25, 0.50], 'claude-sonnet-5-5': [2, 10, 0.10],
      'claude-sonnet-5': [2, 10, 0.20], 'us.anthropic.claude-sonnet-4-5-20250929-v1:0': [3, 15, 0.30],
      'claude-haiku-5-5': [0.10, 0.50, 0.01], 'claude-haiku-4-5-20251001': [1, 5, 0.10],
      'claude-3-5-haiku-20241022': [0.80, 4, 0.08], 'Opus 4.8': [5, 25, 0.50],
      'Sonnet 5.5': [2, 10, 0.10], 'claude-opus-5-5[1m]': [4, 20, 0.20],
    }
    for (const [model, [pin, pout, pread]] of Object.entries(cases)) {
      const r = pricing.ratesFor(model, {})
      assert.deepEqual([r.input, r.output], [pin, pout], model)
      close(r.cache_read, pread, model)
    }
  })

  test('fallbacks for unlisted models', () => {
    assert.equal(pricing.ratesFor('gpt-5', {}).input, 2.5)
    assert.equal(pricing.ratesFor('claude-opus-9-9', {}).input, 5.0)      // family fallback
    const r = pricing.ratesFor('mystery', {})
    assert.deepEqual([r.input, r.output], pricing.DEFAULT_PRICE)
  })

  test('long-prompt tier, fast mode and overrides', () => {
    close(pricing.usageCostUsd(tokenUsage({ inputTokens: 1_000_000 }), 'claude-haiku-5-5', {}), 0.50)
    close(pricing.usageCostUsd(tokenUsage({ inputTokens: 100_000 }), 'claude-haiku-5-5', {}), 0.01)
    close(pricing.usageCostUsd(tokenUsage({ inputTokens: 1_000_000, fast: true }), 'claude-opus-5-5', {}), 8.0)
    let r = pricing.ratesFor('claude-opus-5-5', { prices: { 'opus-5-5': [3, 15, 0.1] } })
    assert.deepEqual([r.input, r.output, r.cache_read], [3, 15, 0.1])
    r = pricing.ratesFor('claude-opus-5-5', { prices: { opus: [1, 2], 'opus-5-5': [3, 15] } })
    assert.equal(r.input, 3)                                             // most specific override wins
    const cache = tokenUsage({ cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 400_000, cacheReadTokens: 1_000_000 })
    close(pricing.usageCostUsd(cache, 'claude-fable-5-2', {}), 0.6 * 10 + 0.4 * 16 + 0.20)   // the file's own cache-write prices
  })
})

describe('currency', () => {
  const clean: Env = { AGENTARIUM_HOME: '/nonexistent', AGENTARIUM_CURRENCY: undefined, AGENTARIUM_USD_GBP: undefined, AGENTARIUM_USD_EUR: undefined }

  test('the block matches the status line copy', () => {
    const block = (path: string) => {
      const text = readFileSync(path, 'utf8')
      const start = text.indexOf('\n', text.indexOf('// BEGIN CURRENCY')) + 1
      return text.slice(start, text.indexOf('// END CURRENCY'))
    }
    assert.equal(block(join(ROOT, 'agentarium', 'engine', 'currency.ts')), block(join(SCRIPTS, 'statusline.ts')))
  })

  test('choice and aliases', () => withEnv(clean, () => {
    assert.deepEqual(currency.current(), ['GBP', '£', 0.76])              // default unchanged
    for (const [spelling, code] of [['usd', 'USD'], ['$', 'USD'], ['Euro', 'EUR'], ['€', 'EUR'], ['£', 'GBP'],
      [' pounds ', 'GBP'], ['yen', null], ['', null]] as [string, string | null][]) {
      assert.equal(currency.currencyCode(spelling), code, spelling)
    }
    assert.deepEqual(currency.current({ currency: 'eur' }), ['EUR', '€', 0.86])
    assert.deepEqual(currency.current({ currency: 'USD', usd_gbp: 0.5 }), ['USD', '$', 1.0])
    assert.equal(currency.current({ currency: 'nonsense' })[0], 'GBP')
  }))

  test('env beats config, and rates', () => withEnv(clean, async () => {
    await withEnv({ AGENTARIUM_CURRENCY: 'EUR', AGENTARIUM_USD_EUR: '0.9' }, () => {
      assert.deepEqual(currency.current({ currency: 'USD', usd_eur: 0.8 }), ['EUR', '€', 0.9])
    })
    assert.deepEqual(currency.current({ currency: 'EUR', usd_eur: 0.8 }), ['EUR', '€', 0.8])
    assert.deepEqual(currency.current({ usd_gbp: 'bad' }), ['GBP', '£', 0.76])
  }))

  test('format', () => {
    assert.equal(currency.formatMoney(1234.5, '€'), '€1,235')
    assert.equal(currency.formatMoney(-3, '$'), '-$3.00')
    assert.equal(currency.formatMoney(250.4, '£'), '£250')
    assert.equal(currency.formatMoney(25, '£'), '£25.00')
    assert.equal(currency.formatMoney(25.01, '£'), '£25')
  })

  test('the status line shows the chosen currency', () => withEnv(clean, () => {
    const style = new statusline.Style('dark', false, true)
    const payload = { model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 2.0 }, context_window: { used_percentage: 10 } }
    for (const [cfg, want] of [[{}, '£1.52'], [{ currency: 'USD' }, '$2.00'], [{ currency: 'EUR' }, '€1.72']] as [object, string][]) {
      const c = { ...statusline.DEFAULT_CFG, ...cfg }
      assert.ok(statusline.render(statusline.gather(payload, c, {}), style, c).includes(want), want)
    }
  }))

  test('status line flags', (c) => {
    const t = useTemp(c)
    const env = t.env({ AGENTARIUM_HOME: t.home })
    const run = (...a: string[]) => runScript('statusline.ts', ['--no-color', ...a], { input: JSON.stringify({ cost: { total_cost_usd: 1.0 } }), env })
    assert.ok(run('--currency', 'usd').stdout.includes('$1.00'))
    assert.ok(run().stdout.includes('£0.76'))
    assert.ok(run('--set-currency', '€').stdout.includes('now show in EUR'))
    assert.ok(run().stdout.includes('€0.86'))
    assert.equal(JSON.parse(readFileSync(join(t.home, 'statusline.json'), 'utf8')).currency, 'EUR')
    assert.equal(run('--set-currency', 'yen').status, 1)
  })

  test('the message stands in for the band in the apps', (c) => {
    // The CLI status line is the terminal's; in the apps, where mods can't run, the Stop hook
    // posts the line. It goes with the band, not with the CLI status line being installed.
    const t = useTemp(c)
    const claudeDir = join(t.home, '.claude')
    const tx = writeTranscript(t.home, 's1', [user('hi'), sonnetMsg('m1')])
    const payload = JSON.stringify({ session_id: 's1', transcript_path: tx, hook_event_name: 'Stop' })
    const run = (entry: string, args: string[], extra: Env = {}) => runScript('statusline.ts', args, { input: payload,
      env: t.env({ AGENTARIUM_HOME: join(t.home, '.agentarium'), CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_ENTRYPOINT: entry, ...extra }) })

    for (const entry of ['claude-desktop', 'claude-vscode', 'jetbrains']) {
      const p = run(entry, ['--message'])
      assert.equal(p.status, 0)
      const msg = JSON.parse(p.stdout).systemMessage
      assert.ok(msg.includes('Claude Sonnet 5.5'))
      assert.ok(msg.includes('~£2.28'))                        // (1M in @2 + 0.1M out @10) * 0.76
      assert.ok(!msg.includes('\x1b'))                         // plain text, no ANSI
    }
    assert.equal(run('cli', ['--message']).stdout, '')         // the terminal has the CLI status line
    assert.equal(run('', ['--message']).stdout, '')
    assert.equal(run('claude-desktop', ['--message'], { AGENTARIUM_BAND: 'off' }).stdout, '')

    // someone else's CLI status line doesn't matter to the apps
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { command: 'other.sh' } }))
    assert.ok(run('claude-desktop', ['--message']).stdout.includes('systemMessage'))

    // --band-off is saved and wins until --band-on
    assert.ok(run('cli', ['--band-off']).stdout.includes('now off'))
    assert.equal(run('claude-desktop', ['--message']).stdout, '')
    assert.ok(run('cli', ['--status']).stdout.includes('band row (desktop app, VS Code): off'))
    assert.ok(run('claude-desktop', ['--message'], { AGENTARIUM_BAND: 'on' }).stdout.includes('systemMessage'))
    run('cli', ['--band-on'])
    assert.ok(run('claude-desktop', ['--message']).stdout.includes('systemMessage'))
  })

  test('JSON for the band', (c) => {
    // hooks/band.tsx draws from --json; once it has drawn a session, --message stays quiet.
    const t = useTemp(c)
    const claudeDir = join(t.home, '.claude')
    const tx = writeTranscript(t.home, 's2', [user('hi'), sonnetMsg('m1')])
    const payload = JSON.stringify({ session_id: 's2', transcript_path: tx })
    const base = { AGENTARIUM_HOME: join(t.home, '.agentarium'), CLAUDE_CONFIG_DIR: claudeDir }
    const run = (args: string[], extra: Env = {}) => runScript('statusline.ts', args, { input: payload,
      env: t.env({ ...base, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ...extra }) })

    assert.equal(JSON.parse(run(['--json']).stdout).show, true)        // read, not drawn yet (or VS Code)
    assert.ok(run(['--message']).stdout.includes('systemMessage'))      // so the message still comes
    const line = JSON.parse(run(['--json', '--band', 's2']).stdout)
    assert.equal(line.show, true)
    assert.deepEqual([line.model, line.cost, line.level], ['Claude Sonnet 5.5', '~£2.28', 'red'])   // 1M tokens: a full window
    assert.equal([...line.gauge].length, 12)
    assert.equal(line.ttl, 300)
    assert.equal(run(['--message']).stdout, '')                         // the band shows it instead
    assert.deepEqual(JSON.parse(run(['--json', '--band', 's2'], { AGENTARIUM_BAND: 'off' }).stdout), { show: false })
    // the band passes the engine's own figures ($.session.usage): exact cost, its context %
    const exact = runScript('statusline.ts', ['--json'], { env: t.env(base), input: JSON.stringify({
      transcript_path: tx, model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 2.0 },
      context_window: { used_percentage: 40, context_window_size: 200000 } }) })
    const got = JSON.parse(exact.stdout)
    assert.deepEqual([got.cost, got.pct, got.level], ['£1.52', 40, 'green'])
  })

  test('a static render says when the cache goes cold', () => {
    const style = new statusline.Style('dark', false)
    const info = { model: 'm', total: 1, cost: 0, symbol: '£', estimated: false, pct: 1, ttl: 300, remaining: 120 }
    assert.ok(statusline.render(info, style, statusline.DEFAULT_CFG, true).includes('(cold at '))
    assert.ok(!statusline.render(info, style, statusline.DEFAULT_CFG).includes('cold at'))
  })
})

describe('the band outlook: prevention, not a receipt', () => {
  const cfg = { ...statusline.DEFAULT_CFG, currency: 'GBP', usd_gbp: 0.76 }
  const info = (extra: Partial<statusline.Info> = {}, raw: object = {}): statusline.Info => ({
    model: 'Opus 5.5', total: 4e6, cost: 1.46, symbol: '£', estimated: false, pct: 79.5, ttl: 300, remaining: 250, ...extra,
    raw: { modelId: 'claude-opus-5-5', ctx: 159_000, window: 200_000, requests: 40, output: 60_000, rate: 0.76, ...raw },
  })
  const noBudget = { AGENTARIUM_BUDGET_DAILY: undefined, AGENTARIUM_BUDGET_SESSION: undefined, AGENTARIUM_BUDGET_MODE: undefined,
    AGENTARIUM_BUDGET_MONTHLY: undefined, AGENTARIUM_BUDGET_RESET_DAY: undefined, AGENTARIUM_BUDGET_WORKDAYS: undefined,
    AGENTARIUM_BUDGET_DAYS_OFF: undefined }

  test('forecasts the next steps and what a cold cache would add', async () => {
    await withEnv(noBudget, () => {
      const o = statusline.outlook(info(), cfg)!
      // Opus 5.5: 159k read at $0.20/M, ~4k written at $5/M, ~1.5k out at $20/M, x0.76
      close(o.step, (159_000 * 0.2 + 3_975 * 5 + 1_500 * 20) / 1e6 * 0.76)
      assert.ok(o.forecast > o.step * 10)                  // the context keeps growing
      close(o.at_risk, 159_000 * (5 - 0.2) / 1e6 * 0.76)
      assert.equal(o.budget, null)
      assert.equal(o.tip?.kind, 'compact')                 // a full context, a warm cache
    })
  })

  test('the tip follows the cache: keep it warm, then /clear once it is cold', async () => {
    await withEnv(noBudget, () => {
      const cooling = statusline.outlook(info({ remaining: 100 }), cfg)!
      assert.equal(cooling.tip?.kind, 'warm')
      close(cooling.tip!.saves, cooling.at_risk)
      const cold = statusline.outlook(info({ remaining: 0 }), cfg)!
      assert.equal(cold.cold, true)
      assert.equal(cold.tip?.action, '/clear')
      assert.ok(cold.tip!.saves > cold.at_risk)            // the rebuild and every re-read after it
      assert.equal(statusline.outlook(info({ remaining: null }), cfg)!.at_risk, 0)   // nothing cached
    })
  })

  test('no context, no forecast; a small warm session gets no tip', async () => {
    await withEnv(noBudget, () => {
      assert.equal(statusline.outlook(info({}, { ctx: 0 }), cfg), null)
      assert.equal(statusline.outlook({ ...info(), raw: undefined }, cfg), null)
      assert.equal(statusline.outlook(info({ pct: 10 }, { ctx: 20_000 }), cfg)!.tip, null)
    })
  })

  test('budget left: the tighter limit, in steps', async () => {
    await withEnv({ ...noBudget, AGENTARIUM_BUDGET_DAILY: '£5', AGENTARIUM_BUDGET_SESSION: '3' }, () => {
      const o = statusline.outlook(info(), cfg, { daySpentUsd: 6.2 })!
      assert.equal(o.budget?.kind, 'daily')                // £0.29 left today beats £1.54 left this session
      close(o.budget!.left, 5 - 6.2 * 0.76)
      assert.equal(o.budget!.steps_left, Math.floor(o.budget!.left / o.step))
      const json = statusline.outlookJson(o, '£')!
      assert.deepEqual([json.budget.left, json.budget.used_pct, json.budget.over], ['£0.29', 94, false])
      const s = statusline.outlook(info(), cfg, { daySpentUsd: 0 })!
      assert.equal(s.budget?.kind, 'session')
      close(s.budget!.left, 3 - 1.46)
    })
    await withEnv({ ...noBudget, AGENTARIUM_BUDGET_SESSION: '1', AGENTARIUM_BUDGET_MODE: 'off' }, () => {
      assert.equal(statusline.outlook(info(), cfg)!.budget, null)
    })
  })

  test('a tight budget on a pricey model suggests a cheaper one, when switching pays', async () => {
    await withEnv({ ...noBudget, AGENTARIUM_BUDGET_SESSION: '1.6' }, () => {
      // a small context: re-caching it on Sonnet is cheap, so the switch saves money
      const o = statusline.outlook(info({ cost: 1.5, pct: 5 }, { ctx: 10_000, requests: 10, output: 40_000 }), cfg)!
      assert.ok(o.budget!.steps_left! < 10)
      assert.equal(o.tip?.action, '/model sonnet')
      // a big one: re-writing 159k tokens to Sonnet's cache costs more than it saves
      const big = statusline.outlook(info({ cost: 1.5 }), cfg)!
      assert.notEqual(big.tip?.kind, 'model')
    })
  })

  test('the terminal status line shows the forecast row under the line', async (c) => {
    const style = new statusline.Style('dark', false)
    await withEnv({ ...noBudget, AGENTARIUM_BUDGET_DAILY: '£5' }, () => {
      const i = info({ remaining: 100 })
      const row = statusline.renderOutlook(statusline.outlook(i, cfg, { daySpentUsd: 6.2 }), i, style)
      assert.match(row, /^↳ £\d+\.\d\d next 10 steps/)
      assert.ok(row.includes('£0.29 left today · ~'), row)
      assert.ok(row.includes('at risk if the cache goes cold'), row)
      assert.ok(row.includes('→ reply within 01:40 saves ~£'), row)
      const cold = info({ remaining: 0 })
      const coldRow = statusline.renderOutlook(statusline.outlook(cold, cfg, { daySpentUsd: 7 }), cold, style)
      assert.ok(coldRow.includes('cache cold · next prompt') && coldRow.includes('→ /clear saves'), coldRow)
      assert.ok(coldRow.includes('£5.00 spent budget today · over'), coldRow)
      assert.equal(statusline.renderOutlook(null, i, style), '')
    })
    const t = useTemp(c)
    const tx = writeTranscript(t.home, 's4', [user('hi'), sonnetMsg('m1')])
    const run = (extra: Record<string, string> = {}) => runScript('statusline.ts', ['--no-color'], {
      input: JSON.stringify({ session_id: 's4', transcript_path: tx }),
      env: t.env({ AGENTARIUM_HOME: join(t.home, '.agentarium'), ...extra }) }).stdout.split('\n')
    const lines = run()
    assert.equal(lines.length, 2)
    assert.match(lines[1], /next 10 steps/)
    assert.equal(run({ AGENTARIUM_OUTLOOK: 'off' }).length, 1)
  })

  test('--json carries the outlook to the band', (c) => {
    const t = useTemp(c)
    const tx = writeTranscript(t.home, 's3', [user('hi'), sonnetMsg('m1')])
    const out = runScript('statusline.ts', ['--json'], { input: JSON.stringify({ session_id: 's3', transcript_path: tx }),
      env: t.env({ AGENTARIUM_HOME: join(t.home, '.agentarium'), AGENTARIUM_BUDGET_SESSION: '10' }) })
    const o = JSON.parse(out.stdout).outlook
    assert.equal(o.steps, 10)
    assert.match(o.forecast, /^£\d/)
    assert.equal(o.budget.kind, 'session')
    assert.equal(o.tip.action, '/compact')                // a 1M-token context: compact first
  })
})

describe('cost recording', () => {
  async function finalize(t: ReturnType<typeof useTemp>, records: object[]) {
    const path = writeTranscript(t.home, 'c1', records)
    await session.finalize(getAdapter('claude-code'), { session_id: 'c1', transcript_path: path, hook_event_name: 'Stop' },
      settings({ dbPath: t.db }))
  }

  test('cost and daily increments', async (c) => {
    const t = useTemp(c)
    await finalize(t, [user('hi'), sonnetMsg('m1')])
    const r = t.session('c1')!
    assert.equal(r.model, 'claude-sonnet-5-5')
    close(r.cost_usd, 2.0 + 1.0)                                         // 1M in @2 + 0.1M out @10
    await finalize(t, [user('hi'), sonnetMsg('m1'), sonnetMsg('m2')])    // one more turn
    close(t.session('c1')!.cost_usd, 6.0)
    const events = t.rows("SELECT usd FROM cost_events WHERE session_id='c1' ORDER BY id")
    assert.deepEqual(events.map((e) => Math.round(e.usd * 100) / 100), [3, 3])
    await finalize(t, [user('hi'), sonnetMsg('m1'), sonnetMsg('m2')])    // nothing new: no event
    assert.equal(t.rows('SELECT * FROM cost_events').length, 2)
  })

  test('a model switch is priced per model', async (c) => {
    const t = useTemp(c)
    const opus = assistant('m2', [], SONNET)
    opus.message.model = 'claude-opus-4-6'
    await finalize(t, [user('hi'), sonnetMsg('m1'), opus])
    close(t.session('c1')!.cost_usd, 3.0 + 7.5)                          // Sonnet 5.5 + Opus 4.6
  })

  test('Copilot is never priced', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db })
    const cp = getAdapter('copilot')
    session.recordPrompt(cp, { sessionId: 'g', prompt: 'add a cli' }, s)
    await session.finalize(cp, { sessionId: 'g' }, s)
    assert.equal(t.session('g')!.cost_usd, null)
    assert.deepEqual(t.rows('SELECT * FROM cost_events'), [])
  })
})

describe('diet rules', () => {
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    writeFileSync(join(t.home, 'package-lock.json'), 'x'.repeat(200_000))
    writeFileSync(join(t.home, 'small.lock'), 'x')
    writeFileSync(join(t.home, 'app.log'), 'x'.repeat(200_000))
    writeFileSync(join(t.home, 'app.py'), 'x'.repeat(200_000))
    return t
  }

  test('shell rules', (c) => {
    const t = setup(c)
    const cases: Record<string, string | null> = {
      'kubectl logs api-7f9': 'unbounded-logs',
      'kubectl -n prod logs api': 'unbounded-logs',
      'kubectl logs api --tail=200': null,
      'kubectl logs api --since 10m': null,
      'kubectl logs api | grep ERROR': null,
      'kubectl logs api > /tmp/api.log': null,
      'docker logs web': 'unbounded-logs',
      'docker logs -n 50 web': null,
      'docker compose logs': 'unbounded-logs',
      'journalctl -u nginx': 'unbounded-logs',
      'journalctl -u nginx -n 100': null,
      'git log': 'unbounded-git-log',
      'cd repo && git log -p': 'unbounded-git-log',
      'git log --oneline -20': null,
      'git log -n5': null,
      'git log main..feature': null,
      'git status && git diff': null,
      "find / -name '*.conf'": 'unbounded-find',
      'find / -maxdepth 2 -name x': null,
      "find . -name '*.py'": null,
      'ls -laR': 'recursive-listing',
      'ls -la': null,
      tree: 'recursive-listing',
      'tree -L 2': null,
      'cat app.log': 'large-cat',
      'sudo cat package-lock.json': 'large-cat',
      'cat small.lock': null,
      'cat missing.txt': null,
      'cat app.log # diet-ok': null,
      'head -50 app.log': null,
      "echo 'unterminated": null,
      '': null,
    }
    for (const [cmd, want] of Object.entries(cases)) {
      assert.equal(diet.check(toolCall('Bash', TOOL_SHELL, { command: cmd }), t.home)?.rule ?? null, want, cmd)
    }
  })

  test('read rules', async (c) => {
    const t = setup(c)
    const read = (name: string, ranged = false) => diet.check(toolCall('Read', TOOL_READ, { path: name, ranged }), t.home)?.rule ?? null
    assert.equal(read(join(t.home, 'package-lock.json')), 'generated-file')
    assert.equal(read(join(t.home, 'package-lock.json'), true), null)
    assert.equal(read(join(t.home, 'app.py')), null)                     // big but hand-written: Claude caps it
    assert.equal(read(join(t.home, 'small.lock')), null)
    assert.equal(read(join(t.home, 'nope.min.js')), null)
    await withEnv({ AGENTARIUM_DIET_MAX_KB: '1000' }, () => assert.equal(read(join(t.home, 'package-lock.json')), null))
  })

  test('adapters map reads', () => {
    const cc = getAdapter('claude-code')
    const cp = getAdapter('copilot')
    const a = cc.toolCall({ tool_name: 'Read', tool_input: { file_path: '/x/a', limit: 10 } })!
    assert.deepEqual([a.kind, a.path, a.ranged], [TOOL_READ, '/x/a', true])
    const b = cp.toolCall({ toolName: 'view', toolArgs: JSON.stringify({ path: '/x/a' }) })!
    assert.deepEqual([b.kind, b.path, b.ranged], [TOOL_READ, '/x/a', false])
    const c = cp.toolCall({ toolName: 'str_replace_editor', toolArgs: { command: 'view', path: '/x/a', view_range: [1, 20] } })!
    assert.deepEqual([c.kind, c.ranged], [TOOL_READ, true])
  })
})

describe('diet hook', () => {
  function runHook(t: ReturnType<typeof useTemp>, source: string, payload: unknown, env: Env = {}) {
    const p = runScript('diet.ts', [source], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: t.env(env) })
    assert.deepEqual([p.status, p.stderr], [0, ''])
    return p.stdout.trim() ? JSON.parse(p.stdout) : null
  }

  test('Claude: deny and log', (c) => {
    const t = useTemp(c)
    const out = runHook(t, 'claude-code', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'kubectl logs api' } })
    const hso = out.hookSpecificOutput
    assert.deepEqual([hso.hookEventName, hso.permissionDecision], ['PreToolUse', 'deny'])
    assert.ok(hso.permissionDecisionReason.includes('--tail'))
    assert.deepEqual(t.rows('SELECT session_id, rule, action FROM diet_events'), [{ session_id: 's', rule: 'unbounded-logs', action: 'denied' }])
  })

  test('Copilot: deny', (c) => {
    const t = useTemp(c)
    const out = runHook(t, 'copilot', { sessionId: 'g', toolName: 'bash', toolArgs: JSON.stringify({ command: 'git log' }) })
    assert.equal(out.permissionDecision, 'deny')
  })

  test('modes and bad input', (c) => {
    const t = useTemp(c)
    const bad = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'git log' } }
    assert.deepEqual(Object.keys(runHook(t, 'claude-code', bad, { AGENTARIUM_DIET: 'warn' })), ['systemMessage'])
    assert.equal(runHook(t, 'claude-code', bad, { AGENTARIUM_DIET: 'off' }), null)
    assert.equal(runHook(t, 'claude-code', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null)
    for (const payload of ['', 'nope', '[1]', '{}']) {
      for (const src of ['claude-code', 'copilot', 'other']) assert.equal(runHook(t, src, payload), null)
    }
  })
})

describe('budget', () => {
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    const db = store.connect(t.db)
    c.after(() => db.close())
    const spend = (sid: string, usd: number) => {
      store.upsert(db, sid, 'claude-code', null, 0, 0, 1, false, () => 'unknown')
      store.setCost(db, sid, usd, 'claude-sonnet')
    }
    const check = (sid: string, prompt: string, l: Partial<budget.Limits>) => budget.check(db, sid, prompt, budget.limits(l))
    return { t, db, spend, check }
  }
  const envs = (t: ReturnType<typeof useTemp>, extra: Env = {}) => ({ AGENTARIUM_USD_GBP: '1', AGENTARIUM_HOME: t.home, AGENTARIUM_CURRENCY: undefined, ...extra })

  test('inactive without limits', (c) => {
    const { spend, check } = setup(c)
    spend('a', 100)
    assert.equal(check('a', 'hi', {}), null)
  })

  test('warn, then block, then override', (c) => {
    const { t, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      spend('a', 8.5)
      const d = check('a', 'next', { daily: 10 })!
      assert.equal(d.action, 'warned')
      assert.ok(d.message.includes('85%'))
      assert.equal(check('a', 'again', { daily: 10 }), null)               // warned once only
      spend('a', 10.5)
      const b = check('a', 'do the thing', { daily: 10 })!
      assert.equal(b.action, 'blocked')
      assert.ok(b.message.includes('£10.50'))
      assert.equal(check('a', 'something else', { daily: 10 })!.action, 'blocked')
      assert.equal(check('a', 'something else', { daily: 10 }), null)      // same prompt again = carry on
      assert.equal(check('a', 'more', { daily: 10 }), null)                // not paused again today
    })
  })

  test('prefix bypass, and the daily limit sums sessions', (c) => {
    const { t, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      spend('a', 6)
      spend('b', 6)
      assert.equal(check('c', 'hi', { daily: 10 })!.action, 'blocked')
      assert.equal(check('c', 'over-budget: hi', { daily: 10 }), null)
    })
  })

  test('the session limit is per session', (c) => {
    const { t, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      spend('a', 6)
      assert.equal(check('a', 'hi', { session: 5 })!.action, 'blocked')
      assert.equal(check('b', 'hi', { session: 5 }), null)
    })
  })

  test('limits and messages in the chosen currency', (c) => {
    const { t, spend, check } = setup(c)
    return withEnv(envs(t), async () => {
      spend('a', 10)                                                       // $10 spent
      const d = await withEnv({ AGENTARIUM_CURRENCY: 'EUR', AGENTARIUM_USD_EUR: '0.9' }, () => check('a', 'hi', { daily: 8 }))!  // €9 > €8
      assert.equal(d!.action, 'blocked')
      assert.ok(d!.message.includes('€9.00, over the €8.00 limit'))
      const row = t.rows("SELECT spent, limit_amount, currency FROM budget_events WHERE action='blocked'")[0]
      assert.deepEqual([Math.round(row.spent * 100) / 100, row.limit_amount, row.currency], [9, 8, 'EUR'])
      await withEnv({ AGENTARIUM_CURRENCY: 'USD' }, () => assert.equal(check('b', 'hi', { daily: 12 })!.action, 'warned'))   // $10 of $12
    })
  })

  test('limit values accept symbols', () => withEnv({ AGENTARIUM_BUDGET_DAILY: '€1,500', AGENTARIUM_BUDGET_SESSION: '$5' }, () => {
    const lim = budget.loadLimits()
    assert.deepEqual([lim.daily, lim.session], [1500, 5])
  }))

  test('an old budget table is migrated', (c) => {
    const { t, db, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      db.exec(`CREATE TABLE budget_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
               ts TEXT, day TEXT, kind TEXT, action TEXT, spent_gbp REAL, limit_gbp REAL, digest TEXT)`)
      spend('a', 20)
      assert.equal(check('a', 'hi', { daily: 10 })!.action, 'blocked')
    })
  })

  test('warn mode never blocks', (c) => {
    const { t, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      spend('a', 20)
      const d = check('a', 'hi', { daily: 10, mode: 'warn' })!
      assert.equal(d.action, 'warned')
      assert.ok(!d.message.includes('same prompt again'))
      assert.equal(check('a', 'hi', { daily: 10, mode: 'warn' }), null)
    })
  })

  test('a monthly allowance used up pauses the day, and says why', (c) => {
    const { t, db, spend, check } = setup(c)
    return withEnv(envs(t), () => {
      spend('a', 5)                                                        // today's £5 is past any share of £1
      const b = check('a', 'hi', { monthly: 1 })!
      assert.equal(b.action, 'blocked')
      assert.ok(b.message.includes('monthly allowance left over'), b.message)
      assert.ok(budget.active(budget.limits({ monthly: 500 })))
      assert.equal(budget.pressure(db, 'a', budget.limits({ monthly: 1 }))?.kind, 'daily')
    })
  })

  test('the hook end to end', (c) => {
    const { t, spend } = setup(c)
    spend('a', 50)
    const payload = JSON.stringify({ session_id: 'a', prompt: 'hi' })
    const run = (src: string, e: Env = {}) => runScript('budget.ts', [src], { input: payload, env: t.env({ AGENTARIUM_USD_GBP: '1', ...e }) })
    assert.equal(run('claude-code').stdout, '')                          // no limit set
    assert.equal(JSON.parse(run('claude-code', { AGENTARIUM_BUDGET_DAILY: '10' }).stdout).decision, 'block')
    assert.equal(run('copilot', { AGENTARIUM_BUDGET_DAILY: '10' }).stdout, '')   // cannot block there
    assert.ok(runScript('budget.ts', ['status'], { env: t.env({ AGENTARIUM_USD_GBP: '1' }) }).stdout.includes('Spent today: £50 (GBP)'))
  })
})

describe('store', () => {
  test('a transaction commits together, and rolls back on an error', (c) => {
    const t = useTemp(c)
    const db = store.connect(t.db)
    c.after(() => db.close())
    db.transaction(() => store.addPromptEvent(db, 'a', 1, 0, 'opex', null))
    assert.throws(() => db.transaction(() => {
      store.addPromptEvent(db, 'b', 1, 0, 'opex', null)
      throw new Error('boom')
    }), /boom/)
    assert.deepEqual(t.rows('SELECT session_id FROM prompt_events'), [{ session_id: 'a' }])
  })
})

describe('spend report', () => {
  test('empty', (c) => {
    const t = useTemp(c)
    const r = report.build(join(t.home, 'none.db'), 7, ['GBP', '£', 1.0])
    assert.equal(r.reason, 'no-database')
    assert.ok(report.markdown(r).includes('No database'))
  })

  test('the full report', async (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 'r1', [user('write a python function and unit tests for the api'), sonnetMsg('m1')])
    await session.finalize(getAdapter('claude-code'), { session_id: 'r1', cwd: '/work/api', transcript_path: path, hook_event_name: 'SessionEnd' },
      settings({ dbPath: t.db }))
    const p = runScript('diet.ts', ['claude-code'], { env: t.env(),
      input: JSON.stringify({ session_id: 'r1', tool_name: 'Bash', tool_input: { command: 'git log' } }) })
    assert.equal(p.status, 0)
    const r = report.build(t.db, 7, ['GBP', '£', 1.0])
    assert.equal(r.empty, false)
    assert.equal(r.spend, 3.0)
    assert.equal(r.by_label.capex.sessions, 1)
    assert.equal(r.by_project[0].project, 'api')
    assert.equal(r.top_sessions[0].model, 'claude-sonnet-5-5')
    assert.equal(r.helpers.diet[0].rule, 'unbounded-git-log')
    const md = report.markdown(r)
    assert.ok(md.includes('**Spend: £3.00** GBP'))
    const eur = report.markdown(report.build(t.db, 7, ['EUR', '€', 0.5]))
    assert.ok(eur.includes('**Spend: €1.50** EUR'))
    assert.ok(!eur.includes('£'))
    assert.ok(md.includes('unbounded-git-log x1'))
    const out = JSON.parse(runScript('report.ts', ['--json', '--days', '0', '--currency', '$'], { env: t.env() }).stdout)
    assert.deepEqual([out.days, out.currency, out.spend], [0, 'USD', 3.0])
  })
})

describe('wiring', () => {
  test('the hooks and the skill are wired', () => {
    const cc = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')
    const cp = JSON.parse(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8'))
    const hooks = JSON.parse(cc).hooks
    assert.equal(hooks.PreToolUse[0].matcher, 'Read|Bash')
    assert.ok(cc.includes('diet.ts'))
    // prompt-time helpers run through the controller (one process, one decision per prompt)
    assert.ok(hooks.UserPromptSubmit.some((g: any) => g.hooks.some((h: any) => h.command.includes('controller.ts prompt'))))
    assert.ok(readFileSync(join(ROOT, 'scripts', 'controller.ts'), 'utf8').includes("import('./budget.ts')"))
    assert.ok(cp.hooks.preToolUse[0].bash.includes('diet.ts copilot'))
    assert.ok(readFileSync(join(ROOT, 'skills', 'spend-report', 'SKILL.md'), 'utf8').length)
  })
})

describe('monthly allowance', () => {
  const cal = (e: Record<string, string> = {}) => allowance.calendar(e)
  const day = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 10) }

  test('the billing period follows the reset day, clamped to short months', () => {
    assert.deepEqual(allowance.periodOf(day('2026-11-21'), 1), { start: '2026-11-01', end: '2026-12-01' })
    assert.deepEqual(allowance.periodOf(day('2026-11-10'), 15), { start: '2026-10-15', end: '2026-11-15' })
    assert.deepEqual(allowance.periodOf(day('2026-11-15'), 15), { start: '2026-11-15', end: '2026-12-15' })
    assert.deepEqual(allowance.periodOf(day('2027-02-28'), 31), { start: '2027-02-28', end: '2027-03-31' })
    assert.deepEqual(allowance.periodOf(day('2027-02-27'), 31), { start: '2027-01-31', end: '2027-02-28' })
    assert.deepEqual(allowance.periodOf(day('2027-01-05'), 20), { start: '2026-12-20', end: '2027-01-20' })
  })

  test('workdays and days off parse', () => {
    assert.deepEqual([...allowance.parseWorkdays(undefined)], [1, 2, 3, 4, 5])
    assert.deepEqual([...allowance.parseWorkdays('sun-thu')].sort(), [0, 1, 2, 3, 4])
    assert.deepEqual([...allowance.parseWorkdays('Mon, Wednesday,fri')].sort(), [1, 3, 5])
    assert.equal(allowance.parseWorkdays('all').size, 7)
    assert.deepEqual([...allowance.parseWorkdays('nonsense')], [1, 2, 3, 4, 5])
    assert.deepEqual(allowance.parseDaysOff('2026-12-31..2026-12-24, 2027-01-04, bad'),
      [['2026-12-24', '2026-12-31'], ['2027-01-04', '2027-01-04']])
  })

  test('a fortnight off at the start leaves more per day for the rest (#47)', () => {
    // November 2026: back on Monday the 16th, 11 working days to the reset on 1 December
    const c = cal()
    assert.equal(allowance.workingDaysLeft(day('2026-11-16'), c), 11)
    close(allowance.dailyShare(500, 0, 11), 500 / 11)                     // ~45/day, not 500/21 ~ 24
    // a heavy first week back leaves less for the rest
    assert.equal(allowance.workingDaysLeft(day('2026-11-23'), c), 6)
    close(allowance.dailyShare(500, 380, 6), 20)
    // holidays come off what's left; today counts even on a Saturday
    assert.equal(allowance.workingDaysLeft(day('2026-11-23'), cal({ AGENTARIUM_BUDGET_DAYS_OFF: '2026-11-26..2026-11-27' })), 4)
    assert.equal(allowance.workingDaysLeft(day('2026-11-28'), c), 2)
    assert.equal(allowance.dailyShare(500, 600, 3), 0)                      // over the allowance: nothing left
  })

  test('the daily limit comes from what is left, and a fixed daily limit still caps it', (c) => {
    const t = useTemp(c)
    const db = store.connect(t.db)
    c.after(() => db.close())
    db.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', 'x', 'ts', '2026-11-17', 100)
    db.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', 'x', 'ts', '2026-10-30', 999)   // last period
    db.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', 'x', 'ts', '2026-11-23', 50)    // today: not counted
    const at = day('2026-11-23')                                           // 6 working days left
    const d = budget.dailyCap(db, budget.limits({ monthly: 500 }), 1, '£', at)!
    close(d.cap, 400 / 6)
    assert.equal(d.days, 6)
    assert.ok(d.note!.includes('£400 of the £500 monthly allowance left over 6 working days to 2026-12-01'), d.note!)
    const capped = budget.dailyCap(db, budget.limits({ monthly: 500, daily: 20 }), 1, '£', at)!
    assert.deepEqual([capped.cap, capped.note], [20, null])
    assert.equal(budget.dailyCap(db, budget.limits({ daily: 20 }), 1, '£', at)!.cap, 20)
    assert.equal(budget.dailyCap(db, budget.limits({}), 1, '£', at), null)
  })

  test('the status line agrees with the engine', async () => {
    const envs = [{}, { AGENTARIUM_BUDGET_RESET_DAY: '31', AGENTARIUM_BUDGET_WORKDAYS: 'sun-thu' },
      { AGENTARIUM_BUDGET_RESET_DAY: '15', AGENTARIUM_BUDGET_DAYS_OFF: '2026-12-20..2027-01-02,2027-02-01' }]
    for (const e of envs) {
      await withEnv({ AGENTARIUM_BUDGET_RESET_DAY: undefined, AGENTARIUM_BUDGET_WORKDAYS: undefined, AGENTARIUM_BUDGET_DAYS_OFF: undefined, ...e }, () => {
        const a = allowance.calendar(), b = statusline.allowanceCalendar()
        assert.deepEqual(b, a)
        for (let x = day('2026-11-01'); x < day('2027-04-01'); x.setDate(x.getDate() + 3)) {
          assert.deepEqual(statusline.periodOf(x, a.resetDay), allowance.periodOf(x, a.resetDay))
          assert.equal(statusline.workingDaysLeft(x, b), allowance.workingDaysLeft(x, a))
        }
      })
    }
  })

  test('the status line shows what is left of today\'s share', () => withEnv({ AGENTARIUM_BUDGET_DAILY: undefined,
    AGENTARIUM_BUDGET_SESSION: undefined, AGENTARIUM_BUDGET_MODE: undefined, AGENTARIUM_BUDGET_MONTHLY: '500',
    AGENTARIUM_BUDGET_RESET_DAY: undefined, AGENTARIUM_BUDGET_WORKDAYS: undefined, AGENTARIUM_BUDGET_DAYS_OFF: undefined }, () => {
    const b = statusline.budgetLeft(0, 1, 1, 10, 100, day('2026-11-23'))!
    assert.equal(b.kind, 'daily')
    close(b.limit, 400 / 6)
    close(b.left, 400 / 6 - 10)
    const over = statusline.budgetLeft(0, 1, 1, 0, 600, day('2026-11-23'))!
    assert.deepEqual([over.limit, over.left <= 0], [0, true])
  }))
})
