#!/usr/bin/env node
/**
 * agentarium / budget: daily and per-session spending limits, in your currency (GBP, USD or EUR).
 *
 * Prompt hook (Claude Code: UserPromptSubmit). Shows a notice at 80% of a limit and pauses the
 * next prompt once a limit is reached; send the same prompt again (or start it with "over-budget:")
 * to carry on. Both say where the money usually goes (engine/lessons.ts). Spend is what till
 * recorded, priced like the status line.
 * Limits are in the display currency: AGENTARIUM_CURRENCY = GBP (default) | USD | EUR.
 * Copilot bills premium requests, not tokens, so it has no spend to budget against.
 *
 * Usage (hook command):  budget.ts [source]      source = claude-code (default) | copilot
 *        budget.ts status                         print today's spend and the limits
 *
 * Env (no limit set = budget does nothing):
 *   AGENTARIUM_BUDGET_DAILY    e.g. 20     per calendar day, all sessions together
 *   AGENTARIUM_BUDGET_SESSION  e.g. 5      per session
 *   AGENTARIUM_BUDGET_MONTHLY  e.g. 500    allowance per billing period; today's limit is what's left
 *                                          of it over the working days left (see engine/allowance.ts:
 *                                          AGENTARIUM_BUDGET_RESET_DAY, _WORKDAYS, _DAYS_OFF)
 *   AGENTARIUM_BUDGET_WARN     80          percent of a limit at which to show a notice
 *   AGENTARIUM_BUDGET_MODE     block (default) | warn (notices only) | off
 *   AGENTARIUM_BUDGET_PROFILE  e.g. frugal: once today's budget passes its warning share, switch to this
 *                              profile for the rest of the day, from the next prompt (opt-in; see profile.ts)
 * Always exits 0 on hook runs; a crash never blocks a prompt (errors go to <db>.err).
 */
import { defaultDbPath, loadSettings } from '../agentarium/config.ts'
import * as budget from '../agentarium/engine/budget.ts'
import * as currency from '../agentarium/engine/currency.ts'
import * as lessons from '../agentarium/engine/lessons.ts'
import * as store from '../agentarium/engine/store.ts'
import { getAdapter } from '../agentarium/platform/registry.ts'
import { errText, isMain, logErr, readPayload } from '../agentarium/util.ts'

function status(): void {
  const lim = budget.loadLimits()
  const [code, symbol, rate] = currency.current()
  const db = store.connect(loadSettings().dbPath)
  let spent: number
  let day: budget.DailyCap | null
  try {
    spent = store.dayCostUsd(db) * rate
    day = budget.dailyCap(db, lim, rate, symbol)
  } finally {
    db.close()
  }
  const show = (v: number | null) => (v !== null ? currency.formatMoney(v, symbol) : 'not set')
  process.stdout.write(`Spent today: ${currency.formatMoney(spent, symbol)} (${code})\n` +
    `Daily limit: ${show(day ? day.cap : null)}${day?.note ? ` (${day.note})` : ''}\n` +
    (lim.monthly ? `Monthly allowance: ${show(lim.monthly)}, resets on day ${lim.calendar.resetDay}\n` : '') +
    `Session limit: ${show(lim.session)}\nMode: ${lim.mode}\n`)
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const arg = argv[0] ?? 'claude-code'
  if (arg === 'status') return status()
  try {
    const limits = budget.loadLimits()
    if (!budget.active(limits)) return
    const payload = readPayload()
    const adapter = getAdapter(arg)
    const prompt = String(payload.prompt || payload.userPrompt || '')
    const db = store.connect(loadSettings().dbPath)
    let d: budget.Decision | null
    try {
      d = budget.check(db, adapter.sessionId(payload), prompt, limits)
      budget.markPhase(db, limits)
    } finally {
      db.close()
    }
    if (d) {
      const msg = d.message + lessons.teach(loadSettings().dbPath, 'over-budget', { sessionId: adapter.sessionId(payload), source: adapter.name })
      const out = d.action === 'blocked' ? adapter.blockPrompt(msg) : adapter.notify(msg)
      if (out) process.stdout.write(JSON.stringify(out) + '\n')
    }
  } catch (e) {
    logErr(defaultDbPath(), `budget\n${errText(e)}`)
  }
}

if (isMain(import.meta.url)) main()
