#!/usr/bin/env node
/**
 * agentarium / statusline: a live status line for Claude Code and GitHub Copilot CLI.
 *
 * Shows, on one line:
 *   * model
 *   * context gauge   (smooth green -> yellow at 75% -> red at 90%, with the percentage)
 *   * total tokens    (compact: 950, 12.3K, 8.5M)
 *   * session cost    (in GBP, USD or EUR, e.g. £1.37)
 *   * prompt-cache expiry countdown (MM:ss) with a pie clock that empties as the cache goes cold
 * and under it, on a second row, the outlook (the band's forecast row): what the next steps will cost,
 * the budget left, what a cold cache would cost, and the one change that saves most (see `outlook`
 * below). The apps' band gets the same from --json. AGENTARIUM_OUTLOOK=off (or --outlook-off) keeps
 * the terminal to the one line.
 *
 * Three places show it:
 *   * the status line: the CLIs' own status line (settings.json "statusLine"), in the terminal. Both
 *     CLIs run this script as a command, pipe a JSON payload on stdin and print what we write.
 *   * the band: Claude Code's apps don't draw the status line, so the plugin's mod (hooks/band.tsx)
 *     draws the same line, from --json, as its row in the band directly above the prompt box (VS Code
 *     also pins it as the plugin's status line entry, under the prompt box). Where mods can't run,
 *     --message posts it after each reply.
 *   * Copilot in VS Code and the Copilot app: no status line or mods there, so vscode/extension.js
 *     (a status bar item) and a small window (scripts/dashboard.ts --copilot) show the
 *     premium-request forecast from --copilot --json.
 * A single self-contained file (Node.js built-ins only): --install copies it to
 * ~/.agentarium/statusline.mts. Never throws: on any problem it prints a minimal line and exits 0.
 *
 * Usage
 *   statusline.ts                     render once from the stdin JSON (what the CLIs do)
 *   statusline.ts --install [claude|copilot|both]  wire the status line into the CLI settings (backs
 *                                     them up); add --keep-existing to skip a CLI that has another
 *   statusline.ts --uninstall [claude|copilot|both]
 *   statusline.ts --status            say where the status line is installed, and if the band is on
 *   statusline.ts --sync              SessionStart hook (plugin): refresh the installed copy after a
 *                                     plugin update; install it if no status line is set
 *                                     (AGENTARIUM_STATUSLINE=ask only suggests it once, =off stays quiet)
 *   statusline.ts --band-on / --band-off   show or hide the band in the apps (saved in the config)
 *   statusline.ts --outlook-on / --outlook-off   show or hide the forecast row in the terminal
 *   statusline.ts --json              the line's numbers as JSON, from the stdin JSON (for the band)
 *   statusline.ts --copilot [--json]  Copilot's numbers, from the database (no stdin): premium requests
 *                                     left and when they run out (VS Code's status bar, the Copilot app's window)
 *   statusline.ts --message           Stop hook (plugin): where mods can't run (older Claude Code)
 *                                     in the desktop app or VS Code, post the line after each reply
 *   statusline.ts --watch [--path FILE]  live-refresh every second (for terminals/CLIs that only
 *                                     redraw on activity, so the timer keeps ticking)
 *   statusline.ts --demo              preview every state (use with --theme light|dark)
 *   statusline.ts --update-rate       fetch today's USD->GBP and USD->EUR rates and save them
 *   statusline.ts --set-currency GBP|USD|EUR   save the display currency
 *   Flags: --theme light|dark|system   --currency GBP|USD|EUR   --ascii   --no-color
 *
 * Config: ~/.agentarium/statusline.json (or $AGENTARIUM_HOME/statusline.json), all optional:
 *   {"theme": "system", "currency": "GBP", "usd_gbp": 0.76, "usd_eur": 0.86, "cache_ttl": null,
 *    "width": 12, "warn": 75, "crit": 90, "band": true}
 * Env overrides: AGENTARIUM_THEME, AGENTARIUM_CURRENCY, AGENTARIUM_USD_GBP, AGENTARIUM_USD_EUR,
 *   AGENTARIUM_CACHE_TTL (seconds), AGENTARIUM_STATUSLINE (auto|ask|off), AGENTARIUM_BAND (on|off),
 *   AGENTARIUM_ASCII=1, AGENTARIUM_TIMER_ICONS="full,half,empty" (replaces the pie clock), NO_COLOR.
 */
import { spawnSync } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Obj = Record<string, any>
type RGB = [number, number, number]

const HOME = homedir()
const CFG_DIR = process.env.AGENTARIUM_HOME || join(HOME, '.agentarium')
const CFG_FILE = join(CFG_DIR, 'statusline.json')
const STATE_FILE = join(CFG_DIR, 'statusline-state.json')
/** till's database: AGENTARIUM_DB, else till.db in the data folder (as agentarium/config.ts has it). */
const dbPath = () => process.env.AGENTARIUM_DB || join(CFG_DIR, 'till.db')
const COPY_NAME = 'statusline.mts'
const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// This file runs on its own (copied to ~/.agentarium/statusline.mts), so it can't import
// agentarium/profile.ts. The settings it reads (budgets, currency, outlook, Copilot allowance) are
// filled in here the same way: env first, then ~/.agentarium/config.json "settings". The profile
// presets don't touch any of them.
;(() => {
  try {
    const c = JSON.parse(readFileSync(join(CFG_DIR, 'config.json'), 'utf8'))
    for (const [k, v] of Object.entries(isObj(c?.settings) ? c.settings : {})) {
      const name = /^AGENTARIUM_[A-Z0-9_]+$/.test(k) ? k : /^[a-z][a-z0-9_]*$/.test(k) ? `AGENTARIUM_${k.toUpperCase()}` : null
      if (name && (process.env[name] ?? '') === '' && v !== null && typeof v !== 'object') process.env[name] = String(v)
    }
  } catch {
    // no config file
  }
})()
const int = (v: unknown) => {
  const n = Math.trunc(Number(v ?? 0))
  return Number.isFinite(n) ? n : 0
}
const nowS = () => Date.now() / 1000

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export const DEFAULT_CFG: Obj = { theme: 'system', cache_ttl: null, width: 12, warn: 75, crit: 90 }

// ---- currency: keep identical to agentarium/engine/currency.ts (tests/features.test.ts checks) ---
// BEGIN CURRENCY
// Display currency: USD, EUR or GBP (default). Chosen by AGENTARIUM_CURRENCY, then "currency" in
// statusline.json; "$", "€", "£", "usd", "euro", "pounds" ... are accepted too. Prices are in USD
// and converted at the rate in AGENTARIUM_USD_EUR / AGENTARIUM_USD_GBP, then "usd_eur" /
// "usd_gbp" in statusline.json, then the defaults below (`statusline.ts --update-rate` saves
// today's rates).
export const CURRENCIES: Record<string, [symbol: string, key: string | null, rate: number]> = {
  USD: ['$', null, 1.0], EUR: ['€', 'usd_eur', 0.86], GBP: ['£', 'usd_gbp', 0.76],
}
export const DEFAULT_CURRENCY = 'GBP'
export const CURRENCY_ALIASES: Record<string, string> = {
  $: 'USD', US$: 'USD', DOLLAR: 'USD', DOLLARS: 'USD', '€': 'EUR', EURO: 'EUR',
  EUROS: 'EUR', '£': 'GBP', POUND: 'GBP', POUNDS: 'GBP', STERLING: 'GBP',
}

/** 'eur', '€', 'Euro' ... -> 'EUR'; null if not a supported currency. */
export function currencyCode(value: unknown): string | null {
  let v = String(value ?? '').trim().toUpperCase()
  v = Object.hasOwn(CURRENCY_ALIASES, v) ? CURRENCY_ALIASES[v] : v
  return Object.hasOwn(CURRENCIES, v) ? v : null
}

/** -> [code, symbol, units of that currency per US dollar]. */
export function currency(cfg: Record<string, any> | null | undefined): [string, string, number] {
  const c = cfg ?? {}
  const code = currencyCode(process.env.AGENTARIUM_CURRENCY) ?? currencyCode(c.currency) ?? DEFAULT_CURRENCY
  let [symbol, key, rate] = CURRENCIES[code]
  if (key) {
    for (const v of [process.env['AGENTARIUM_' + key.toUpperCase()], c[key]]) {
      if (v !== undefined && v !== null && v !== '' && Number(v) > 0) {
        rate = Number(v)
        break
      }
    }
  }
  return [code, symbol, rate]
}

/** '£12.50', or whole units above 25: '£1,235'. */
export function formatMoney(amount: unknown, symbol: string): string {
  const a = Number(amount) || 0
  const sign = a < 0 ? '-' : ''
  const digits = Math.abs(a) > 25 ? 0 : 2
  return sign + symbol + Math.abs(a).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
// END CURRENCY

// Price tables (USD per million tokens). Only used when the CLI does not report a cost itself
// (Copilot, or older Claude Code). Marked with "~" on screen.
//  1. {"prices": {"opus": [5, 25], "sonnet": [3, 15]}} in statusline.json wins (substring match);
//  2. then data/model-prices.json, per Claude model id, kept current by
//     .github/workflows/update-prices.yml from Claude's pricing page;
//  3. then this per-family fallback.
export const PRICES: Record<string, [number, number]> = {
  opus: [5.0, 25.0], sonnet: [3.0, 15.0], haiku: [1.0, 5.0], gpt: [2.5, 10.0], gemini: [1.25, 10.0],
}
export const DEFAULT_PRICE: [number, number] = [3.0, 15.0]
const FAST_MULTIPLIER = 2.0             // usage.speed == "fast": fast mode bills 2x the standard rates
const CACHE_WRITE_5M = 1.25             // x input, when a model has no listed rate
const CACHE_WRITE_1H = 2.0
const CACHE_READ = 0.1
// data/model-prices.json sits two levels up in the repo; `--install` copies it next to the installed script.
const MODEL_PRICES_FILES = [join(HERE, 'model-prices.json'), join(HERE, '..', 'data', 'model-prices.json')]
const CLAUDE_FAMILIES = 'fable|mythos|opus|sonnet|haiku'
const FAMILY_FIRST = new RegExp(String.raw`(${CLAUDE_FAMILIES})[\s_-]*(\d+)(?:[.-](\d)(?!\d))?`)
const VERSION_FIRST = new RegExp(String.raw`(\d+)[.-](\d)(?!\d)[\s_-]*(${CLAUDE_FAMILIES})`)
let modelPricesCache: Obj | null = null

// ----------------------------------------------------------------------------- config ---

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadCfg(): Obj {
  const cfg: Obj = { ...DEFAULT_CFG }
  try {
    const data = readJson(CFG_FILE)
    if (isObj(data)) Object.assign(cfg, data)
  } catch {
    // no config: the defaults
  }
  const env = process.env
  if (env.AGENTARIUM_THEME) cfg.theme = env.AGENTARIUM_THEME.toLowerCase()
  if (env.AGENTARIUM_CACHE_TTL && /^\s*[+-]?\d+\s*$/.test(env.AGENTARIUM_CACHE_TTL)) cfg.cache_ttl = Number.parseInt(env.AGENTARIUM_CACHE_TTL, 10)
  return cfg
}

export function loadState(): Obj {
  try {
    const s = readJson(STATE_FILE)
    return isObj(s) ? s : {}
  } catch {
    return {}
  }
}

export function saveState(state: Obj): void {
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    const tmp = STATE_FILE.replace(/\.json$/, '.tmp')
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, STATE_FILE)
  } catch {
    // the state is only a cache
  }
}

