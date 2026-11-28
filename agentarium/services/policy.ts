/**
 * PolicyEngine: budgets, thresholds and enforcement, decided once and expressed per platform.
 *
 * Every guard (budget, diet, groundhog, haggle, blinkers) does the same three things: read its mode
 * and thresholds from settings, decide, and turn the decision into hook output the platform
 * understands. The deciding stays with each guard's rules; the reading and the enforcing live here.
 *
 *   mode()        AGENTARIUM_<NAME> = block | ask | warn | off (anything else: the default)
 *   threshold()   a numeric setting with bounds
 *   enforce()     a decision -> the adapter's hook output. When a platform can't express an action it
 *                 falls back to the nearest one it can: ask -> deny with "ask the user first",
 *                 warn -> nothing (rather than block), so a missing feature never makes a guard stricter.
 *   activity()    what every guard and sommelier did over a window, read back from their event tables,
 *                 with the money each one kept from being spent (the dashboard's "What agentarium did")
 */
import type { Db } from '../engine/db.ts'
import type { PlatformAdapter } from '../platform/adapter.ts'
import type { Obj } from '../util.ts'
import * as events from '../engine/events.ts'

export { active as budgetActive, check as checkBudget, limits, loadLimits, type Decision as BudgetDecision, type Limits } from '../engine/budget.ts'

export type Action = 'allow' | 'warn' | 'context' | 'ask' | 'deny' | 'block' | 'interrupt'

/** AGENTARIUM_<name> as one of `allowed` (lower case), else `fallback`. */
export function mode(name: string, fallback: string, allowed: string[]): string {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  return allowed.includes(v) ? v : fallback
}

/** A numeric setting; currency symbols and commas are ignored. Out of range or missing: `fallback`. */
export function threshold(name: string, fallback: number, bounds: { min?: number, max?: number } = {}): number {
  const raw = (process.env[name] ?? '').trim().replace(/^[£€$]+/, '').replaceAll(',', '').replace(/%$/, '')
  const v = raw ? Number(raw) : NaN
  if (!Number.isFinite(v)) return fallback
  if (bounds.min !== undefined && v < bounds.min) return fallback
  if (bounds.max !== undefined && v > bounds.max) return fallback
  return v
}

export const isOff = (name: string) => (process.env[name] ?? '').trim().toLowerCase() === 'off'

/** A decision as the platform's hook output (null: nothing to print). */
export function enforce(adapter: PlatformAdapter, action: Action, message: string): Obj | null {
  switch (action) {
    case 'allow':
      return null
    case 'warn':
      return adapter.notify(message)
    case 'context':
      return adapter.addContext(message) ?? adapter.notify(message)
    case 'ask':
      return adapter.askTool(message) ??
        adapter.denyTool(`${message} Ask the user to confirm before doing this; if they agree, try again.`)
    case 'deny':
      return adapter.denyTool(message)
    case 'block':
      return adapter.blockPrompt(message)
    case 'interrupt':
      return adapter.interrupt(message) ?? adapter.denyTool(message)
  }
}

/** What actually happened once the platform's limits are applied (for the event log). */
export function effective(adapter: PlatformAdapter, action: Action): Action | 'none' {
  const out = enforce(adapter, action, '')
  if (out === null) return action === 'allow' ? 'allow' : 'none'
  if (action === 'ask' && adapter.askTool('') === null) return 'deny'
  return action
}

/** Log a guard's decision to its own event table (engine/events.ts). Never throws. */
export const log = events.log

// ---- what the guards did ------------------------------------------------------------------------

