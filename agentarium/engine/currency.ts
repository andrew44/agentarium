/**
 * Display currency (USD, EUR or GBP) for every money figure agentarium shows.
 *
 * The block below is identical to the one in scripts/statusline.ts, which must stay a single
 * self-contained file; tests/features.test.ts checks they agree. All costs are computed in USD
 * (agentarium/engine/pricing.ts) and converted only for display or for comparing with a limit.
 */
import { cfg as loadCfg } from './pricing.ts'

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
  // under half a penny: one significant figure ('£0.004'), since '£0.00' reads as nothing at all
  if (Math.abs(a) > 0 && Math.abs(a) < 0.005) {
    const v = Number(Math.abs(a).toPrecision(1))
    return sign + symbol + v.toFixed(Math.min(20, 1 - Math.floor(Math.log10(v)))).replace(/0+$/, '')
  }
  const digits = Math.abs(a) > 25 ? 0 : 2
  return sign + symbol + Math.abs(a).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
// END CURRENCY

/** [code, symbol, rate per USD] from the environment and ~/.agentarium/statusline.json. */
export function current(config?: Record<string, any> | null): [string, string, number] {
  return currency(config === undefined || config === null ? loadCfg() : config)
}