// ----------------------------------------------------------------------------- themes ----

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  return r.status === 0 || r.stdout ? String(r.stdout ?? '') : ''
}

/** Best-effort light/dark detection. Terminal hint first, then the OS. Cached for 60s. */
export function systemTheme(state: Obj): string {
  const cached = isObj(state.theme_cache) ? state.theme_cache : {}
  if (nowS() - (cached.at ?? 0) < 60 && cached.value) return cached.value
  let value: string | null = null
  const fgbg = process.env.COLORFGBG ?? ''             // "15;0" = light fg on dark bg (xterm, rxvt, ...)
  const last = fgbg.split(';').at(-1) ?? ''
  if (fgbg && /^\d+$/.test(last)) value = ['7', '15'].includes(String(Number(last))) ? 'light' : 'dark'
  if (value === null) {
    try {
      if (process.platform === 'darwin') {
        value = run('defaults', ['read', '-g', 'AppleInterfaceStyle']).toLowerCase().includes('dark') ? 'dark' : 'light'
      } else if (process.platform === 'win32') {
        const out = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'])
        const m = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)
        if (m) value = Number.parseInt(m[1], 16) ? 'light' : 'dark'
      } else {
        const out = run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']).trim()
        if (out) value = out.toLowerCase().includes('dark') ? 'dark' : 'light'
      }
    } catch {
      value = null
    }
  }
  value = value || 'dark'
  state.theme_cache = { at: nowS(), value }
  return value
}

const PALETTE: Record<string, Record<string, RGB>> = {
  dark: { text: [224, 228, 240], dim: [124, 130, 152], track: [58, 61, 78],
    accent: [180, 160, 255], base: [22, 20, 34], sep: [78, 82, 102],
    green: [64, 214, 140], yellow: [250, 196, 72], red: [255, 99, 120] },
  light: { text: [30, 34, 44], dim: [110, 116, 130], track: [214, 218, 228],
    accent: [104, 72, 214], base: [255, 255, 255], sep: [190, 196, 208],
    green: [22, 150, 90], yellow: [196, 122, 0], red: [214, 40, 70] },
}

export class Style {
  p: Record<string, RGB>
  theme: string
  color: boolean
  ascii: boolean
  truecolor: boolean

  constructor(theme: string, color = true, asciiOnly = false) {
    this.p = PALETTE[theme]
    this.theme = theme
    this.color = color
    this.ascii = asciiOnly
    const ct = (process.env.COLORTERM ?? '').toLowerCase()
    this.truecolor = ct === 'truecolor' || ct === '24bit' || Boolean(process.env.WT_SESSION)
  }

  fg(rgb: RGB): string {
    if (!this.color) return ''
    const [r, g, b] = rgb.map(roundHalfEven)
    return this.truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`
  }

  bg(rgb: RGB): string {
    if (!this.color) return ''
    const [r, g, b] = rgb.map(roundHalfEven)
    return this.truecolor ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256(r, g, b)}m`
  }

  /** `text` as a solid pill: half-block caps round off a filled run in `key`'s colour. */
  pill(text: string, key = 'accent'): string {
    if (!this.color || this.ascii) return text
    const c = this.p[key]
    return `${this.fg(c)}▐\x1b[0m${this.bg(c)}${this.fg(this.p.base)}\x1b[1m${text}\x1b[0m${this.fg(c)}▌\x1b[0m`
  }

  paint(text: string, keyOrRgb: string | RGB, bold = false): string {
    const rgb = typeof keyOrRgb === 'string' ? this.p[keyOrRgb] : keyOrRgb
    if (!this.color) return text
    return `${bold ? '\x1b[1m' : ''}${this.fg(rgb)}${text}\x1b[0m`
  }
}

export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return roundHalfEven((r - 8) / 247 * 24) + 232
  }
  return 16 + 36 * roundHalfEven(r / 255 * 5) + 6 * roundHalfEven(g / 255 * 5) + roundHalfEven(b / 255 * 5)
}

function lerp(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t))
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * k) as RGB
}

/** Green (held to 50%) -> yellow at `warn` -> red at `crit`, blended smoothly in between. */
export function levelColor(style: Style, pct: number, warn: number, crit: number): RGB {
  const { green: g, yellow: y, red: r } = style.p
  const hold = Math.min(50, warn - 1)
  if (pct <= hold) return g
  if (pct <= warn) return lerp(g, y, (pct - hold) / (warn - hold))
  if (pct <= crit) return lerp(y, r, (pct - warn) / (crit - warn))
  return r
}

// ----------------------------------------------------------------------------- numbers ---

export function human(n: unknown): string {
  const v0 = Number(n) || 0
  for (const [unit, size] of [['B', 1e9], ['M', 1e6], ['K', 1e3]] as [string, number][]) {
    if (v0 >= size) {
      const v = v0 / size
      const s = v < 100 ? v.toFixed(1) : v.toFixed(0)
      return (s.endsWith('.0') ? s.slice(0, -2) : s) + unit
    }
  }
  return String(Math.trunc(v0))
}

export function money(amount: number, symbol = '£'): string {
  return formatMoney(amount, symbol)
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** {modelId: entry} from data/model-prices.json ({} if missing or unreadable). */
export function loadModelPrices(): Obj {
  if (modelPricesCache === null) {
    modelPricesCache = {}
    for (const path of MODEL_PRICES_FILES) {
      try {
        const data = readJson(path) as Obj
        modelPricesCache = isObj(data?.models) ? data.models : {}
        break
      } catch {
        continue
      }
    }
  }
  return modelPricesCache!
}

/** Canonical id for a Claude model name or id, e.g. 'Opus 5.5' or 'claude-opus-5-5[1m]' ->
 *  'claude-opus-5-5'; 'claude-3-5-haiku-20241022' -> 'claude-3-5-haiku'. null if not Claude. */
export function claudeModelId(model: string | null | undefined): string | null {
  const m = (model || '').toLowerCase()
  let hit = VERSION_FIRST.exec(m)
  if (hit) return `claude-${hit[1]}-${hit[2]}-${hit[3]}`
  hit = FAMILY_FIRST.exec(m)
  if (!hit) return null
  const family = hit[1]
  const major = Number(hit[2])
  const minor = hit[3]
  const ver = minor && minor !== '0' ? `${major}-${minor}` : `${major}`
  return major < 4 ? `claude-${ver}-${family}` : `claude-${family}-${ver}`
}

/** Human name for a Claude model id, e.g. 'claude-opus-5-5[1m]' -> 'Claude Opus 5.5',
 *  'claude-3-5-haiku-20241022' -> 'Claude 3.5 Haiku'. The raw id is returned for non-Claude models. */
export function prettyModelName(model: string | null | undefined): string {
  const raw = model || ''
  const id = claudeModelId(raw)
  if (!id) return raw
  const m = /^claude-(?:(\d+)-(\d)-([a-z]+)|([a-z]+)-(\d+)(?:-(\d))?)$/.exec(id)
  if (!m) return raw
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  if (m[1]) return `Claude ${m[1]}.${m[2]} ${cap(m[3])}`          // claude-3-5-haiku
  const ver = m[6] && m[6] !== '0' ? `${m[5]}.${m[6]}` : m[5]        // claude-opus-5-5 -> 5.5
  return `Claude ${cap(m[4])} ${ver}`
}

export type Rates = { input: number, output: number, cache_write_5m: number, cache_write_1h: number, cache_read: number, long_context?: Obj }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dashed = (s: string) => s.toLowerCase().replace(/[\s._]+/g, '-')
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new TypeError(`not a number: ${String(v)}`)
  return n
}

/** Per-million-token USD rates: input, output, cache_write_5m, cache_write_1h, cache_read
 *  (plus long_context when the model has a long-prompt tier). */
export function ratesFor(model: string | null | undefined, cfg: Obj): Rates {
  const m = (model || '').toLowerCase()
  let best: [string, number, number, number | null] | null = null
  for (const [k, v] of Object.entries(isObj(cfg.prices) ? cfg.prices : {})) {   // user overrides: most specific key wins
    try {
      const key = dashed(String(k))
      if (key && Array.isArray(v) && new RegExp(`(?<![a-z0-9])${escapeRe(key)}(?![0-9])`).test(dashed(m)) &&
          (best === null || key.length > best[0].length)) {
        best = [key, num(v[0]), num(v[1]), v.length > 2 ? num(v[2]) : null]
      }
    } catch {
      // a malformed override is ignored
    }
  }
  if (best) {
    const [, pin, pout, pread] = best
    return { input: pin, output: pout, cache_write_5m: pin * CACHE_WRITE_5M, cache_write_1h: pin * CACHE_WRITE_1H,
      cache_read: pread === null ? pin * CACHE_READ : pread }
  }
  const entry = loadModelPrices()[claudeModelId(m) || '']
  if (isObj(entry)) {
    try {
      const pin = num(entry.input)
      const rates: Rates = { input: pin, output: num(entry.output),
        cache_write_5m: num(entry.cache_write_5m ?? pin * 1.25),
        cache_write_1h: num(entry.cache_write_1h ?? pin * 2.0),
        cache_read: num(entry.cache_read ?? pin * 0.1) }
      if (isObj(entry.long_context)) rates.long_context = entry.long_context
      return rates
    } catch {
      // fall through to the family prices
    }
  }
  let [pin, pout] = DEFAULT_PRICE
  for (const [key, val] of Object.entries(PRICES)) {
    if (m.includes(key)) {
      [pin, pout] = val
      break
    }
  }
  return { input: pin, output: pout, cache_write_5m: pin * 1.25, cache_write_1h: pin * 2.0, cache_read: pin * 0.1 }
}

/** [input, output] USD per million tokens. */
export function priceFor(model: string | null | undefined, cfg: Obj): [number, number] {
  const r = ratesFor(model, cfg)
  return [r.input, r.output]
}

/** Cost of one usage object (one request) in USD: the model's input, output, cache-write and
 *  cache-read rates, Haiku-style long-prompt tiers, and fast mode at 2x. */
export function usageCostUsd(u: Obj, model: string | null | undefined, cfg: Obj): number {
  let r = ratesFor(model, cfg)
  const cc = isObj(u.cache_creation) ? u.cache_creation : {}
  const w1h = int(cc.ephemeral_1h_input_tokens)
  let w5m = int(cc.ephemeral_5m_input_tokens)
  if (!(w1h || w5m)) w5m = int(u.cache_creation_input_tokens)
  const inp = int(u.input_tokens)
  const read = int(u.cache_read_input_tokens)
  const lc = r.long_context
  if (lc && inp + w5m + w1h + read > int(lc.threshold)) {
    r = { ...r, ...Object.fromEntries(Object.entries(lc).filter(([k]) => k !== 'threshold').map(([k, v]) => [k, Number(v)])) }
  }
  const usd = (inp * r.input + int(u.output_tokens) * r.output + w5m * r.cache_write_5m + w1h * r.cache_write_1h +
    read * r.cache_read) / 1e6
  return u.speed === 'fast' ? usd * FAST_MULTIPLIER : usd
}