/** One helper's interventions over a window. Money is USD and estimated. */
export type Intervention = {
  helper: string
  /** Paused, refused, asked first, interrupted, routed or packed: it changed what happened. */
  stopped: number
  /** A notice only: the user or the agent decided. */
  flagged: number
  /** Spend it stopped and could price: sommelier's routes net of hand-offs, cache rebuilds refused, the cache
   *  writes colander's strained output never needed. */
  saved_usd: number
  /** What its notices priced, not counted as saved because carrying on was still an option. */
  at_stake_usd: number
  /** What it chose to spend more (sommelier sending a hard prompt up). */
  extra_usd: number
  /** Tokens kept out of the context (diet, colander, hold-up), carried into a new task (ballast) or a /clear skips (doggybag). */
  tokens: number
}
export type Activity = { since: string, saved_usd: number, stepped_in: number, helpers: Intervention[] }

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/** Per action: how many rows, and the sum of each of `cols` that the table has. */
function tally(db: Db, table: string, since: string, cols: string[] = [], day = 'ts'): Map<string, Record<string, number>> {
  const have = db.columns(table)
  const out = new Map<string, Record<string, number>>()
  if (!have.has('action') || !have.has(day)) return out
  const sums = cols.map((c) => (have.has(c) ? `COALESCE(SUM(${c}),0) AS ${c}` : `0 AS ${c}`))
  for (const r of db.all(`SELECT action, COUNT(*) AS n${sums.map((s) => `, ${s}`).join('')} FROM ${table} ` +
    `WHERE substr(${day},1,10) >= ? GROUP BY action`, since)) {
    out.set(String(r.action), Object.fromEntries([['n', Number(r.n) || 0], ...cols.map((c) => [c, Number(r[c]) || 0])]))
  }
  return out
}

/** Add up `field` over the actions named (a `told:3`-style action matches its prefix). */
function pick(t: Map<string, Record<string, number>>, actions: string[], field = 'n'): number {
  let v = 0
  for (const [action, row] of t) if (actions.some((a) => action === a || action.startsWith(`${a}:`))) v += row[field] ?? 0
  return v
}

/** What sommelier and every guard did since `since` (YYYY-MM-DD), biggest saving first. Helpers
 *  with nothing to report are left out; a table that isn't there yet counts as nothing. */
