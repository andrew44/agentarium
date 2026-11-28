/**
 * A monthly allowance, spread over the working days left in the billing period.
 *
 * With TOKENOMICS_BUDGET_MONTHLY set, the daily limit is worked out each day as
 *
 *     (allowance - spent so far this period, before today) / working days left (today included)
 *
 * so a month that starts with a fortnight off leaves more per day for the rest of it, and a heavy
 * week leaves less. It is a limit, not a target. Spend before today is used, so today's limit holds
 * still while you work. Today always counts as one working day, even on a weekend or a day off:
 * you are working now. The allowance resets on TOKENOMICS_BUDGET_RESET_DAY (1 by default; a reset
 * day past the end of a short month falls on its last day).
 *
 *   TOKENOMICS_BUDGET_MONTHLY     e.g. 500                 the allowance per billing period
 *   TOKENOMICS_BUDGET_RESET_DAY   1..31 (default 1)        day of the month the allowance resets
 *   TOKENOMICS_BUDGET_WORKDAYS    mon-fri (default)        e.g. "mon-sat", "sun-thu", "mon,wed,fri", "all"
 *   TOKENOMICS_BUDGET_DAYS_OFF    e.g. "2026-12-24..2026-12-31,2027-01-04"   holidays, dates or ranges
 *
 * Pure date arithmetic, no imports: scripts/statusline.ts keeps its own copy of `periodOf` and
 * `workingDaysLeft` (it is installed as a single file) and a test holds the two together.
 */

export type Calendar = {
  resetDay: number               // 1..31
  workdays: Set<number>          // 0 = Sunday .. 6 = Saturday
  daysOff: [string, string][]    // inclusive YYYY-MM-DD ranges
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const pad = (n: number) => String(n).padStart(2, '0')
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** "mon-fri" | "mon,wed,fri" | "sun-thu" | "all" -> weekday numbers. Falls back to Monday to Friday. */
export function parseWorkdays(raw: string | undefined): Set<number> {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return new Set([1, 2, 3, 4, 5])
  if (s === 'all' || s === 'every' || s === 'daily') return new Set([0, 1, 2, 3, 4, 5, 6])
  const out = new Set<number>()
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => DAYS.indexOf(x.trim().slice(0, 3)))
    if (a < 0 || (b !== undefined && b < 0)) continue
    if (b === undefined) out.add(a)
    else for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break }
  }
  return out.size ? out : new Set([1, 2, 3, 4, 5])
}

/** "2026-12-24..2026-12-31, 2027-01-04" -> inclusive ranges. Malformed entries are skipped. */
export function parseDaysOff(raw: string | undefined): [string, string][] {
  const out: [string, string][] = []
  for (const part of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b = a] = part.split('..').map((x) => x.trim())
    if (DATE_RE.test(a) && DATE_RE.test(b)) out.push(a <= b ? [a, b] : [b, a])
  }
  return out
}

export function calendar(env: Record<string, string | undefined> = process.env): Calendar {
  const r = Math.trunc(Number((env.TOKENOMICS_BUDGET_RESET_DAY ?? '').trim() || 1))
  return { resetDay: Number.isFinite(r) ? Math.min(31, Math.max(1, r)) : 1,
    workdays: parseWorkdays(env.TOKENOMICS_BUDGET_WORKDAYS), daysOff: parseDaysOff(env.TOKENOMICS_BUDGET_DAYS_OFF) }
}

/** The reset date in a month: the reset day, or the month's last day if it is shorter. */
function resetIn(year: number, month: number, resetDay: number): Date {
  const last = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(resetDay, last))
}

/** The billing period `d` falls in: [start, end) as YYYY-MM-DD, end being the next reset. */
export function periodOf(d: Date, resetDay: number): { start: string, end: string } {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  let start = resetIn(day.getFullYear(), day.getMonth(), resetDay)
  if (day < start) start = resetIn(day.getFullYear(), day.getMonth() - 1, resetDay)
  const end = resetIn(start.getFullYear(), start.getMonth() + 1, resetDay)
  return { start: ymd(start), end: ymd(end) }
}

/** Working days from `d` to the end of its period: today (always) plus each later workday not off. */
export function workingDaysLeft(d: Date, cal: Calendar): number {
  const { end } = periodOf(d, cal.resetDay)
  let n = 1
  for (let x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); ymd(x) < end; x.setDate(x.getDate() + 1)) {
    const s = ymd(x)
    if (cal.workdays.has(x.getDay()) && !cal.daysOff.some(([a, b]) => s >= a && s <= b)) n++
  }
  return n
}

/** Today's share of what's left of the allowance; never below zero. */
export function dailyShare(allowance: number, spentBeforeToday: number, daysLeft: number): number {
  return Math.max(0, allowance - spentBeforeToday) / Math.max(1, daysLeft)
}