// ----------------------------------------------------------------------------- transcript

export function parseTs(s: unknown): number | null {
  if (s === null || s === undefined || s === '' || s === 0) return null
  if (typeof s === 'number') return s > 1e11 ? s / 1000 : s
  const t = Date.parse(String(s))
  return Number.isNaN(t) ? null : t / 1000
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs / 1000
  } catch {
    return 0
  }
}

function newestJsonl(directory: string): string | null {
  let best: string | null = null
  let bestM = 0
  try {
    for (const f of readdirSync(directory)) {
      if (!f.endsWith('.jsonl')) continue
      const m = mtime(join(directory, f))
      if (m > bestM) [best, bestM] = [join(directory, f), m]
    }
  } catch {
    // unreadable folder
  }
  return best
}

const tok = (u: Obj) => [int(u.input_tokens), int(u.output_tokens), int(u.cache_creation_input_tokens), int(u.cache_read_input_tokens)]

/** Incrementally read a Claude-style JSONL transcript. Returns an object of running totals.
 *
 *  Streamed assistant entries repeat the same message id, so the latest usage for an id replaces
 *  the earlier one (the repeats are consecutive, so remembering the last id is enough). */
export function scanTranscript(path: string, state: Obj, cfg: Obj): Obj | null {
  if (!isFile(path)) return null
  state.transcripts = isObj(state.transcripts) ? state.transcripts : {}
  const cache: Obj = state.transcripts
  let st: Obj = cache[path]
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (!isObj(st) || (st.offset ?? 0) > size) {
      st = { offset: 0, tok: { input: 0, output: 0, cw: 0, cr: 0 }, cost: 0.0, last_id: null, last_u: null,
        last_cost: 0.0, last_cache_ts: null, ttl_1h: false, ctx: 0, model: null, msgs: 0 }
    }
    if (size > st.offset) {
      const chunk = Buffer.alloc(size - st.offset)
      let got = 0
      while (got < chunk.length) {
        const n = readSync(fd, chunk, got, chunk.length - got, st.offset + got)
        if (n <= 0) break
        got += n
      }
      const end = chunk.subarray(0, got).lastIndexOf(0x0a)
      if (end >= 0) {
        for (const raw of chunk.subarray(0, end + 1).toString('utf8').split(/\r?\n/)) {
          if (!raw.includes('"usage"')) continue
          let ev: Obj
          try {
            ev = JSON.parse(raw)
          } catch {
            continue
          }
          const msg: Obj = isObj(ev?.message) ? ev.message : {}
          const u = msg.usage
          if (ev.type !== 'assistant' || !isObj(u)) continue
          const model = msg.model || st.model
          if (model && model !== '<synthetic>') st.model = model
          const mid = msg.id || ev.uuid || null
          if (mid !== null && mid === st.last_id && st.last_u) {
            const [pi, po, pw, pr] = tok(st.last_u)               // replace the earlier streamed copy
            st.tok.input -= pi
            st.tok.output -= po
            st.tok.cw -= pw
            st.tok.cr -= pr
            st.cost -= st.last_cost
          } else {
            st.msgs += 1
          }
          const c = usageCostUsd(u, model, cfg)
          const [i, o, w, r] = tok(u)
          st.tok.input += i
          st.tok.output += o
          st.tok.cw += w
          st.tok.cr += r
          st.cost += c
          st.last_id = mid
          st.last_u = u
          st.last_cost = c
          if (!ev.isSidechain) st.ctx = i + r + w
          if (r + w) {
            const ts = parseTs(ev.timestamp)
            if (ts) {
              st.last_cache_ts = ts
              const cc = isObj(u.cache_creation) ? u.cache_creation : {}
              if (int(cc.ephemeral_1h_input_tokens)) st.ttl_1h = true
              else if (int(cc.ephemeral_5m_input_tokens)) st.ttl_1h = false
            }
          }
        }
        st.offset += end + 1
      }
    }
  } finally {
    closeSync(fd)
  }
  st.seen = nowS()
  cache[path] = st
  const keys = Object.keys(cache)
  if (keys.length > 20) {                                  // keep the state file small: drop least recently used
    for (const k of keys.sort((a, b) => (cache[a].seen ?? 0) - (cache[b].seen ?? 0)).slice(0, keys.length - 20)) delete cache[k]
  }
  return st
}

// ----------------------------------------------------------------------------- gather ----

export type Info = { model: string, total: number, cost: number, symbol: string, estimated: boolean, pct: number,
  ttl: number, remaining: number | null,
  /** Claude Code's session id, when the payload had one (sommelier's savings are kept per session). */
  sid?: string,
  /** A Copilot CLI session (its transcript is a session-state directory). */
  copilot?: boolean,
  /** The raw figures the outlook forecasts from (absent when built by hand, e.g. in tests). */
  raw?: { modelId: string, ctx: number, window: number, requests: number, output: number, rate: number } }

/** Collapse whatever the CLI told us (plus the transcript) into the numbers we display. */
export function gather(payload: Obj, cfg: Obj, state: Obj): Info {
  const cw: Obj = isObj(payload.context_window) ? payload.context_window : {}
  let model: Obj = payload.model
  if (typeof model === 'string') model = { id: model }
  else if (!isObj(model)) model = {}
  const modelId: string = model.id || ''
  let name: string = model.display_name || prettyModelName(modelId) || ''
  const tpath = payload.transcript_path
  let st: Obj | null = null
  let eventsFile: string | null = null
  if (tpath) {
    const p = String(tpath)
    if (isDir(p)) {                                         // Copilot: a session-state directory
      eventsFile = newestJsonl(p)
      if (eventsFile) st = scanTranscript(eventsFile, state, cfg)
    } else if (isFile(p)) {
      eventsFile = p
      st = scanTranscript(p, state, cfg)
    }
  }
  const hasTx = Boolean(st && st.msgs)
  if (!name && hasTx && st!.model) name = prettyModelName(st!.model)
  // Copilot Fusion is a router: show the model it sent the work to, as the hooks recorded it
  if (/fusion/i.test(`${modelId} ${name}`)) {
    const r = copilotRoute(payload.session_id ? String(payload.session_id) : null)
    if (r) name = `${name || fusionLabel(r.router)} → ${r.model}`
  }

  // ---- total tokens (everything the session has processed, cache reads included)
  let total: number
  if (hasTx) {
    const t = st!.tok
    total = t.input + t.output + t.cw + t.cr
  } else {
    total = cw.total_tokens ?? ['total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens',
      'total_cache_write_tokens'].reduce((a, k) => a + int(cw[k]), 0)
  }

  // ---- cost in USD -> display currency
  let costUsd = isObj(payload.cost) ? payload.cost.total_cost_usd : undefined
  let estimated = false
  if (costUsd === undefined || costUsd === null) {
    estimated = true
    if (hasTx) {
      costUsd = st!.cost
    } else {
      const u = { input_tokens: cw.total_input_tokens, output_tokens: cw.total_output_tokens,
        cache_read_input_tokens: cw.total_cache_read_tokens, cache_creation_input_tokens: cw.total_cache_write_tokens }
      costUsd = usageCostUsd(u, modelId || name, cfg)
    }
  }
  const [, symbol, rate] = currency(cfg)
  const cost = (Number(costUsd) || 0) * rate

  // ---- context percentage
  let pct = cw.current_context_used_percentage ?? cw.used_percentage
  if (pct === undefined || pct === null) {
    let window = cw.displayed_context_limit || cw.context_window_size
    if (!window) window = /1m\b|\[1m\]/.test(modelId.toLowerCase()) ? 1_000_000 : 200_000
    let used = cw.current_context_tokens
    if ((used === undefined || used === null) && hasTx) used = st!.ctx
    if (used === undefined || used === null) {
      const cu: Obj = isObj(cw.current_usage) ? cw.current_usage : {}
      used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((a, k) => a + int(cu[k]), 0)
    }
    pct = window ? (used || 0) / window * 100 : 0
  }
  pct = Math.max(0, Math.min(100, Number(pct) || 0))
  const window = int(cw.context_window_size || cw.displayed_context_limit) ||
    (/1m\b|\[1m\]/.test(modelId.toLowerCase()) ? 1_000_000 : 200_000)
  let ctx = int(cw.current_context_tokens) || (hasTx ? int(st!.ctx) : 0)
  if (!ctx && pct) ctx = Math.round(pct / 100 * window)

  // ---- cache expiry
  const ttl = Number(cfg.cache_ttl) || (hasTx && st!.ttl_1h ? 3600 : 300)
  let last: number | null = hasTx ? st!.last_cache_ts : null
  if ((last === null || last === undefined) && eventsFile) last = mtime(eventsFile) || null   // no usage records: use last write time
  const remaining = last === null || last === undefined ? null : Math.max(0, ttl - (nowS() - last))
  return { model: name, total, cost, symbol, estimated, pct, ttl, remaining,
    ...(payload.session_id ? { sid: String(payload.session_id) } : {}),
    ...(tpath && isDir(String(tpath)) ? { copilot: true } : {}),
    raw: { modelId: modelId || (hasTx ? String(st!.model ?? '') : '') || name, ctx, window,
      requests: hasTx ? int(st!.msgs) : 0, output: hasTx ? int(st!.tok.output) : 0, rate } }
}

// ----------------------------------------------------------------------------- outlook ---
// The band's forward view: not what the session has cost, but what it is about to cost, and the
// one change that stops the most of it. Words and arithmetic only: no model call, nothing stored.
//
//   step       the next request while the cache is warm: the context at the cache-read rate, the
//              context it adds (written to the cache) and a typical reply
//   forecast   the next FORECAST_STEPS requests, with the context growing as it has so far
//   at_risk    what a cold cache adds to the next request: the whole context written again
//              instead of read (12-20x the warm price)
//   budget     what is left of the tightest of the daily and session limits (AGENTARIUM_BUDGET_*,
//              the same ones the budget hook enforces) and the price agreed with haggle for the
//              task in hand (its cap), and about how many steps that buys
//   tip        the single change that saves most over the forecast, priced: keep the cache warm,
//              /clear a cold conversation (doggybag keeps the notes), /compact a full one, or a
//              cheaper model when the budget won't last the forecast

export const FORECAST_STEPS = 10
const COMPACT_KEEPS = 0.25                       // /compact leaves about a quarter of the context
const COMPACT_SUMMARY = 6_000                    // ...and writes a summary about this long
const DOGGYBAG_TOKENS = 3_000                    // a fresh start with the doggybag note loaded

export type Tip = { action: string, saves: number, why: string, kind: 'warm' | 'clear' | 'compact' | 'model' }
export type Budget = { kind: 'session' | 'daily' | 'task', limit: number, spent: number, left: number, steps_left: number | null }