export function activity(db: Db, since: string): Activity {
  const tables = db.tables()
  const helpers: Intervention[] = []
  const add = (helper: string, x: Partial<Intervention>) => {
    const row: Intervention = { helper, stopped: 0, flagged: 0, saved_usd: 0, at_stake_usd: 0, extra_usd: 0, tokens: 0, ...x }
    for (const k of ['saved_usd', 'at_stake_usd', 'extra_usd'] as const) row[k] = round6(row[k])
    if (row.stopped || row.flagged) helpers.push(row)
  }
  const on = (table: string) => tables.has(table)

  if (on('sommelier_events')) {
    const t = tally(db, 'sommelier_events', since)
    const cols = db.columns('sommelier_events')
    // the same sums the status line, the band and the weekly report show
    const v = cols.has('saved_usd') ? db.get('SELECT COALESCE(SUM(CASE WHEN saved_usd>0 THEN saved_usd END),0) AS saved, ' +
      'COALESCE(-SUM(CASE WHEN saved_usd<0 THEN saved_usd END),0) AS extra FROM sommelier_events WHERE substr(ts,1,10) >= ?', since) : null
    add('sommelier', { stopped: pick(t, ['routed', 'routed-up', 'proxy-routed']), flagged: pick(t, ['warned', 'blocked']),
      saved_usd: Number(v?.saved) || 0, extra_usd: Number(v?.extra) || 0 })
  }
  if (on('cachebuster_events')) {
    const t = tally(db, 'cachebuster_events', since, ['usd'])
    add('cache-buster', { stopped: pick(t, ['deny', 'ask']), flagged: pick(t, ['warn']),
      saved_usd: pick(t, ['deny'], 'usd'), at_stake_usd: pick(t, ['ask', 'warn'], 'usd') })
  }
  if (on('diet_events')) {
    const t = tally(db, 'diet_events', since, ['est_tokens'])
    add('diet', { stopped: pick(t, ['denied']), flagged: pick(t, ['warned']), tokens: pick(t, ['denied'], 'est_tokens') })
  }
  if (on('colander_events')) {
    // tokens strained out of a result were never written to the cache: that write is the saving it can price
    const r = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(raw_tokens - kept_tokens),0) AS t, COALESCE(SUM(saved_usd),0) AS usd ' +
      "FROM colander_events WHERE substr(ts,1,10) >= ? AND action = 'strained'", since)
    add('colander', { stopped: Number(r?.n) || 0, tokens: Number(r?.t) || 0, saved_usd: Number(r?.usd) || 0 })
  }
  if (on('groundhog_events')) {
    const t = tally(db, 'groundhog_events', since)
    add('groundhog', { stopped: pick(t, ['denied', 'interrupted']), flagged: pick(t, ['warned']) })
  }
  if (on('blinkers_events')) {
    const t = tally(db, 'blinkers_events', since)
    add('blinkers', { stopped: pick(t, ['denied', 'asked']), flagged: pick(t, ['warned']) })
  }
  if (on('toomanycooks_events')) {
    const t = tally(db, 'toomanycooks_events', since, ['est_usd'])
    add('too-many-cooks', { stopped: pick(t, ['deny', 'ask']), flagged: pick(t, ['warn']),
      at_stake_usd: pick(t, ['deny', 'ask', 'warn'], 'est_usd') })
  }
  if (on('holdup_events')) {
    const t = tally(db, 'holdup_events', since, ['usd'])
    // a paste sent again after the pause went in after all: only the rest were kept out. A broad
    // prompt's own tokens are a few words, not what it kept out, so it counts as a pause only
    const kept = db.columns('holdup_events').has('kind') ? Number(db.get("SELECT COALESCE(SUM(CASE action WHEN 'block' THEN est_tokens " +
      "WHEN 'resent' THEN -est_tokens ELSE 0 END),0) AS t FROM holdup_events WHERE substr(ts,1,10) >= ? AND kind <> 'broad'", since)?.t) || 0 : 0
    add('hold-up', { stopped: pick(t, ['block']), flagged: pick(t, ['warn']), at_stake_usd: pick(t, ['block', 'warn'], 'usd'),
      tokens: Math.max(0, kept) })
  }
  if (on('ballast_events')) {
    const t = tally(db, 'ballast_events', since, ['ctx_tokens'])
    add('ballast', { stopped: pick(t, ['block']), flagged: pick(t, ['warn']), tokens: pick(t, ['block', 'warn'], 'ctx_tokens') })
  }
  if (on('budget_events')) {
    const t = tally(db, 'budget_events', since, [], 'day')
    add('budget', { stopped: pick(t, ['blocked']), flagged: pick(t, ['warned']) })
  }
  if (on('premium_events')) {
    const t = tally(db, 'premium_events', since)
    add('premium', { stopped: pick(t, ['paused']), flagged: pick(t, ['warned', 'would-pause']) })
  }
  if (on('contracts') && db.columns('contracts').has('day')) {
    const r = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cap_usd > 0 AND spent_usd >= cap_usd THEN 1 ELSE 0 END),0) AS held ' +
      'FROM contracts WHERE day >= ?', since)
    const n = Number(r?.n) || 0
    const held = Number(r?.held) || 0
    add('haggle', { stopped: held, flagged: n - held })
  }
  if (on('doggybag_events')) {
    const r = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(context_tokens),0) AS ctx, COALESCE(SUM(handoff_tokens),0) AS bag ' +
      'FROM doggybag_events WHERE substr(ts,1,10) >= ?', since)
    add('doggybag', { stopped: Number(r?.n) || 0, tokens: Math.max(0, (Number(r?.ctx) || 0) - (Number(r?.bag) || 0)) })
  }
  if (on('kettle_events')) {
    const t = tally(db, 'kettle_events', since, ['at_risk_usd'])
    add('kettle', { flagged: pick(t, ['told']), at_stake_usd: pick(t, ['told'], 'at_risk_usd') })
  }
  if (on('parrot_events')) {
    const t = tally(db, 'parrot_events', since)
    add('parrot', { flagged: pick(t, ['nudged']) })
  }

  // money first, then what changed what happened, then notices
  helpers.sort((a, b) => b.saved_usd - a.saved_usd || b.stopped - a.stopped || b.flagged - a.flagged)
  return {
    since,
    saved_usd: round6(helpers.reduce((a, h) => a + h.saved_usd, 0)),
    stepped_in: helpers.reduce((a, h) => a + h.stopped + h.flagged, 0),
    helpers,
  }
}
