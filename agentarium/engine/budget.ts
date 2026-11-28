/**
 * Spending limits: a daily and a per-session budget. Platform-independent.
 *
 * The daily limit can also come from a monthly allowance (AGENTARIUM_BUDGET_MONTHLY, see
 * engine/allowance.ts): what is left of it, spread over the working days left before it resets.
 * With both set, the lower of the two applies that day.
 *
 * Limits are amounts in the display currency (GBP by default; USD or EUR via AGENTARIUM_CURRENCY,
 * see engine/currency.ts). Spend is stored in USD and converted at the configured rate.
 *
 * Spend comes from the usage store (cost_usd per session, cost_events per day), which till
 * updates at every turn end, so the figure is at most one turn behind. Only token-billed
 * platforms have a cost; Copilot (premium requests) never counts towards a budget.
 *
 * At `warn` percent of a limit the user gets one notice per session per day. At 100% the next
 * prompt is paused once (mode "block") with three ways on: send the same prompt again, prefix it
 * with "over-budget:", or raise the limit. After an override the session is not paused again for
 * that limit that day.
 */
import { now, sha1, today } from '../util.ts'
import * as allowance from './allowance.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { inBudgetPhase, phaseFile } from '../profile.ts'
import * as currency from './currency.ts'
import type { Db } from './db.ts'
import * as store from './store.ts'

const BYPASS_RE = /^\s*over-budget:\s*/i

export type Limits = {
  daily: number | null          // in the display currency
  session: number | null
  monthly: number | null        // allowance per billing period, spread over the working days left
  calendar: allowance.Calendar
  warnPct: number
  mode: string                  // block | warn | off
}

export function limits(l: Partial<Limits> = {}): Limits {
  return { daily: null, session: null, monthly: null, calendar: allowance.calendar({}), warnPct: 80, mode: 'block', ...l }
}

export function active(l: Limits): boolean {
  return l.mode !== 'off' && Boolean(l.daily || l.session || l.monthly)
}

/** Today's daily limit (display currency): the fixed one, or the allowance's share of the working
 *  days left, whichever is lower. `note` says where an allowance-made limit came from. */
export type DailyCap = { cap: number, note: string | null, left: number | null, days: number | null }

export function dailyCap(db: Db, l: Limits, rate: number, symbol: string, d: Date = new Date()): DailyCap | null {
  if (!l.monthly) return l.daily ? { cap: l.daily, note: null, left: null, days: null } : null
  const { start, end } = allowance.periodOf(d, l.calendar.resetDay)
  const before = store.rangeCostUsd(db, start, today(d)) * rate
  const days = allowance.workingDaysLeft(d, l.calendar)
  const share = allowance.dailyShare(l.monthly, before, days)
  const left = Math.max(0, l.monthly - before)
  if (l.daily && l.daily <= share) return { cap: l.daily, note: null, left, days }
  const m = (v: number) => currency.formatMoney(v, symbol)
  return { cap: share, left, days,
    note: `${m(left)} of the ${m(l.monthly)} monthly allowance left over ${days} working day${days === 1 ? '' : 's'} to ${end}` }
}

function num(name: string): number | null {
  const raw = (process.env[name] ?? '').trim().replace(/^[£€$]+/, '').replaceAll(',', '')
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : null
}

export function loadLimits(): Limits {
  const mode = (process.env.AGENTARIUM_BUDGET_MODE ?? 'block').trim().toLowerCase()
  return limits({ daily: num('AGENTARIUM_BUDGET_DAILY'), session: num('AGENTARIUM_BUDGET_SESSION'),
    monthly: num('AGENTARIUM_BUDGET_MONTHLY'), calendar: allowance.calendar(),
    warnPct: num('AGENTARIUM_BUDGET_WARN') ?? 80, mode: ['block', 'warn', 'off'].includes(mode) ? mode : 'block' })
}

export type Decision = { action: 'warned' | 'blocked', message: string }

/** The budget_events table, with the columns newer versions added. */
export function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS budget_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, kind TEXT,
    action TEXT, spent REAL, limit_amount REAL, currency TEXT, digest TEXT)`)
  const have = db.columns('budget_events')
  for (const [col, typ] of [['spent', 'REAL'], ['limit_amount', 'REAL'], ['currency', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE budget_events ADD COLUMN ${col} ${typ}`)   // tables from before currencies were configurable
  }
}

function log(db: Db, sid: string, kind: string, action: string, spent: number, limit: number, code: string,
  digest: string | null = null): void {
  db.run('INSERT INTO budget_events(session_id,ts,day,kind,action,spent,limit_amount,currency,digest) VALUES(?,?,?,?,?,?,?,?,?)',
    sid, now(), today(), kind, action, spent, limit, code, digest)
}