/** How a budget's kind reads after "left": 'today', 'this session', 'this task'. */
export const budgetWhen = (kind: Budget['kind']) => (kind === 'daily' ? 'today' : kind === 'task' ? 'this task' : 'this session')
export type Outlook = { step: number, forecast: number, steps: number, at_risk: number, cold: boolean,
  budget: Budget | null, tip: Tip | null,
  /** What sommelier saved this session (display currency), net of its hand-offs; 0 when nothing. */
  saved: number }

function budgetNum(name: string): number | null {
  const raw = (process.env[name] ?? '').trim().replace(/^[£€$]+/, '').replaceAll(',', '')
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : null
}

// The monthly allowance's calendar: a copy of agentarium/engine/allowance.ts (this file is installed
// on its own). tests/features.test.ts holds the two together.
const ALLOWANCE_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export type Calendar = { resetDay: number, workdays: Set<number>, daysOff: [string, string][] }

export function allowanceCalendar(): Calendar {
  const wd = (process.env.AGENTARIUM_BUDGET_WORKDAYS ?? '').trim().toLowerCase()
  let workdays = new Set<number>()
  if (wd === 'all' || wd === 'every' || wd === 'daily') workdays = new Set([0, 1, 2, 3, 4, 5, 6])
  else for (const part of wd.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => ALLOWANCE_DAYS.indexOf(x.trim().slice(0, 3)))
    if (a < 0 || (b !== undefined && b < 0)) continue
    if (b === undefined) workdays.add(a)
    else for (let d = a; ; d = (d + 1) % 7) { workdays.add(d); if (d === b) break }
  }
  if (!workdays.size) workdays = new Set([1, 2, 3, 4, 5])
  const daysOff: [string, string][] = []
  for (const part of (process.env.AGENTARIUM_BUDGET_DAYS_OFF ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b = a] = part.split('..').map((x) => x.trim())
    if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) daysOff.push(a <= b ? [a, b] : [b, a])
  }
  const r = Math.trunc(Number((process.env.AGENTARIUM_BUDGET_RESET_DAY ?? '').trim() || 1))
  return { resetDay: Number.isFinite(r) ? Math.min(31, Math.max(1, r)) : 1, workdays, daysOff }
}

export function periodOf(d: Date, resetDay: number): { start: string, end: string } {
  const at = (y: number, m: number) => new Date(y, m, Math.min(resetDay, new Date(y, m + 1, 0).getDate()))
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  let start = at(day.getFullYear(), day.getMonth())
  if (day < start) start = at(day.getFullYear(), day.getMonth() - 1)
  return { start: ymdOf(start), end: ymdOf(at(start.getFullYear(), start.getMonth() + 1)) }
}

export function workingDaysLeft(d: Date, cal: Calendar): number {
  const { end } = periodOf(d, cal.resetDay)
  let n = 1
  for (let x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); ymdOf(x) < end; x.setDate(x.getDate() + 1)) {
    const s = ymdOf(x)
    if (cal.workdays.has(x.getDay()) && !cal.daysOff.some(([a, b]) => s >= a && s <= b)) n++
  }
  return n
}

/** USD spent on days in [from, to) from till's database (read-only); null if it can't be read. */
export function rangeCostUsd(from: string, to: string): number | null {
  return readDb((db) => {
    const row = db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM cost_events WHERE day>=? AND day<?').get(from, to) as Obj | undefined
    return Number(row?.usd) || 0
  }, null)
}

/** USD spent today across sessions, from till's database (read-only); null if it can't be read. */
export function dayCostUsd(): number | null {
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return readDb((db) => {
    const row = db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM cost_events WHERE day=?').get(day) as Obj | undefined
    return Number(row?.usd) || 0
  }, null)
}

/** Run `fn` on till's database, read-only and quiet; `fallback` when there's nothing to read. */
function readDb<T>(fn: (db: import('node:sqlite').DatabaseSync) => T, fallback: T): T {
  const path = dbPath()
  if (!isFile(path)) return fallback
  const emit = process.emitWarning
  try {
    process.emitWarning = (() => {}) as typeof process.emitWarning        // node:sqlite's "experimental" notice
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } catch {
    return fallback
  } finally {
    process.emitWarning = emit
  }
}

const hasColumn = (db: import('node:sqlite').DatabaseSync, table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Obj[]).some((r) => r.name === col)

/** USD sommelier saved in a session (net of hand-offs; routes up not counted), from till's
 *  database (read-only); 0 when there's nothing to read. */
export function sommelierSavedUsd(sid: string | undefined): number {
  if (!sid) return 0
  return readDb((db) => {
    if (!hasColumn(db, 'sommelier_events', 'saved_usd')) return 0
    const row = db.prepare('SELECT COALESCE(SUM(saved_usd),0) AS usd FROM sommelier_events WHERE session_id=? AND saved_usd>0')
      .get(sid) as Obj | undefined
    return Number(row?.usd) || 0
  }, 0)
}

/** The price agreed with haggle for the session's task in hand (USD): its cap, and what the task has
 *  spent so far (haggle brings it up to date at each tool call and each reply); null with no open contract. */
export function taskContractUsd(sid: string | undefined): { limit: number, spent: number } | null {
  if (!sid) return null
  return readDb((db) => {
    if (!hasColumn(db, 'contracts', 'cap_usd')) return null
    const row = db.prepare("SELECT cap_usd, spent_usd FROM contracts WHERE session_id=? AND status IN ('open','capped') ORDER BY id DESC LIMIT 1")
      .get(sid) as Obj | undefined
    const limit = Number(row?.cap_usd)
    return row && limit > 0 ? { limit, spent: Number(row.spent_usd) || 0 } : null
  }, null)
}

/** What's left of the budget (display currency), the tightest limit first; null when none is set.
 *  `task` (USD) is haggle's agreed price for the task in hand: it counts whatever the budget mode. */
export function budgetLeft(sessionSpent: number, rate: number, stepCost: number, daySpentUsd?: number | null,
  periodSpentUsd?: number | null, now: Date = new Date(), task?: { limit: number, spent: number } | null): Budget | null {
  const options: Budget[] = []
  const perStep = (left: number) => (stepCost > 0 ? Math.max(0, Math.floor(left / stepCost)) : null)
  if (task) options.push({ kind: 'task', limit: task.limit * rate, spent: task.spent * rate, left: (task.limit - task.spent) * rate,
    steps_left: perStep((task.limit - task.spent) * rate) })
  const mode = (process.env.AGENTARIUM_BUDGET_MODE ?? 'block').trim().toLowerCase()
  if (mode === 'off') return options[0] ?? null
  const session = budgetNum('AGENTARIUM_BUDGET_SESSION')
  if (session) options.push({ kind: 'session', limit: session, spent: sessionSpent, left: session - sessionSpent,
    steps_left: perStep(session - sessionSpent) })
  let daily = budgetNum('AGENTARIUM_BUDGET_DAILY')
  const monthly = budgetNum('AGENTARIUM_BUDGET_MONTHLY')
  if (monthly) {
    // today's share of what's left of the allowance over the working days left (engine/allowance.ts)
    const cal = allowanceCalendar()
    const usd = periodSpentUsd === undefined ? rangeCostUsd(periodOf(now, cal.resetDay).start, ymdOf(now)) : periodSpentUsd
    const share = Math.max(0, monthly - (usd ?? 0) * rate) / Math.max(1, workingDaysLeft(now, cal))
    daily = daily === null ? share : Math.min(daily, share)
  }
  if (daily !== null) {
    const usd = daySpentUsd === undefined ? dayCostUsd() : daySpentUsd
    // till records at each turn's end; this session's spend is at least what it shows now
    const spent = Math.max((usd ?? 0) * rate, sessionSpent)
    options.push({ kind: 'daily', limit: daily, spent, left: daily - spent, steps_left: perStep(daily - spent) })
  }
  if (!options.length) return null
  return options.reduce((a, b) => (b.left < a.left ? b : a))
}

/** The forward view for `info` (null when there's no context to forecast from). All money in the
 *  display currency. `cheaper` prices the model a tip would switch to (default: the Sonnet family). */
export function outlook(info: Info, cfg: Obj, opts: { daySpentUsd?: number | null, periodSpentUsd?: number | null, now?: Date,
  cheaper?: string, savedUsd?: number, task?: { limit: number, spent: number } | null } = {}): Outlook | null {
  const raw = info.raw
  if (!raw || raw.ctx <= 0) return null
  const r = ratesFor(raw.modelId, cfg)
  const write = info.ttl >= 3600 ? r.cache_write_1h : r.cache_write_5m
  const n = FORECAST_STEPS
  // what each request adds, and a typical reply, from the session so far (defaults for a new one)
  const growth = raw.requests > 1 ? Math.min(20_000, Math.max(500, raw.ctx / raw.requests)) : 2_000
  const out = raw.requests ? Math.min(8_000, Math.max(200, raw.output / raw.requests)) : 800
  const stepUsd = (c: number, rates: Rates = r, w = write) => (c * rates.cache_read + growth * w + out * rates.output) / 1e6
  let forecastUsd = 0
  for (let k = 0; k < n; k++) forecastUsd += stepUsd(Math.min(raw.window, raw.ctx + k * growth))
  const cached = info.remaining !== null
  const cold = cached && info.remaining! <= 0
  const riskUsd = cached ? raw.ctx * (write - r.cache_read) / 1e6 : 0
  const rate = raw.rate
  const step = stepUsd(raw.ctx) * rate
  const forecast = forecastUsd * rate
  const task = opts.task === undefined ? taskContractUsd(info.sid) : opts.task
  const budget = budgetLeft(info.cost, rate, step, opts.daySpentUsd, opts.periodSpentUsd, opts.now, task)

  const tips: Tip[] = []
  if (cold) {
    // carrying on re-writes the whole context, then reads it every step; a fresh start reads a note
    const keep = (raw.ctx * write + n * raw.ctx * r.cache_read) / 1e6
    const fresh = (DOGGYBAG_TOKENS * write + n * DOGGYBAG_TOKENS * r.cache_read) / 1e6
    tips.push({ kind: 'clear', action: '/clear', saves: (keep - fresh) * rate,
      why: `the cache is cold: the next prompt re-writes ${human(raw.ctx)} tokens (doggybag keeps your notes)` })
  } else if (cached && info.ttl && info.remaining! / info.ttl <= 0.5) {
    tips.push({ kind: 'warm', action: 'reply before the cache goes cold', saves: riskUsd * rate,
      why: `a cold cache re-writes ${human(raw.ctx)} tokens` })
  }
  const warn = Number(cfg.warn) || 75
  if (info.pct >= warn || raw.ctx >= 100_000) {
    const shed = raw.ctx * (1 - COMPACT_KEEPS)
    // the summary is read once, written as a reply and cached; the rest stops being re-read
    const cost = raw.ctx * r.cache_read + COMPACT_SUMMARY * (r.output + write)
    const saves = (n * shed * r.cache_read - cost) / 1e6
    tips.push({ kind: 'compact', action: '/compact', saves: saves * rate,
      why: `${Math.round(info.pct)}% of the context is re-read at every step` })
  }
  if (budget && budget.steps_left !== null && budget.steps_left < n) {
    const target = opts.cheaper ?? 'sonnet'
    const cur = tierRank(raw.modelId)
    if (cur !== null && cur > (tierRank(target) ?? 2)) {
      const c = ratesFor(target, cfg)
      const cw = info.ttl >= 3600 ? c.cache_write_1h : c.cache_write_5m
      let cheaperUsd = raw.ctx * cw / 1e6                     // its own cache: the context written once
      for (let k = 0; k < n; k++) cheaperUsd += stepUsd(Math.min(raw.window, raw.ctx + k * growth), c, cw)
      const name = target.charAt(0).toUpperCase() + target.slice(1)
      tips.push({ kind: 'model', action: `/model ${target}`, saves: (forecastUsd - cheaperUsd) * rate,
        why: `the ${budget.kind === 'daily' ? "day's" : budget.kind === 'task' ? "task's agreed" : "session's"} budget lasts about ${budget.steps_left} more ` +
          `step${budget.steps_left === 1 ? '' : 's'}; ${name} stretches it` })
    }
  }
  const best = tips.filter((t) => t.saves >= 0.01).reduce<Tip | null>((a, b) => (!a || b.saves > a.saves ? b : a), null)
  const saved = (opts.savedUsd ?? sommelierSavedUsd(info.sid)) * rate
  return { step, forecast, steps: n, at_risk: riskUsd * rate, cold, budget, tip: best, saved }
}

