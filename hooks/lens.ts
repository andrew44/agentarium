// What the band (hooks/band.tsx) and the pane (hooks/pane.tsx) share: the helpers that turn the
// statusline's numbers (the `line` session value) into words, colours and pictures. Not a hooks
// module itself: both import it, so they never disagree. The engine reads each module's state
// references from its own file, so each declares `line` itself.
import type { Line, Outlook } from '../types'

export type Level = 'green' | 'yellow' | 'red'
// The app theme's own colours where it has one, so both sit right in light and dark.
export const THEME: Record<Level, 'success' | 'warning' | 'error'> = { green: 'success', yellow: 'warning', red: 'error' }
// The pictures can't read the theme: mid tones that hold on either ground.
export const RING: Record<Level, string> = { green: '#2FB673', yellow: '#E8A317', red: '#E5484D' }

const DEFAULT_ICONS = ['●', '◑', '○']

export function mmss(seconds: number) {
  const t = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export type Timer = { frac: number, level: Level | undefined, icon: string, text: string, caption: string }

/** The cache countdown at `nowSec`: how much is left (0-1), its colour, icon, text and caption. */
export function timer(b: Line, nowSec: number): Timer {
  const [full, half, empty] = (b.icons?.length === 3 ? b.icons : DEFAULT_ICONS) as [string, string, string]
  if (b.cold_at == null) {
    return { frac: 0, level: undefined, icon: empty, text: '--:--', caption: 'no cache yet' }
  }
  const rem = Math.max(0, b.cold_at - nowSec)
  const frac = b.ttl ? Math.min(1, rem / b.ttl) : 0
  if (rem <= 0) return { frac: 0, level: 'red', icon: empty, text: mmss(0), caption: 'cache cold' }
  if (frac > 0.75) return { frac, level: 'green', icon: full, text: mmss(rem), caption: 'cache warm' }
  if (frac > 0.25) return { frac, level: 'yellow', icon: half, text: mmss(rem), caption: 'cache cooling' }
  return { frac, level: 'red', icon: empty, text: mmss(rem), caption: 'cache going cold' }
}

/** The countdown ring: an arc that runs down as the cache cools. */
export function ring(frac: number, level: Level | undefined) {
  const r = 7
  const c = 2 * Math.PI * r
  const arc = frac > 0 && level
    ? `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${RING[level]}" stroke-width="3" stroke-linecap="round" ` +
      `stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 10 10)"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="#8A8F98" stroke-opacity="0.3" stroke-width="3"/>${arc}</svg>`
}

/** The context bar: a rounded track filled to `pct` with the terminal gauge's green -> amber -> red. */
export function bar(pct: number, w = 96) {
  const h = 8
  const fill = Math.max(0, Math.min(100, pct)) / 100 * w
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>` +
    `<linearGradient id="g" x1="0" x2="${w}" y1="0" y2="0" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0.5" stop-color="${RING.green}"/><stop offset="0.75" stop-color="${RING.yellow}"/>` +
    `<stop offset="0.9" stop-color="${RING.red}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="#8A8F98" fill-opacity="0.25"/>` +
    (fill > 0 ? `<rect width="${Math.max(h, fill).toFixed(1)}" height="${h}" rx="${h / 2}" fill="url(#g)"/>` : '') +
    `</svg>`
}

/** The tip's words: a warm-cache tip names the time left, which only the app knows to the second. */
export function tipAction(o: Outlook, t: Timer) {
  if (!o.tip) return ''
  if (o.tip.kind === 'warm') return t.caption === 'cache cold' ? '' : `reply within ${t.text}`
  return o.tip.action
}

/** The budget's figure and caption: '£1.20 left' / 'budget today · ~30 steps'. */
export function budgetText(o: Outlook) {
  const b = o.budget!
  const when = b.kind === 'daily' ? 'today' : b.kind === 'task' ? 'this task' : 'this session'
  if (b.over) return { figure: `${b.limit} spent`, caption: `budget ${when} · over` }
  const steps = b.steps_left === null ? '' : ` · ~${b.steps_left} step${b.steps_left === 1 ? '' : 's'}`
  // haggle's agreed price: keep the price in view, "£0.80 of £2.00 left"
  return { figure: b.kind === 'task' ? `${b.left} of ${b.limit} left` : `${b.left} left`, caption: `budget ${when}${steps}` }
}

/** How tight the budget is: amber when it won't last the forecast or is 80% gone, red when over. */
export function budgetLevel(o: Outlook): Level | undefined {
  if (!o.budget) return undefined
  if (o.budget.over) return 'red'
  return (o.budget.steps_left ?? Infinity) < o.steps || o.budget.used_pct >= 80 ? 'yellow' : undefined
}