function seen(db: Db, sid: string, kind: string, actions: string[]): { action: string, digest: string | null }[] {
  return db.all(`SELECT action, digest FROM budget_events WHERE session_id=? AND day=? AND kind=? ` +
    `AND action IN (${actions.map(() => '?').join(',')}) ORDER BY id DESC`, sid, today(), kind, ...actions) as any
}

/** Decide what to do with this prompt. Writes budget_events. */
export function check(db: Db, sid: string, prompt: string, l: Limits): Decision | null {
  if (!active(l)) return null
  ensure(db)
  const [code, symbol, rate] = currency.current()
  const money = (v: number) => currency.formatMoney(v, symbol)
  const spent: Record<string, number> = {
    session: (store.sessionCost(db, sid) ?? 0) * rate,
    daily: store.dayCostUsd(db) * rate,
  }
  const day = dailyCap(db, l, rate, symbol)
  const caps: Record<string, number | null> = { session: l.session, daily: day ? day.cap : null }
  const notes: Record<string, string> = { session: '', daily: day?.note ? ` (${day.note})` : '' }
  const digest = sha1(prompt.trim())
  const bypass = BYPASS_RE.test(prompt)
  for (const kind of ['daily', 'session']) {
    const cap = caps[kind]
    if (cap === null) continue          // 0 is a real limit: a monthly allowance used up
    const used = spent[kind]
    const what = kind === 'daily' ? "today's" : "this session's"
    if (used >= cap) {
      const history = seen(db, sid, kind, ['blocked', 'overridden', 'bypassed', 'over'])
      if (history.some((h) => h.action === 'overridden' || h.action === 'bypassed')) continue   // already chose to carry on today
      if (bypass) {
        log(db, sid, kind, 'bypassed', used, cap, code)
        continue
      }
      if (history.length && history[0].action === 'blocked' && history[0].digest === digest) {
        log(db, sid, kind, 'overridden', used, cap, code)
        continue
      }
      const msg = `agentarium budget: ${what} spend is ${money(used)}, over the ${money(cap)} limit${notes[kind]}. ` +
        "To carry on, send the same prompt again or start it with 'over-budget:'. " +
        'Cheaper ways on: /compact, a smaller model (/model), or a fresh session.'
      if (l.mode === 'warn') {
        if (history.length) continue
        log(db, sid, kind, 'over', used, cap, code)
        return { action: 'warned', message: msg.replace(" To carry on, send the same prompt again or start it with 'over-budget:'.", '') }
      }
      log(db, sid, kind, 'blocked', used, cap, code, digest)
      return { action: 'blocked', message: msg }
    }
    if (used >= cap * l.warnPct / 100 && !seen(db, sid, kind, ['warned']).length) {
      log(db, sid, kind, 'warned', used, cap, code)
      return { action: 'warned', message: `agentarium budget: ${what} spend is ${money(used)}, ` +
        `${(used / cap * 100).toFixed(0)}% of the ${money(cap)} limit${notes[kind]}.` }
    }
  }
  return null
}

export type Pressure = { kind: 'daily' | 'session', pct: number }

/** How hard the budget presses: the tighter limit's share spent, once it passes `warnPct`; null below
 *  that or with no limit set. sommelier reads it to route down harder before the limit is reached,
 *  so the pause at 100% is the last resort, not the first line of defence. */
/** With AGENTARIUM_BUDGET_PROFILE set (the opt-in), mark today in the phase file once the daily
 *  budget passes its warning share, so profile.ts switches to that profile from the next prompt
 *  for the rest of the day. -> true when today is marked. Never throws. */
export function markPhase(db: Db, l: Limits, file = phaseFile()): boolean {
  if (!(process.env.AGENTARIUM_BUDGET_PROFILE ?? '').trim()) return false
  try {
    const [, symbol, rate] = currency.current()
    const day = dailyCap(db, l, rate, symbol)
    if (!day || day.cap <= 0) return false
    const pct = store.dayCostUsd(db) * rate / day.cap * 100
    if (pct < l.warnPct) return false
    if (!inBudgetPhase(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ day: today(), pct: Math.round(pct) }) + '\n')
    }
    return true
  } catch {
    return false
  }
}

export function pressure(db: Db, sid: string, l: Limits): Pressure | null {
  if (!active(l)) return null
  const [, symbol, rate] = currency.current()
  const shares: Pressure[] = []
  const share = (used: number, cap: number) => (cap > 0 ? used / cap * 100 : 100)
  if (l.session) shares.push({ kind: 'session', pct: share((store.sessionCost(db, sid) ?? 0) * rate, l.session) })
  const day = dailyCap(db, l, rate, symbol)
  if (day) shares.push({ kind: 'daily', pct: share(store.dayCostUsd(db) * rate, day.cap) })
  const top = shares.reduce<Pressure | null>((a, b) => (!a || b.pct > a.pct ? b : a), null)
  return top && top.pct >= l.warnPct ? { kind: top.kind, pct: Math.round(top.pct) } : null
}