/** Claude family rank: haiku 1, sonnet 2, opus 3, fable/mythos 4; null for other models. */
function tierRank(model: string): number | null {
  const m = model.toLowerCase()
  for (const [k, v] of [['haiku', 1], ['sonnet', 2], ['opus', 3], ['fable', 4], ['mythos', 4]] as const) if (m.includes(k)) return v
  return null
}

// ----------------------------------------------------------------------------- Copilot ---
// Copilot bills premium requests against a monthly allowance, not tokens. Hooks can't see the
// model, so till records each prompt with the multiplier of the model Copilot's session state
// names (AGENTARIUM_COPILOT_MULTIPLIERS; see agentarium/engine/premium.ts), and a prompt with none counts as
// AGENTARIUM_COPILOT_MULTIPLIER requests (default 1;
// set it to your model's multiplier). With AGENTARIUM_COPILOT_ALLOWANCE set (e.g. 300 on Pro,
// 1500 on Pro+), the Copilot status line gets the band's idea of "what's left, and what's coming":
// requests left this month, the pace, the day it runs out at that pace, and what the next prompts use.
// The month is the calendar month (GitHub resets on the 1st, UTC).

export type Premium = { used: number, allowance: number, left: number, pct: number, per_day: number,
  projected: number, runs_out: string | null, next: number, steps: number, over: boolean }

export function copilotAllowance(): { monthly: number, multiplier: number } | null {
  const monthly = budgetNum('AGENTARIUM_COPILOT_ALLOWANCE')
  if (!monthly) return null
  return { monthly, multiplier: budgetNum('AGENTARIUM_COPILOT_MULTIPLIER') ?? 1 }
}

/** Copilot this calendar month: prompts, the premium requests they used (each at the multiplier
 *  recorded with it, else `fallback`), and the newest prompt's multiplier; null if unreadable. */
export function copilotUsage(d = new Date(), fallback = 1): { prompts: number, requests: number, last: number | null } | null {
  return readDb((db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_events'").get()) return { prompts: 0, requests: 0, last: null }
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const has = hasColumn(db, 'telemetry_events', 'premium')
    const row = db.prepare(`SELECT COUNT(*) AS n, ${has ? 'COALESCE(SUM(COALESCE(premium, ?)),0)' : 'COUNT(*) * ?'} AS r FROM telemetry_events ` +
      "WHERE platform IN ('copilot','vscode') AND type='prompt' AND substr(ts,1,7)=?").get(fallback, month) as Obj | undefined
    const last = has ? db.prepare("SELECT premium FROM telemetry_events WHERE platform IN ('copilot','vscode') AND type='prompt' AND premium IS NOT NULL " +
      'ORDER BY id DESC LIMIT 1').get() as Obj | undefined : undefined
    return { prompts: Number(row?.n) || 0, requests: Number(row?.r) || 0, last: last ? Number(last.premium) : null }
  }, { prompts: 0, requests: 0, last: null })
}

/** Copilot Fusion's selection id or display name ("copilot-fusion-high") -> "Fusion High". */
export function fusionLabel(id: string): string {
  const level = /fusion[\s_-]*(standard|high|max|fast)\b/i.exec(id)?.[1]
  return level ? `Fusion ${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}` : 'Fusion'
}

/** The model Copilot Fusion routed to most recently, from the prompts the hooks recorded (this
 *  session's when `sid` is given): what Fusion's model picker entry doesn't say. Null when no
 *  prompt was routed, or the database has no router column yet. */
export function copilotRoute(sid?: string | null): { model: string, router: string } | null {
  return readDb((db) => {
    if (!hasColumn(db, 'telemetry_events', 'router')) return null
    const row = db.prepare("SELECT model, router FROM telemetry_events WHERE platform IN ('copilot','vscode') AND type='prompt' " +
      `AND router IS NOT NULL AND model IS NOT NULL AND model != router${sid ? ' AND session_id = ?' : ''} ORDER BY id DESC LIMIT 1`)
      .get(...(sid ? [sid] : [])) as Obj | undefined
    return row ? { model: String(row.model), router: String(row.router) } : null
  }, null)
}

/** The month so far -> requests left, pace, projected total, the day they run out at that pace.
 *  `usage` (from copilotUsage) counts each prompt at its own model's multiplier and prices the
 *  next prompts at the newest one; without it every prompt counts at `a.multiplier`. */
export function premiumOutlook(prompts: number, a: { monthly: number, multiplier: number }, d = new Date(), steps = FORECAST_STEPS,
  usage?: { requests: number, last: number | null } | null): Premium {
  const used = usage ? usage.requests : prompts * a.multiplier
  const perPrompt = usage?.last ?? a.multiplier
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const daysIn = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const elapsed = Math.max(1, (d.getTime() - Date.UTC(y, mo, 1)) / 86400_000)    // at least a day, so day one isn't wild
  const perDay = used / elapsed
  const left = a.monthly - used
  let runsOut: string | null = null
  if (left <= 0) runsOut = 'now'
  else if (perDay > 0) {
    const at = new Date(d.getTime() + left / perDay * 86400_000)
    if (at.getUTCMonth() === mo && at.getUTCFullYear() === y) runsOut = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`
  }
  return { used: Math.round(used * 10) / 10, allowance: a.monthly, left: Math.round(left * 10) / 10,
    pct: Math.round(used / a.monthly * 100), per_day: Math.round(perDay * 10) / 10, projected: Math.round(perDay * daysIn),
    runs_out: runsOut, next: Math.round(steps * perPrompt * 100) / 100, steps, over: left <= 0 }
}

/** The Copilot row under the status line: '↳ 212 of 300 requests left · ~9/day · runs out ~27 Nov'. */
export function renderPremium(p: Premium | null, style: Style): string {
  if (!p) return ''
  const a = style.ascii
  const sep = style.paint(a ? ' | ' : '  ·  ', 'sep')
  const dim = (t: string) => style.paint(t, 'dim')
  const fig = (t: string, key: string = 'text') => style.paint(t, key, true)
  const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const tight = p.over || p.pct >= 80 || p.runs_out !== null
  const parts = [dim(a ? '> ' : '↳ ') + (p.over ? fig(`${fmtN(p.used)} of ${p.allowance}`, 'red') + style.paint(' premium requests · over', 'red')
    : fig(`${fmtN(p.left)} of ${p.allowance}`, tight ? 'yellow' : 'text') + dim(' premium requests left this month'))]
  parts.push(fig(`~${fmtN(p.per_day)}`) + dim('/day'))
  if (p.runs_out && p.runs_out !== 'now') {
    const dt = new Date(`${p.runs_out}T12:00:00Z`)
    parts.push(fig(`runs out ~${dt.getUTCDate()} ${dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`, 'yellow') + dim(' at this pace'))
  } else if (!p.over) parts.push(dim(`~${p.projected} by month end`))
  parts.push(dim(`next ${p.steps} prompts use `) + fig(fmtN(p.next)))
  return parts.join(sep)
}

/** Copilot today (UTC, like the month): prompts and the premium requests they used. */
export function copilotToday(d = new Date(), fallback = 1): { prompts: number, requests: number } {
  return readDb((db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_events'").get()) return { prompts: 0, requests: 0 }
    const day = d.toISOString().slice(0, 10)
    const has = hasColumn(db, 'telemetry_events', 'premium')
    const row = db.prepare(`SELECT COUNT(*) AS n, ${has ? 'COALESCE(SUM(COALESCE(premium, ?)),0)' : 'COUNT(*) * ?'} AS r FROM telemetry_events ` +
      "WHERE platform IN ('copilot','vscode') AND type='prompt' AND substr(ts,1,10)=?").get(fallback, day) as Obj | undefined
    return { prompts: Number(row?.n) || 0, requests: Math.round((Number(row?.r) || 0) * 10) / 10 }
  }, { prompts: 0, requests: 0 })
}

export type CopilotStatus = { show: false } | { show: true, platform: 'copilot', level: 'green' | 'yellow' | 'red',
  short: string, text: string, today: { prompts: number, requests: number }, month_prompts: number,
  premium: Premium | null, hint: string | null }

/** Copilot's live numbers (VS Code's status bar item, the Copilot app's window), from the
 *  database alone: Copilot gives no live payload, so there is no context gauge or cache timer, only
 *  the premium requests. `short` fits a status bar; `text` is the status line's Copilot row. */
export function copilotStatus(d = new Date()): CopilotStatus {
  if (!bandWanted()) return { show: false }
  const a = copilotAllowance()
  const u = copilotUsage(d, a?.multiplier ?? 1)
  const today = copilotToday(d, a?.multiplier ?? 1)
  const month = u?.prompts ?? 0
  const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const day = `${today.prompts} prompt${today.prompts === 1 ? '' : 's'} today`
  if (!a) {
    return { show: true, platform: 'copilot', level: 'green', short: day, text: `${day} · ${month} this month`,
      today, month_prompts: month, premium: null,
      hint: 'Set AGENTARIUM_COPILOT_ALLOWANCE (e.g. 300) to see the premium requests left and when they run out.' }
  }
  const p = premiumOutlook(month, a, d, FORECAST_STEPS, u)
  const level = p.over ? 'red' : p.pct >= 80 || p.runs_out !== null ? 'yellow' : 'green'
  let short = p.over ? `${fmtN(p.used)}/${p.allowance} premium · over` : `${fmtN(p.left)}/${p.allowance} premium left`
  if (p.runs_out && p.runs_out !== 'now') {
    const dt = new Date(`${p.runs_out}T12:00:00Z`)
    short += ` · runs out ~${dt.getUTCDate()} ${dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
  }
  const text = renderPremium(p, new Style('dark', false)).replace(/^↳ /, '')
  return { show: true, platform: 'copilot', level, short, text, today, month_prompts: month, premium: p, hint: null }
}

/** --copilot: Copilot's live numbers as one plain line, or as JSON with --json. Never fails. */
function copilotCmd(args: string[]): number {
  try {
    const b = copilotStatus()
    process.stdout.write(args.includes('--json') ? JSON.stringify(b) : b.show ? b.text : '')
  } catch {
    process.stdout.write(args.includes('--json') ? '{}' : '')
  }
  return 0
}

/** The outlook's tip as a sentence to follow the static line ('' when there's none). */
export function tipText(o: Outlook | null, symbol: string): string {
  if (!o) return ''
  const parts = [`next ${o.steps} steps ~${money(o.forecast, symbol)}`]
  if (o.budget) parts.push(`${money(Math.max(0, o.budget.left), symbol)}${o.budget.kind === 'task' ? ` of ${money(o.budget.limit, symbol)}` : ''} ` +
    `left ${budgetWhen(o.budget.kind)}`)
  if (o.tip) parts.push(`${o.tip.action} saves ~${money(o.tip.saves, symbol)} (${o.tip.why})`)
  if (o.saved >= 0.005) parts.push(`sommelier saved ~${money(o.saved, symbol)} this session`)
  return `\n${parts.join(' · ')}`
}

/** The outlook as the band's JSON: money already formatted, in the display currency. */
export function outlookJson(o: Outlook | null, symbol: string): Obj | null {
  if (!o) return null
  const m = (v: number) => money(v, symbol)
  return {
    step: m(o.step), forecast: m(o.forecast), steps: o.steps, at_risk: o.at_risk >= 0.005 ? m(o.at_risk) : null, cold: o.cold,
    budget: o.budget && { kind: o.budget.kind, left: m(Math.max(0, o.budget.left)), limit: m(o.budget.limit),
      used_pct: o.budget.limit > 0 ? Math.round(o.budget.spent / o.budget.limit * 100) : 100, steps_left: o.budget.steps_left, over: o.budget.left <= 0 },
    tip: o.tip && { action: o.tip.action, saves: m(o.tip.saves), why: o.tip.why, kind: o.tip.kind },
    saved: o.saved >= 0.005 ? m(o.saved) : null,
  }
}

// ----------------------------------------------------------------------------- render ----

/** The context gauge: a slim bar (a heavy rule on a light one, with a half step) that warms
 *  from green to red along its length; `#` and `-` with --ascii. Always `width` cells. */
export function gauge(style: Style, pct: number, width: number, warn: number, crit: number): string {
  if (style.ascii) {
    const filled = roundHalfEven(pct / 100 * width)
    return style.paint('#'.repeat(filled) + '-'.repeat(Math.max(0, width - filled)), levelColor(style, pct, warn, crit))
  }
  const halves = roundHalfEven(pct / 100 * width * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2 === 1
  const out: string[] = []
  for (let i = 0; i < width; i++) {
    const col = levelColor(style, (i + 0.5) / width * 100, warn, crit)
    if (i < full) out.push(style.paint('━', col))
    else if (i === full && half) out.push(style.paint('╸', col))
    else out.push(style.paint('─', 'track'))
  }
  return out.join('')
}

const PIE = ['●', '◕', '◑', '◔', '○']          // full ... empty

/** The cache icons: full, half, empty (AGENTARIUM_TIMER_ICONS overrides them). */
export function timerIcons(): string[] {
  const custom = process.env.AGENTARIUM_TIMER_ICONS
  if (custom && custom.split(',').length === 3) return custom.split(',')
  return [PIE[0], PIE[2], PIE[4]]
}

/** The cache icon for `frac` of the TTL left: a five-step pie clock, or the custom three. */
export function timerIcon(frac: number): string {
  const custom = process.env.AGENTARIUM_TIMER_ICONS
  if (custom && custom.split(',').length === 3) {
    const [full, half, empty] = custom.split(',')
    return frac <= 0 ? empty : frac > 0.75 ? full : frac > 0.25 ? half : empty
  }
  if (frac <= 0) return PIE[4]
  return PIE[Math.min(3, Math.floor((1 - frac) * 4))]
}

/** Warm green -> amber halfway -> red as the cache runs down. */
function cacheColor(style: Style, frac: number): RGB {
  const { green: g, yellow: y, red: r } = style.p
  if (frac <= 0) return r
  return frac >= 0.5 ? lerp(y, g, (frac - 0.5) * 2) : lerp(r, y, frac * 2)
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** One status line. isStatic=true is for a message that won't redraw: the countdown also says
 *  when (local clock time) the cache goes cold. */
export function render(info: Info, style: Style, cfg: Obj, isStatic = false): string {
  const warn = Number(cfg.warn)
  const crit = Number(cfg.crit)
  const a = style.ascii
  const sep = style.paint(a ? ' | ' : '  ·  ', 'sep')
  const unit = (s: string) => style.paint(` ${s}`, 'dim')
  const parts: string[] = []

  // model: a pill in colour; a mark before the name without
  const name = info.model || 'agentarium'
  if (a) parts.push(style.paint(info.model ? `* ${info.model.replaceAll('→', '->')}` : '*', 'accent', true))
  else if (style.color) parts.push(style.pill(name))
  else parts.push(`✦ ${name}`)

  // context: gauge, then the percentage in the gauge's colour at that point
  const pct = info.pct
  const col = levelColor(style, pct, warn, crit)
  const full = pct >= crit
  parts.push(gauge(style, pct, Math.trunc(Number(cfg.width)), warn, crit) + ' ' +
    style.paint(`${pct.toFixed(0)}%`, col, true) + (full ? style.paint(a ? ' ctx!' : ' ctx ▲', col) : unit('ctx')))

  parts.push(style.paint(human(info.total), 'text', true) + unit('tok'))

  parts.push((info.estimated ? style.paint('~', 'dim') : '') + style.paint(money(info.cost, info.symbol ?? '£'), 'text', true))

  // the cache countdown
  const rem = info.remaining
  const ttl = info.ttl
  if (rem === null) {
    parts.push(style.paint(a ? '[  ] --:--' : `${PIE[4]} --:--`, 'dim') + unit('cache'))
  } else {
    const frac = ttl ? rem / ttl : 0
    let icon = timerIcon(frac)
    if (a) icon = rem <= 0 ? '[  ]' : frac > 0.75 ? '[##]' : frac > 0.25 ? '[# ]' : '[  ]'
    const c = cacheColor(style, frac)
    const when = isStatic && rem > 0 ? ` (cold at ${hhmm(new Date(Date.now() + rem * 1000))})` : ''
    if (rem <= 0) parts.push(style.paint(icon, c, true) + style.paint(' cache cold', 'red', true))
    else parts.push(style.paint(`${icon} ${mmss(rem)}`, c, true) + unit('cache') + (when ? style.paint(when, 'dim') : ''))
  }
  return parts.join(sep)
}

/** The outlook as a second terminal row under the line: the band's forecast row, in the
 *  terminal. '' when there's nothing to forecast. Words match the band (hooks/band.tsx). */
export function renderOutlook(o: Outlook | null, info: Info, style: Style): string {
  if (!o) return ''
  const a = style.ascii
  const sym = info.symbol ?? '£'
  const m = (v: number) => money(v, sym)
  const sep = style.paint(a ? ' | ' : '  ·  ', 'sep')
  const dim = (s: string) => style.paint(s, 'dim')
  const fig = (s: string, key: string = 'text') => style.paint(s, key, true)
  const parts: string[] = [dim(a ? '> ' : '↳ ') + fig(m(o.forecast)) + dim(` next ${o.steps} steps`)]

  const b = o.budget
  if (b) {
    const when = budgetWhen(b.kind)
    if (b.left <= 0) {
      parts.push(fig(`${m(b.limit)} spent`, 'red') + style.paint(` budget ${when} · over`, 'red'))
    } else {
      const tight = (b.steps_left ?? Infinity) < o.steps || (b.limit <= 0 || b.spent / b.limit >= 0.8)
      const steps = b.steps_left === null ? '' : ` · ~${b.steps_left} step${b.steps_left === 1 ? '' : 's'}`
      // a task's price: "£0.80 of £2.00 left this task", so the agreed price stays in view
      const of = b.kind === 'task' ? dim(` of ${m(b.limit)}`) : ''
      parts.push(fig(`${m(b.left)}`, tight ? 'yellow' : 'text') + of + fig(' left', tight ? 'yellow' : 'text') + dim(` ${when}${steps}`))
    }
  }

  if (o.at_risk >= 0.005) {
    parts.push(o.cold ? fig(`+${m(o.at_risk)}`, 'red') + style.paint(' cache cold · next prompt', 'red')
      : fig(m(o.at_risk)) + dim(' at risk if the cache goes cold'))
  }

  if (o.tip) {
    const rem = info.remaining
    const action = o.tip.kind === 'warm' ? (rem && rem > 0 ? `reply within ${mmss(rem)}` : '') : o.tip.action
    if (action) parts.push(style.paint(a ? '-> ' : '→ ', 'accent', true) + fig(action) + dim(` saves ~${m(o.tip.saves)}`))
  }
  if (o.saved >= 0.005) parts.push(fig(m(o.saved), 'green') + dim(' saved by sommelier'))
  return parts.join(sep)
}

/** The outlook row on the terminal status line: on unless AGENTARIUM_OUTLOOK=off or `outlook: false`. */
export function outlookWanted(cfg: Obj): boolean {
  const env = (process.env.AGENTARIUM_OUTLOOK ?? '').trim().toLowerCase()
  if (['off', '0', 'false', 'no'].includes(env)) return false
  if (['on', '1', 'true', 'yes'].includes(env)) return true
  return cfg.outlook !== false
}

// ----------------------------------------------------------------------------- commands --

function makeStyle(cfg: Obj, state: Obj, args: string[]): Style {
  let theme: string = cfg.theme
  const t = flag(args, '--theme')
  if (t !== null) theme = t.toLowerCase()
  if (theme !== 'light' && theme !== 'dark') theme = systemTheme(state)
  const color = !args.includes('--no-color') && !process.env.NO_COLOR
  const asciiOnly = args.includes('--ascii') || process.env.AGENTARIUM_ASCII === '1'
  return new Style(theme, color, asciiOnly)
}

let stdinPayload: Obj | null = null

function readPayload(): Obj {
  if (stdinPayload !== null) return stdinPayload
  stdinPayload = {}
  if (process.stdin.isTTY) return stdinPayload
  try {
    const raw = readFileSync(0, 'utf8')
    const v = raw.trim() ? JSON.parse(raw) : {}
    stdinPayload = isObj(v) ? v : {}
  } catch {
    stdinPayload = {}
  }
  return stdinPayload
}

/** Newest Claude Code or Copilot transcript on this machine (for --watch). */
function discoverSession(): string | null {
  let best: string | null = null
  let bestM = 0
  for (const root of [join(HOME, '.claude', 'projects'), join(HOME, '.copilot', 'session-state')]) {
    if (!isDir(root)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(root, { recursive: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue
      const m = mtime(join(root, rel))
      if (m > bestM) [best, bestM] = [join(root, rel), m]
    }
  }
  return best
}

function demo(args: string[]): number {
  const cfg = loadCfg()
  const style = makeStyle(cfg, {}, args)
  const lines = [`theme: ${style.theme}`, '']
  const cases: [number, number, number, number][] = [[8, 290, 12_300, 0.04], [52, 200, 480_000, 0.42],
    [76, 120, 2_100_000, 1.37], [84, 70, 5_400_000, 3.9], [92, 12, 8_500_000, 6.21], [97, 0, 12_800_000, 14.8]]
  const [, symbol, rate] = currency(cfg)
  for (const [pct, rem, total, usd] of cases) {
    lines.push(render({ model: 'Sonnet 5.5', total, cost: usd * rate, symbol, estimated: false, pct, ttl: 300, remaining: rem }, style, cfg))
  }
  lines.push(render({ model: 'gpt-5', total: 0, cost: 0, symbol, estimated: true, pct: 0, ttl: 300, remaining: null }, style, cfg))
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function watch(args: string[]): void {
  const path = flag(args, '--path')
  const cfg = loadCfg()
  const tick = () => {
    const state = loadState()
    const style = makeStyle(cfg, state, args)
    const target = path || discoverSession()
    const line = render(gather(target ? { transcript_path: target } : {}, cfg, state), style, cfg)
    saveState(state)
    process.stdout.write('\r\x1b[2K' + line)
  }
  tick()
  setInterval(tick, 1000)
  process.on('SIGINT', () => {
    process.stdout.write('\n')
    process.exit(0)
  })
}

const BAND_FILE = join(CFG_DIR, 'band-sessions.json')

export function bandSessions(): Obj {
  try {
    const data = readJson(BAND_FILE)
    return isObj(data) ? data : {}
  } catch {
    return {}
  }
}

/** Remember that the band draws the line in this session, so --message stays quiet there. */
function bandDrawn(sessionId: string): void {
  const seen = bandSessions()
  if (sessionId in seen) return
  seen[sessionId] = nowS()
  const keep = Object.fromEntries(Object.entries(seen).sort((a, b) => a[1] - b[1]).slice(-50))   // keep the newest 50
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(BAND_FILE, JSON.stringify(keep), 'utf8')
  } catch {
    // only a hint for --message
  }
}

/** The band is on unless AGENTARIUM_BAND=off or "band": false in the config (--band-off).
 *  It doesn't depend on the CLI status line: a terminal can have its own status line set and the
 *  desktop app still gets the band. */
export function bandWanted(cfg?: Obj): boolean {
  const env = (process.env.AGENTARIUM_BAND ?? '').trim().toLowerCase()
  if (['off', '0', 'false', 'no'].includes(env)) return false
  if (['on', '1', 'true', 'yes'].includes(env)) return true
  return (cfg ?? loadCfg()).band !== false
}

/** The line's parts, already formatted, for the band (hooks/band.tsx). The band draws
 *  and ticks the countdown itself, from `cold_at` (epoch seconds; null: nothing cached yet).
 *  {"show": false} when the band is off. `--band SESSION_ID`: the band is showing it
 *  in that session, so the after-reply message stays quiet there. */
function asJson(args: string[]): number {
  try {
    if (!bandWanted()) {
      process.stdout.write(JSON.stringify({ show: false }))   // --band-off / AGENTARIUM_BAND=off
      return 0
    }
    const sid = flag(args, '--band')
    if (sid !== null) bandDrawn(sid)
    const cfg = loadCfg()
    const state = loadState()
    const info = gather(readPayload(), cfg, state)
    saveState(state)
    const warn = Number(cfg.warn)
    const crit = Number(cfg.crit)
    const pct = info.pct
    const style = new Style('dark', false, args.includes('--ascii'))
    const rem = info.remaining
    process.stdout.write(JSON.stringify({
      show: true, model: info.model, pct: Math.round(pct * 10) / 10,
      level: pct >= crit ? 'red' : pct >= warn ? 'yellow' : 'green',
      gauge: gauge(style, pct, Math.trunc(Number(cfg.width)), warn, crit),
      tokens: human(info.total),
      cost: (info.estimated ? '~' : '') + money(info.cost, info.symbol ?? '£'),
      ttl: info.ttl, cold_at: rem === null ? null : nowS() + rem,
      icons: timerIcons(),
      outlook: outlookJson(outlook(info, cfg), info.symbol ?? '£'),
    }))
  } catch {
    process.stdout.write('{}')
  }
  return 0
}

// ----------------------------------------------------------------------------- apps ------
// Claude Code only draws `statusLine` in the terminal. In the apps, hooks/band.tsx (a mod) shows
// the line from --json: the mod's row in the band above the prompt box, VS Code's plugin status line entry.
// Where mods can't run (older Claude Code, mods off), the apps still show a hook's
// "systemMessage", so the Stop hook posts the line once per reply instead.
// CLAUDE_CODE_ENTRYPOINT says where Claude Code runs.

const APP_ENTRYPOINTS = ['desktop', 'vscode', 'jetbrains', 'ide']

/** True when Claude Code runs inside an app that doesn't draw status lines. */
export function inApp(): boolean {
  const entry = (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').trim().toLowerCase()
  return APP_ENTRYPOINTS.some((k) => entry.includes(k))
}

/** Stop hook: the band's stand-in where mods can't run. Prints {"systemMessage": <the line as
 *  plain text>} in the desktop app or VS Code while the band is on and hasn't drawn in this
 *  session; otherwise nothing (the terminal has its status line). Never fails. */
function message(): number {
  try {
    const payload = readPayload()
    if (!inApp() || !bandWanted()) return 0
    if (payload.stop_hook_active) return 0                 // a hook made Claude continue: wait for the real end
    if (payload.session_id in bandSessions()) return 0     // the band already shows it
    const cfg = loadCfg()
    const state = loadState()
    const style = new Style('dark', false, process.env.AGENTARIUM_ASCII === '1')
    const info = gather(payload, cfg, state)
    const line = render(info, style, cfg, true) + tipText(outlook(info, cfg), info.symbol ?? '£')
    saveState(state)
    process.stdout.write(JSON.stringify({ systemMessage: line }))
  } catch {
    // never in the way
  }
  return 0
}

function saveCfg(changes: Obj): void {
  let cfg: Obj = {}
  try {
    const data = readJson(CFG_FILE)
    if (isObj(data)) cfg = data
  } catch {
    // start a new one
  }
  Object.assign(cfg, changes)
  mkdirSync(CFG_DIR, { recursive: true })
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

async function updateRate(): Promise<number> {
  const url = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR'
  let usdGbp: number
  let usdEur: number
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const rates = ((await r.json()) as Obj).rates
    usdGbp = num(rates.GBP)
    usdEur = num(rates.EUR)
  } catch (e) {
    process.stdout.write(`Could not fetch the rates (${e instanceof Error ? e.message : e}). Set them by hand: AGENTARIUM_USD_GBP=0.76, ` +
      `AGENTARIUM_USD_EUR=0.86, or "usd_gbp" / "usd_eur" in ${CFG_FILE}\n`)
    return 1
  }
  saveCfg({ usd_gbp: usdGbp, usd_eur: usdEur })
  process.stdout.write(`USD->GBP = ${usdGbp}, USD->EUR = ${usdEur} saved to ${CFG_FILE}\n`)
  return 0
}

function setCurrency(value: string | null): number {
  const code = currencyCode(value)
  if (!code) {
    process.stdout.write(`Unknown currency ${JSON.stringify(value)}: use one of ${Object.keys(CURRENCIES).join(', ')}.\n`)
    return 1
  }
  saveCfg({ currency: code })
  process.stdout.write(`Costs will now show in ${code} (${CURRENCIES[code][0]}). Saved to ${CFG_FILE}\n`)
  return 0
}

/** Value after `name` in args, or null. */
function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name)
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null
}

/** A CLI settings file that isn't valid JSON: nothing is changed. */
export class SettingsError extends Error {}

function readSettings(path: string): Obj {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const data = JSON.parse(text)
    if (!isObj(data)) throw new Error('not an object')
    return data
  } catch {
    throw new SettingsError(`${path} is not valid JSON; fix it first (nothing was changed).`)
  }
}

/** Where a CLI's settings are kept as they were before agentarium first changed them. */
export const backupPath = (path: string) => join(dirname(path), basename(path) + '.agentarium.bak')

/** Write a CLI's settings, only if they change. The first change backs the file up to backupPath(),
 *  and no later one replaces that copy: a re-run never turns the backup into agentarium's own file. */
function writeSettings(path: string, data: Obj): boolean {
  let before: string | null = null
  try {
    before = readFileSync(path, 'utf8')
  } catch {
    // no file before agentarium: an empty one is what it was, so a later change can't back up ours
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(backupPath(path))) writeFileSync(backupPath(path), '{}\n', 'utf8')
  }
  if (before !== null) {
    try {
      if (JSON.stringify(JSON.parse(before)) === JSON.stringify(data)) return false
    } catch {
      // readSettings refused a file that isn't JSON before this was reached
    }
    if (!existsSync(backupPath(path))) copyFileSync(path, backupPath(path))
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return true
}

export function settingsPath(target: string): string {
  if (target === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'settings.json')
  if (target === 'copilot') return join(process.env.COPILOT_HOME || join(HOME, '.copilot'), 'settings.json')
  throw new SettingsError('target must be claude, copilot or both')
}

export function installedCopy(): string {
  return join(CFG_DIR, COPY_NAME)
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Copy this script and the price list to a stable path that survives plugin updates. */
function copyFiles(): string {
  mkdirSync(CFG_DIR, { recursive: true })
  const dest = installedCopy()
  if (!samePath(SELF, dest)) replaceFile(SELF, dest)
  for (const prices of MODEL_PRICES_FILES.slice(1)) {        // prices travel with it
    if (isFile(prices)) {
      replaceFile(prices, join(CFG_DIR, 'model-prices.json'))
      break
    }
  }
  return dest
}

/** Put a copy of `src` at `dest`, unless it's there already: written beside it and renamed into
 *  place, so the status line, which runs `dest` every second, never reads half a file. */
function replaceFile(src: string, dest: string): void {
  if (same(src, dest)) return
  const tmp = `${dest}.${process.pid}.tmp`
  copyFileSync(src, tmp)
  try {
    renameSync(tmp, dest)
  } catch {
    copyFileSync(tmp, dest)                                  // Windows, with dest open this instant
    rmSync(tmp, { force: true })
  }
}

/** The statusLine command in a CLI's settings, or null. Never throws. */
export function statusLine(target: string): string | null {
  try {
    const line = (readJson(settingsPath(target)) as Obj).statusLine
    return isObj(line) && line.command ? String(line.command) : null
  } catch {
    return null
  }
}

export function isOurs(command: string | null): boolean {
  return Boolean(command) && command!.includes(CFG_DIR) && command!.includes(COPY_NAME)
}

/** AGENTARIUM_STATUSLINE: auto, ask or off. */
const statuslineMode = () => (process.env.AGENTARIUM_STATUSLINE ?? '').trim().toLowerCase()

const HINT_FILE = join(CFG_DIR, 'statusline-offered')
const quiet = () => {}

// agentarium was tokenomics until 0.0.1. A status line still running tokenomics's copy is an older
// install of this one, so migrate() moves it over. tokenomics's own files are left as they are.
const TOKENOMICS_DIR = process.env.TOKENOMICS_HOME || join(HOME, '.tokenomics')
const TOLD_FILE = join(CFG_DIR, 'tokenomics-told')
/** Written by scripts/import.ts once tokenomics's history is in. */
export const IMPORTED_FILE = join(CFG_DIR, 'tokenomics-import.json')

/** A status line that runs tokenomics's copy of this script. */
export const isTokenomics = (command: string | null): boolean =>
  Boolean(command) && command!.includes(TOKENOMICS_DIR) && command!.includes(COPY_NAME)

/** Point a status line that still runs tokenomics's copy at ours. The CLIs moved; never throws. */
export function migrate(): string[] {
  const moved: string[] = []
  for (const t of ['claude', 'copilot']) {
    try {
      if (isTokenomics(statusLine(t))) {
        install(t, { out: quiet })
        moved.push(t)
      }
    } catch {
      // never in the way
    }
  }
  return moved
}

/** Claude Code still has the tokenomics plugin on, so its hooks run beside these: every prompt and
 *  tool call checked twice, and two notices for one problem. */
export function tokenomicsPluginOn(): boolean {
  try {
    const on = (readJson(settingsPath('claude')) as Obj).enabledPlugins
    return isObj(on) && Object.entries(on).some(([k, v]) => k.startsWith('tokenomics@') && v === true)
  } catch {
    return false
  }
}

/** What's left to do after a move from tokenomics, said once (null: nothing, or said already). */
function tokenomicsNote(moved: string[]): string | null {
  if (existsSync(TOLD_FILE)) return null
  const parts: string[] = []
  if (moved.length) parts.push("The status line is agentarium's now.")
  if (tokenomicsPluginOn()) parts.push('tokenomics is still installed, so every prompt is checked twice: /plugin uninstall tokenomics@tokenomics removes it.')
  if (isFile(join(TOKENOMICS_DIR, 'spendlens.db')) && !existsSync(IMPORTED_FILE)) {
    const where = TOKENOMICS_DIR.startsWith(HOME) ? `~${TOKENOMICS_DIR.slice(HOME.length)}` : TOKENOMICS_DIR
    parts.push(`tokenomics's history is in ${where}: \`agentarium import\` brings it over and leaves tokenomics's files as ` +
      `they are (without that command: sh "${join(HERE, 'run.sh')}" import.ts).`)
  }
  if (!parts.length) return null
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(TOLD_FILE, new Date().toISOString(), 'utf8')
  } catch {
    // said every session until it can be noted: still better than never
  }
  return `agentarium, moving from tokenomics: ${parts.join(' ')}`
}

/** The command the CLIs run: this Node.js, and the installed copy. */
function command(): string {
  return `"${process.execPath}" --disable-warning=ExperimentalWarning "${installedCopy()}"`
}

export function install(target: string, opts: { remove?: boolean, keepExisting?: boolean, out?: (s: string) => void } = {}): void {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'))
  let targets = target === 'both' ? ['claude', 'copilot'] : [target]
  for (const t of targets) settingsPath(t)                   // validate before touching anything
  if (opts.keepExisting) {                                   // never replace someone else's status line
    const theirs = (t: string) => {                         // tokenomics's copy is an older one of ours
      const line = statusLine(t)
      return line !== null && !isOurs(line) && !isTokenomics(line)
    }
    for (const t of targets) {
      if (theirs(t)) out(`Skipped ${t}: it already has a status line (${statusLine(t)}). Run --install ${t} to replace it.`)
    }
    targets = targets.filter((t) => !theirs(t))
    if (!targets.length) return
  }
  const dest = opts.remove ? installedCopy() : copyFiles()
  let changed = false
  for (const t of targets) {
    const path = settingsPath(t)
    const data = readSettings(path)
    if (t === 'claude') {
      if (opts.remove) delete data.statusLine
      else data.statusLine = { type: 'command', command: command(), padding: 0, refreshInterval: 1 }
    } else {
      data.feature_flags = isObj(data.feature_flags) ? data.feature_flags : {}
      data.feature_flags.enabled = Array.isArray(data.feature_flags.enabled) ? data.feature_flags.enabled : []
      if (opts.remove) {
        delete data.statusLine
      } else {
        data.statusLine = { type: 'command', command: command(), padding: 1 }
        if (!data.feature_flags.enabled.includes('STATUS_LINE')) data.feature_flags.enabled.push('STATUS_LINE')
      }
    }
    if (!writeSettings(path, data)) {
      out(`${opts.remove ? 'Not set in' : 'Already set in'} ${path}`)
      continue
    }
    changed = true
    const bak = existsSync(backupPath(path)) ? ` (as it was before agentarium: ${basename(backupPath(path))})` : ''
    out(`${opts.remove ? 'Removed from' : 'Installed in'} ${path}${bak}`)
  }
  if (!opts.remove && changed) out(`Restart the CLI to pick it up. Preview: node "${dest}" --demo --theme light`)
}

function status(): number {
  const lines: string[] = []
  for (const t of ['claude', 'copilot']) {
    const cmd = statusLine(t)
    const where = settingsPath(t)
    if (isOurs(cmd)) lines.push(`${t} status line: installed (${where})`)
    else if (isTokenomics(cmd)) lines.push(`${t} status line: tokenomics's copy (agentarium's replaces it at the next session start)`)
    else if (cmd) lines.push(`${t} status line: another status line is set in ${where}: ${cmd}`)
    else lines.push(`${t} status line: not installed`)
  }
  lines.push('claude band row (desktop app, VS Code): ' + (bandWanted() ? 'on' : 'off') + (process.env.AGENTARIUM_BAND ? ' (AGENTARIUM_BAND)' : ''))
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function setOutlook(on: boolean): number {
  saveCfg({ outlook: on })
  process.stdout.write(`The forecast row under the terminal status line is now ${on ? 'on' : 'off'}. Saved to ${CFG_FILE}\n`)
  return 0
}

function setBand(on: boolean): number {
  saveCfg({ band: on })
  process.stdout.write(`agentarium's row in the band (desktop app, VS Code) is now ${on ? 'on' : 'off'}; it changes at the next ` +
    `reply. Saved to ${CFG_FILE}\n`)
  return 0
}

function same(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/** True when the installed copy or its price list differs from the one beside this script. */
function outOfDate(): boolean {
  if (!same(installedCopy(), SELF)) return true
  const prices = MODEL_PRICES_FILES.slice(1).find(isFile)
  return Boolean(prices) && !same(join(CFG_DIR, 'model-prices.json'), prices!)
}

/** SessionStart hook. Quiet and fast; never fails the session.
 *
 *  * Installed already: refresh ~/.agentarium/statusline.mts and the price list from the plugin, so
 *    the status line updates whenever the plugin does.
 *  * No status line at all: install it (AGENTARIUM_STATUSLINE=ask only says once how to; =off
 *    does nothing).
 *  * Someone else's status line: leave it alone. */
function sync(): number {
  readPayload()                                             // the hook payload; not needed
  const said: string[] = []
  try {
    const note = tokenomicsNote(migrate())                  // a status line still on tokenomics's copy moves first
    if (note) said.push(note)
    const mode = statuslineMode()
    const cmd = statusLine('claude')
    if (isOurs(cmd) || isOurs(statusLine('copilot'))) {
      if (outOfDate()) copyFiles()
    } else if (cmd || mode === 'off') {
      // someone else's status line, or none wanted
    } else if (!['ask', 'tip', 'manual'].includes(mode)) {  // default (unset / auto): install it
      install('claude', { out: quiet })
      const where = inApp() ? 'it shows at the bottom of Claude Code in a terminal; here, in the band above the prompt box'
        : 'restart Claude Code to see it'
      said.unshift(`agentarium: status line installed; ${where}. Tip: to get agentarium updates automatically, ` +
        'open /plugin > Marketplaces > agentarium and turn on auto-update.')
    } else if (!existsSync(HINT_FILE)) {
      mkdirSync(CFG_DIR, { recursive: true })
      writeFileSync(HINT_FILE, new Date().toISOString(), 'utf8')
      said.unshift('agentarium: want the live cost and cache status line? Run /agentarium:statusline. This tip shows once.')
    }
  } catch {
    // never in the way
  }
  if (said.length) process.stdout.write(JSON.stringify({ systemMessage: said.join('\n') }))
  return 0
}

async function main(args: string[]): Promise<number> {
  if (args.includes('--install') || args.includes('--uninstall')) {
    const f = args.includes('--install') ? '--install' : '--uninstall'
    const next = args[args.indexOf(f) + 1]
    const target = next && !next.startsWith('-') ? next : 'claude'
    try {
      install(target, { remove: f === '--uninstall', keepExisting: args.includes('--keep-existing') })
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e
      process.stderr.write(e.message + '\n')
      return 1
    }
    return 0
  }
  if (args.includes('--sync')) return sync()
  if (args.includes('--band-on') || args.includes('--band-off')) return setBand(args.includes('--band-on'))
  if (args.includes('--outlook-on') || args.includes('--outlook-off')) return setOutlook(args.includes('--outlook-on'))
  if (args.includes('--message')) return message()
  if (args.includes('--copilot')) return copilotCmd(args)
  if (args.includes('--json')) return asJson(args)
  if (args.includes('--status')) return status()
  if (args.includes('--update-rate')) return updateRate()
  if (args.includes('--set-currency')) return setCurrency(flag(args, '--set-currency'))
  const cur = currencyCode(flag(args, '--currency'))
  if (cur) process.env.AGENTARIUM_CURRENCY = cur              // this run only; beats env and config
  if (args.includes('--demo')) return demo(args)
  if (args.includes('--watch')) {
    watch(args)
    return 0
  }
  try {
    const cfg = loadCfg()
    const state = loadState()
    const style = makeStyle(cfg, state, args)
    const info = gather(readPayload(), cfg, state)
    let line = render(info, style, cfg)
    if (outlookWanted(cfg)) {
      // the band's forecast row, as a second status line row (Claude Code draws each line)
      try {
        const row = renderOutlook(outlook(info, cfg), info, style)
        if (row) line += '\n' + row
        // Copilot: the premium-request allowance instead (it bills requests, not tokens)
        const allowance = info.copilot ? copilotAllowance() : null
        const u = allowance ? copilotUsage(new Date(), allowance.multiplier) : null
        if (allowance && u) line += '\n' + renderPremium(premiumOutlook(u.prompts, allowance, new Date(), FORECAST_STEPS, u), style)
      } catch {
        // the main line still shows
      }
    }
    saveState(state)
    process.stdout.write(line)
  } catch {
    process.stdout.write('agentarium')
  }
  return 0
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2))
