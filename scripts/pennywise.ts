#!/usr/bin/env node
/**
 * agentarium / pennywise: a model router. "Penny wise, pound foolish": stop paying top-model
 * prices for trivial prompts, and stop sending hard ones to a model that will flounder.
 *
 * Every prompt gets a complexity score from weighted signals (length, code, reasoning words,
 * technical terms, multi-step structure, simple-task phrases, scope) and lands in one of four tiers.
 * Each tier maps to a model, the way an auto-router (LiteLLM's complexity router and the like) does:
 *
 *   SIMPLE    -> haiku     hello-world, rename, typo, commit message, convert JSON
 *   MEDIUM    -> sonnet    a routine feature or test, a short script
 *   COMPLEX   -> opus      refactors, debugging, multi-file or multi-step work
 *   REASONING -> opus      architecture, proofs, security, trade-offs, root causes
 *
 * Two ways to route:
 *
 *   Hook (default, nothing to set up). UserPromptSubmit in Claude Code. Hooks can't switch the
 *   session's model, so pennywise has the session hand the prompt to a subagent on the tier's model
 *   (the Agent tool's `model` parameter) and relay the answer. Routes down to save money, and up when
 *   a prompt is harder than the session's model.
 *   The first few notices also say why the model choice matters and how to pick one yourself
 *   (engine/lessons.ts); a model you chose with 'haiku:' and the like gets no lesson.
 *
 *   Proxy (a true per-request router). `pennywise.ts serve` runs a local Anthropic-API proxy; point
 *   Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:8787 and ANTHROPIC_MODEL=pennywise.
 *   Each new user turn is scored and the request's `model` is rewritten before it goes upstream.
 *   Routing is cache-aware: inside a tool loop the model never changes, and it only moves down to a
 *   cheaper model when the prompt cache is cold or the context is small (a switch means re-writing
 *   the context to the new model's cache). A failed request on a routed model is retried once on
 *   the fallback model.
 *
 * Savings, net of the hand-off. Every route logs what it is worth (estimateHandoff / estimateRequest):
 *   in hook mode the session's own model still reads the conversation to hand the task over and to
 *   relay the answer, so a route down only happens when the work it moves is worth more than that.
 *   The status line, the band, `status` and the weekly report show what pennywise saved.
 *   Measured, too: on the next prompt the hook reads what the routed subagent really used (its
 *   sidechain in the transcript) and logs it next to the estimate; `status` shows both, and `learn`
 *   calibrates the task shape (WORK) from the measured routes.
 *   Cache-aware, too: the hook reads from the transcript whether the session's prompt cache is
 *   still warm. Once it's cold, both staying and handing off start by writing the context again,
 *   and that is what the message prices. A routed task that runs longer than the cache lasts means
 *   the relay re-writes the whole context, which a big warm context makes too dear to hand off.
 *
 * Moving back up. A routed-down answer followed by "that didn't work" / "still failing" sends the
 *   next prompt back to the session's model (hook) or one tier up (proxy), and pennywise learns from it.
 *   Evidence counts as much as words: in the hook, a routed answer whose last check failed, whose
 *   change was reverted or refused, or that groundhog caught looping; in the proxy's tool loop, the
 *   same checks failing twice in a row, a revert, or a groundhog refusal moves up one tier mid-loop.
 *
 * Learning. `learn` (run at every session end) reads which routes held and which missed (escalated,
 *   or kept with 'keep-model:') and moves each tier's threshold, within bounds, for every project
 *   (the repository, or AGENTARIUM_PROJECT) with enough routes of its own, and globally for the rest; bang-for-buck's cost
 *   per *successful* result suggests tier swaps (applied with --apply-tiers). `eval` scores the
 *   labelled prompts in data/pennywise-eval.json.
 *
 * A growing evaluation set. Each escalation, and each 'keep-model:' on a prompt pennywise would have
 *   routed down, is kept as a labelled case (one tier above where it landed) in
 *   ~/.agentarium/pennywise_eval.json: a hash and its score by default, the prompt text only with
 *   AGENTARIUM_PENNYWISE_EVAL=text. `eval --mine` scores them; `eval --check` fails (exit 1) when the
 *   scorer regresses, which CI runs on the shipped set.
 *
 * Per-prompt overrides (both modes): start a prompt with
 *   keep-model:   stay on the session's model
 *   haiku: / sonnet: / opus: / fable:   force that model
 *
 * Commands:
 *   pennywise.ts                      hook (reads the hook JSON on stdin)
 *   pennywise.ts explain "prompt"     show the score, the signals and the model it would pick
 *   pennywise.ts serve [--port N]     run the routing proxy (foreground)
 *   pennywise.ts on|off [--project]   start the proxy in the background and point Claude Code at it
 *                                     (~/.claude/settings.json, or .claude/settings.local.json), or undo it
 *   pennywise.ts status               proxy up?, how prompts are routed, and the last 30 days' savings
 *   pennywise.ts ensure               SessionStart: restart the proxy if Claude Code points at it and it's down
 *   pennywise.ts learn [--dry-run] [--apply-tiers] [--days 60] [--json] [--quiet]
 *   pennywise.ts eval [--mine] [--misses] [--learned] [--json] [--check [--min-accuracy 0.85] [--max-under 3]] [--export]
 *   pennywise.ts env [--port N]       print the shell lines that point Claude Code at the proxy
 *
 * Env:
 *   AGENTARIUM_PENNYWISE   route (default) | block (pause once, suggest /model) | warn | off
 *                          | proxy (the hook steps aside; the proxy does the routing)
 *   AGENTARIUM_PENNYWISE_UP        on (default) | off: also route prompts UP to a stronger model
 *   AGENTARIUM_PENNYWISE_BUDGET    on (default) | off: once a budget (AGENTARIUM_BUDGET_DAILY/_MONTHLY or
 *                                  _SESSION) passes its warning share, route down harder (every tier
 *                                  threshold rises by BUDGET_SQUEEZE) and never route up, so the
 *                                  budget lasts instead of running out mid-task. Both modes: the
 *                                  proxy reads the session from Claude Code's session-id header
 *   AGENTARIUM_PENNYWISE_OVERHEAD  on (default) | off: route down even when the hand-off would eat the saving
 *   AGENTARIUM_PENNYWISE_LEARN     on (default) | off: ignore what `learn` wrote (~/.agentarium/pennywise_learned.json)
 *   AGENTARIUM_PENNYWISE_EVAL      hash (default: keep each miss as a labelled case, hash and score only)
 *                                  | text (keep the prompt text too, so `eval --mine` can re-score it) | off
 *   AGENTARIUM_ROUTER_TIERS        e.g. "SIMPLE=haiku,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable"
 *   AGENTARIUM_ROUTER_PORT         proxy port (default 8787)
 *   AGENTARIUM_ROUTER_UPSTREAM     where the proxy forwards (default https://api.anthropic.com)
 *   AGENTARIUM_ROUTER_MODELS       request model names the proxy routes (default "pennywise,auto");
 *                                  "*" routes every main-model request
 *   AGENTARIUM_ROUTER_FALLBACK     model to retry on when a routed request fails (default: COMPLEX tier)
 *   AGENTARIUM_ROUTER_STICKY_TOKENS  below this context the proxy may move down while the cache is
 *                                  warm (default 20000)
 *   ~/.agentarium/router.json      the same settings as a file: {"tiers": {...}, "thresholds": {...}}
 *   AGENTARIUM_DB                  SQLite path shared with till (default ~/.agentarium/till.db)
 *
 * The hook always exits 0; a crash never blocks a prompt (errors go to <db>.err).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, fstatSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { defaultDbPath } from '../agentarium/config.ts'
import * as budget from '../agentarium/engine/budget.ts'
import * as currency from '../agentarium/engine/currency.ts'
import * as lessons from '../agentarium/engine/lessons.ts'
import { tokenUsage } from '../agentarium/engine/evidence.ts'
import { usageCostUsd } from '../agentarium/engine/pricing.ts'
import * as store from '../agentarium/engine/store.ts'
import * as trace from '../agentarium/engine/trace.ts'
import { withDb, type Db } from '../agentarium/engine/db.ts'
import * as outcome from '../agentarium/services/outcome.ts'
import * as telemetry from '../agentarium/services/telemetry.ts'
import { argValue, errText, isMain, isObj, logErr, now, readStdin, sha1, type Obj } from '../agentarium/util.ts'

const env = (name: string, fallback = '') => process.env[name] ?? fallback
const mode = () => env('AGENTARIUM_PENNYWISE', 'route').trim().toLowerCase()
const routeUp = () => env('AGENTARIUM_PENNYWISE_UP', 'on').trim().toLowerCase() !== 'off'
const statePath = () => join(dirname(defaultDbPath()), 'pennywise_state.json')
const configPath = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'router.json')
const PRICES_PATH = join(import.meta.dirname, '..', 'data', 'model-prices.json')

export const FAMILY_TIER: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 4 }
const NAMES: Record<number, string> = { 1: 'Haiku', 2: 'Sonnet', 3: 'Opus', 4: 'Fable' }
const ALIASES: Record<number, string> = { 1: 'haiku', 2: 'sonnet', 3: 'opus', 4: 'fable' }   // values the Agent tool's `model` takes
export const TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'] as const
const DEFAULT_TIERS: Record<string, string> = { SIMPLE: 'haiku', MEDIUM: 'sonnet', COMPLEX: 'opus', REASONING: 'opus' }
// score >= threshold puts a prompt in that tier (scores run roughly -1 .. +2)
const DEFAULT_THRESHOLDS: Record<string, number> = { MEDIUM: 0.15, COMPLEX: 0.5, REASONING: 0.95 }

const BYPASS_RE = /^\s*keep-model:\s*/i
// Follow-ups that lean on the conversation: a subagent (hook mode) couldn't see what they refer to.
const FOLLOW_UP_RE = new RegExp(String.raw`^\s*(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks|continue|go( ahead| on)?|do it|try again|` +
  String.raw`same|again|that|this|it|now|also|and|but|then)\b|\b(above|previous|earlier|you just|` +
  String.raw`last (one|step|answer)|that (one|file|error|change))\b`, 'i')
const TASK_SIGNALS = new Set(['simple-task', 'small-words', 'technical', 'complex-work', 'reasoning', 'multi-step', 'code'])
const FORCE_RE = /^\s*(haiku|sonnet|opus|fable):\s*/i

const rx = (...ps: string[]) => ps.map((p) => new RegExp(p, 'i'))
const R = String.raw

// [name, weight, patterns]: each pattern that matches adds its weight once, capped per signal.
const SIGNALS: [string, number, RegExp[]][] = [
  ['simple-task', -0.35, rx(
    R`\bhello[ ,-]*world\b`, R`\bfizz ?buzz\b`, R`\bboilerplate\b|\bskeleton\b|\bstarter\b`,
    R`\b(fix|correct) (a |the )?(typo|spelling|grammar)\b`,
    R`\brename\b.{0,30}\b(variable|function|file|method|class)\b`,
    R`\b(add|write|update) (a |some )?(comments?|docstrings?|jsdoc|readme)\b`,
    R`\bcommit message\b`, R`\bgitignore\b|\beditorconfig\b`,
    R`\b(format|lint|prettify|indent|sort)\b.{0,30}\b(file|code|json|yaml|imports?)\b`,
    R`\bconvert\b.{0,30}\b(json|yaml|csv|xml|toml)\b`, R`\bregex\b.{0,30}\b(for|to match)\b`,
    R`\b(what|which) (does|is)\b.{0,40}\b(this|command|flag|syntax|option)\b`,
    R`\bsummari[sz]e\b|\btl;?dr\b`, R`\blist (the |all )?(files|commands|branches)\b`,
    R`\bgit (status|log|diff)\b`, R`\bbump\b.{0,20}\bversion\b`)],
  ['small-words', -0.2, rx(R`\bone[- ]liner\b`, R`\b(simple|basic|quick(ly)?|tiny|small|trivial)\b`)],
  ['build-verb', 0.2, rx(R`\b(create|write|add|make|build|generate|implement)\b`)],
  ['technical', 0.15, rx(
    R`\b(api|endpoint|schema|database|sql|migration|auth\w*|oauth|jwt|cache|queue|kafka|redis)\b`,
    R`\b(kubernetes|k8s|terraform|docker|ci/cd|pipeline|webhook|grpc|graphql)\b`,
    R`\b(async|thread\w*|mutex|lock|transaction|index(es|ing)?|memory|latency)\b`,
    R`\b(test suite|integration tests?|e2e|benchmark)\b`,
    R`\b(unit )?tests? for\b|\bclass\b.{0,30}\b(with|that)\b`,
    R`\b(dockerfile|github actions|workflow|ci)\b`)],
  ['complex-work', 0.4, rx(
    R`\brefactor\w*\b|\brewrite\b|\bmigrat(e|ing)\b`, R`\bdebug\w*\b|\bfix\b.{0,30}\b(bug|crash|leak|flaky)\b`,
    R`\bflaky\b|\bmemory leak\b|\bwhole (codebase|repo|app)\b|\bwithout changing (the )?behaviou?r\b`,
    R`\b(split|break up)\b.{0,40}\b(module|file|class|service)s?\b`,
    R`\bperformance\b|\boptimi[sz]\w+|\bprofil(e|ing)\b`,
    R`\bacross (the |all )?(repo|codebase|services?|files|modules)\b|\bmulti[- ]?(file|service|module)\b`,
    R`\bfull(y)?\b.{0,20}\b(app|application|platform|system|feature)\b`, R`\bend[- ]to[- ]end\b`,
    R`\bplan\b.{0,20}\b(implementation|rollout|project|migration)\b`)],
  ['reasoning', 0.55, rx(
    R`\barchitect\w*|\bsystem design\b|\bdesign (doc|review)\b`,
    R`\bsecurity\b|\bvulnerab\w+|\bexploit\b`, R`\bthreat model\b|\baudit\b.{0,20}\b(auth|crypto|permissions?)\b`,
    R`\brace condition\b|\bconcurren\w+|\bdeadlock\b|\bdistributed\b|\bconsisten(cy|t hashing)\b`,
    R`\broot cause\b|\bwhy (is|does|did|would)\b.{0,60}\b(fail|crash|hang|leak|slow)\w*`,
    R`\btrade-?offs?\b|\bcompare\b.{0,40}\b(approaches|options|designs)\b`, R`\bpros and cons\b|\brecommend (one|an? \w+)\b`,
    R`\bprove\b|\bproof\b|\balgorithm\w*\b`, R`\b(time|space) complexity\b|\bbig-?o\b|\bterminates\b`,
    R`\bstep[- ]by[- ]step\b|\bthink (it )?through\b|\breason about\b`,
    R`\bresearch\b|\banalys[ei]s\b|\binvestigat\w+`)],
  ['multi-step', 0.3, rx(
    R`\b(first|1\.|step 1)\b[\s\S]{0,300}\b(then|next|2\.|step 2|after that|finally)\b`,
    R`(^|\n)\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S`)],
]
const SIGNAL_CAP: Record<string, number> = { 'simple-task': -0.6, 'small-words': -0.3, 'build-verb': 0.2, technical: 0.45,
  'complex-work': 0.8, reasoning: 1.1, 'multi-step': 0.3 }

const round2 = (v: number) => Math.round(v * 100) / 100

/** How far every tier threshold rises while a budget is under pressure. */
export const BUDGET_SQUEEZE = 0.35
/** AGENTARIUM_PENNYWISE_OVERHEAD=off routes down even when the hand-off would eat the saving. */
const overheadGate = () => env('AGENTARIUM_PENNYWISE_OVERHEAD', 'on').trim().toLowerCase() !== 'off'
const budgetAware = () => env('AGENTARIUM_PENNYWISE_BUDGET', 'on').trim().toLowerCase() !== 'off'

/** The budget pressing on this session (see engine/budget.ts `pressure`), or null. Never throws. */
export function budgetPressure(sid: string): budget.Pressure | null {
  if (!budgetAware()) return null
  const limits = budget.loadLimits()
  if (!budget.active(limits)) return null
  try {
    const db = store.connect(defaultDbPath())
    try {
      return budget.pressure(db, sid, limits)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** `cfg` with every threshold raised by BUDGET_SQUEEZE: more prompts land on a cheaper tier. */
export function squeezed(cfg: RouterConfig): RouterConfig {
  return { tiers: cfg.tiers, thresholds: Object.fromEntries(Object.entries(cfg.thresholds).map(([k, v]) => [k, v + BUDGET_SQUEEZE])) }
}

// ------------------------------------------------------------------ config ------------------

export type RouterConfig = { tiers: Record<string, string>, thresholds: Record<string, number> }

/** What `pennywise learn` wrote: threshold offsets from routes that missed or held, and tier
 *  swaps from outcomes (only after `learn --apply-tiers`). */
export const learnedPath = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'pennywise_learned.json')
const learning = () => env('AGENTARIUM_PENNYWISE_LEARN', 'on').trim().toLowerCase() !== 'off'

/** The router's settings. With `project`, a tier whose threshold that project has learned on its
 *  own routes uses the project's offset; every other tier uses the global one. */
export function loadConfig(project?: string | null): RouterConfig {
  const cfg: RouterConfig = { tiers: { ...DEFAULT_TIERS }, thresholds: { ...DEFAULT_THRESHOLDS } }
  if (learning()) {
    // learned first, so router.json and the env still win
    try {
      const l = JSON.parse(readFileSync(learnedPath(), 'utf8'))
      const own = project && isObj(l.projects) && isObj(l.projects[project]) && isObj(l.projects[project].offsets) ? l.projects[project].offsets : {}
      const offsets = { ...(isObj(l.offsets) ? l.offsets : {}), ...own }
      for (const [k, v] of Object.entries(offsets)) {
        const n = Number(v)
        if (k in cfg.thresholds && Number.isFinite(n)) cfg.thresholds[k] = round2(cfg.thresholds[k] + Math.max(-0.3, Math.min(0.2, n)))
      }
      for (const [k, v] of Object.entries(isObj(l.tiers) ? l.tiers : {})) {
        if ((TIERS as readonly string[]).includes(k) && v) cfg.tiers[k] = String(v)
      }
    } catch {
      // nothing learned yet
    }
  }
  try {
    const f = JSON.parse(readFileSync(configPath(), 'utf8'))
    for (const [k, v] of Object.entries(isObj(f.tiers) ? f.tiers : {})) {
      if ((TIERS as readonly string[]).includes(k.toUpperCase())) cfg.tiers[k.toUpperCase()] = String(v)
    }
    for (const [k, v] of Object.entries(isObj(f.thresholds) ? f.thresholds : {})) {
      if (Number.isFinite(Number(v))) cfg.thresholds[k.toUpperCase()] = Number(v)
    }
  } catch {
    // no router.json: the defaults
  }
  for (const part of env('AGENTARIUM_ROUTER_TIERS').split(',')) {
    const i = part.indexOf('=')
    const k = (i >= 0 ? part.slice(0, i) : part).trim().toUpperCase()
    const v = i >= 0 ? part.slice(i + 1).trim() : ''
    if ((TIERS as readonly string[]).includes(k) && v) cfg.tiers[k] = v
  }
  return cfg
}

/** Model name or alias -> 1 (Haiku) .. 4 (Fable), or null for a model we don't know. */
export function tierOf(model: unknown): number | null {
  const m = String(model ?? '').toLowerCase()
  for (const [name, t] of Object.entries(FAMILY_TIER)) if (m.includes(name)) return t
  return null
}

let prices: Obj | null = null

/** 'haiku' -> the newest listed Haiku model id from data/model-prices.json; full ids pass through. */
export function resolveModel(name: string): string {
  if (!name || !Object.values(ALIASES).includes(name.toLowerCase())) return name
  if (prices === null) {
    try {
      const data = JSON.parse(readFileSync(PRICES_PATH, 'utf8'))
      prices = isObj(data.models) ? data.models : {}
    } catch {
      prices = {}
    }
  }
  const ver = (e: Obj) => String(e.version ?? '0').split('.').map((x) => Number.parseInt(x, 10) || 0)
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1)
    return 0
  }
  const fam = Object.entries(prices!).filter(([, v]) => v.family === name.toLowerCase() && v.listed !== false)
  if (!fam.length) return name
  return fam.reduce((best, x) => (cmp(ver(x[1]), ver(best[1])) > 0 ? x : best))[0]
}

// ------------------------------------------------------------------ scoring ----------------

export type Score = { tier: string, score: number, signals: [string, number][], model: string }

/** -> {tier, score, signals, model}. Pure function of the prompt (and context size). */
export function score(prompt: string, contextTokens = 0, config?: RouterConfig): Score {
  const cfg = config ?? loadConfig()
  const words = prompt.split(/\s+/).filter(Boolean).length
  let total = 0
  const hits: [string, number][] = []
  // length: very short prompts lean simple, long ones lean complex
  if (words <= 12) {
    total -= 0.1
    hits.push(['short', -0.1])
  } else if (words > 250) {
    total += 0.45
    hits.push(['long', 0.45])
  } else if (words > 80) {
    total += 0.25
    hits.push(['longish', 0.25])
  }
  if (prompt.includes('```') || /(^|\n)( {4}|\t)\S.*\n( {4}|\t)\S/.test(prompt)) {
    total += 0.3
    hits.push(['code', 0.3])
  }
  for (const [name, weight, pats] of SIGNALS) {
    const n = pats.filter((p) => p.test(prompt)).length
    if (n) {
      const cap = SIGNAL_CAP[name]
      const w = cap < 0 ? Math.max(weight * n, cap) : Math.min(weight * n, cap)
      total += w
      hits.push([name, round2(w)])
    }
  }
  if ((prompt.match(/\?/g)?.length ?? 0) >= 3) {
    total += 0.2
    hits.push(['many-questions', 0.2])
  }
  let tier = tierFor(total, cfg.thresholds)
  if (contextTokens > 150_000 && tier === 'SIMPLE') {     // big contexts need more than the smallest model
    tier = 'MEDIUM'
    hits.push(['big-context', 0])
  }
  return { tier, score: round2(total), signals: hits, model: cfg.tiers[tier] }
}

/** The tier a score lands in against `th`. */
export function tierFor(score: number, th: Record<string, number>): string {
  let tier = 'SIMPLE'
  for (const t of ['MEDIUM', 'COMPLEX', 'REASONING']) if (score >= th[t]) tier = t
  return tier
}

export function forced(prompt: string): string | null {
  const m = FORCE_RE.exec(prompt)
  return m ? m[1].toLowerCase() : null
}

// ------------------------------------------------------------------ savings -----------------
//
// What a routing decision is worth, net of what routing itself costs. Everything here is an
// estimate from list prices and a typical task's shape (the WORK constants), never a bill.
//
// Hook mode hands the task to a subagent, which is not free: the session's own model still reads
// the conversation to make the Agent call, and again to relay the answer. So a route is only worth
// taking when the work it moves to a cheaper model costs more than that hand-off:
//
//   stay    = the session's model does the task: WORK.steps reads of the context, plus the work
//   handoff = the session's model reads the context twice (call, relay) and writes two short turns
//   sub     = the routed model does the task from a fresh, small context (its own system prompt)
//   saving  = stay - handoff - sub         (negative for a route UP: what quality costs extra)
//
// The proxy switches the model of the request itself (no subagent), so its saving is the price
// difference on that request, minus a cache re-write when the switch leaves a warm cache behind.

/** A typical agentic task: steps, fresh tokens it reads (tool results), tokens it writes. */
export const WORK = { steps: 4, input: 15_000, output: 1_500, secs: 120 }
export type Work = typeof WORK

/** The task shape the estimates use: what `learn` measured from your own routed subagents, when
 *  it has enough of them (and learning is on), else WORK. Bounded, so one odd file can't skew it. */
export function work(): Work {
  if (!learning()) return WORK
  try {
    const w = JSON.parse(readFileSync(learnedPath(), 'utf8')).work
    if (!isObj(w)) return WORK
    const b = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.max(lo, Math.min(hi, Number(v))) : d)
    return { steps: b(w.steps, 1, 30, WORK.steps), input: b(w.input, 1_000, 500_000, WORK.input), output: b(w.output, 100, 50_000, WORK.output),
      secs: b(w.secs, 10, 7_200, WORK.secs) }
  } catch {
    return WORK
  }
}
const SUB_BASE = 12_000          // a subagent's own system prompt and tools, written once then re-read
const HANDOFF_IN = 1_500         // the subagent's answer, read back by the session's model
const HANDOFF_OUT = 400          // each of the two short turns: the Agent call, then the relay
const SESSION_BASE = 20_000      // the least a session's context holds: its system prompt and tools

const usd = (model: string, u: { input?: number, write?: number, read?: number, output?: number }) =>
  usageCostUsd(tokenUsage({ inputTokens: u.input ?? 0, cacheCreationTokens: u.write ?? 0, cacheReadTokens: u.read ?? 0,
    outputTokens: u.output ?? 0 }), model)

export type Saving = { stay: number, handoff: number, routed: number, saving: number }

/** The session's prompt cache: cold (expired, or nothing cached yet) and how long it lasts (s). */
export type Cache = { cold: boolean, ttl: number }

/** The hook-mode estimate (USD) of routing one task from `from` to `to` at context size `ctx`.
 *  With `cache`: a cold cache makes the first pass over the context a write on both sides, and a
 *  routed task expected to outlast the cache (work().secs > ttl) makes the relay a write too. */
export function estimateHandoff(from: string, to: string, ctxTokens: number, cache?: Cache): Saving {
  const ctx = Math.max(ctxTokens, SESSION_BASE)
  const w = work()
  const s = w.steps
  const [firstRead, firstWrite] = cache?.cold ? [0, ctx] : [ctx, 0]
  const relayCold = Boolean(cache) && w.secs > cache!.ttl
  const stay = usd(from, { read: firstRead + ctx * (s - 1) + w.input * s / 2, write: firstWrite + w.input, output: w.output })
  const handoff = usd(from, { read: firstRead + (relayCold ? 0 : ctx), write: firstWrite + (relayCold ? ctx : 0) + HANDOFF_IN,
    output: HANDOFF_OUT * 2 })
  const routed = usd(to, { write: SUB_BASE + w.input, read: SUB_BASE * (s - 1) + w.input * s / 2, output: w.output })
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  return { stay: r6(stay), handoff: r6(handoff), routed: r6(routed), saving: r6(stay - handoff - routed) }
}

/** The proxy's estimate (USD) for one request of `ctx` tokens sent to `chosen` instead of `requested`. */
export function estimateRequest(requested: string, chosen: string, ctx: number, switched: boolean): number {
  if (!requested || tierOf(requested) === null) return 0
  const w = work()
  const out = w.output / w.steps
  const stay = usd(requested, { read: ctx, output: out })
  const routed = usd(chosen, switched ? { write: ctx, output: out } : { read: ctx, output: out })
  return Math.round((stay - routed) * 1e6) / 1e6
}

// ------------------------------------------------------------------ logging -----------------

export type LogExtra = { saved?: number | null, ctx?: number | null, tier?: string | null, score?: number | null, digest?: string | null,
  estRouted?: number | null, cache?: string | null, project?: string | null,
  /** never logged: carried to the evaluation set when AGENTARIUM_PENNYWISE_EVAL=text */
  text?: string | null }

// est_routed_usd: the estimate's "routed" part; measured_*: what the routed subagent really used
const LOG_COLUMNS: [string, string][] = [['saved_usd', 'REAL'], ['ctx', 'INTEGER'], ['tier', 'TEXT'], ['score', 'REAL'], ['prompt_sha', 'TEXT'],
  ['est_routed_usd', 'REAL'], ['measured_usd', 'REAL'], ['measured_saved_usd', 'REAL'], ['m_steps', 'INTEGER'], ['m_input', 'INTEGER'],
  ['m_output', 'INTEGER'], ['m_secs', 'INTEGER'], ['cache', 'TEXT'], ['project', 'TEXT']]

/** The pennywise_events table, with the columns newer versions added. */
export function ensureLog(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pennywise_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
    model TEXT, suggested TEXT, reason TEXT, action TEXT)`)
  const have = new Set(db.all('PRAGMA table_info(pennywise_events)').map((r) => String(r.name)))
  for (const [c, t] of LOG_COLUMNS) if (!have.has(c)) db.exec(`ALTER TABLE pennywise_events ADD COLUMN ${c} ${t}`)
}

/** Log one decision; -> its row id (null when logging failed). */
function log(sid: string, model: string | null, suggested: string, reason: string, action: string, x: LogExtra = {}): number | null {
  try {
    return withDb(defaultDbPath(), (db) => {
      ensureLog(db)
      db.run('INSERT INTO pennywise_events(session_id,ts,model,suggested,reason,action,saved_usd,ctx,tier,score,prompt_sha,est_routed_usd,cache,project) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', sid, now(), model, suggested, reason, action, x.saved ?? null, x.ctx ?? null,
      x.tier ?? null, x.score ?? null, x.digest ?? null, x.estRouted ?? null, x.cache ?? null, x.project ?? null)
      return Number(db.get('SELECT last_insert_rowid() AS id')?.id) || null
    })
  } catch {
    return null      // logging must never break routing
  }
}

/** What pennywise saved (USD, net of hand-offs) and what routing up cost extra, for a session
 *  (or every session since `since`, an ISO date). Read-only; zeros when nothing was logged. */
export function savings(dbPath: string, opts: { session?: string, since?: string } = {}): { saved: number, extra: number, routed: number } {
  const zero = { saved: 0, extra: 0, routed: 0 }
  if (!existsSync(dbPath)) return zero
  try {
    return withDb(dbPath, (db) => {
      const cols = new Set(db.all('PRAGMA table_info(pennywise_events)').map((r) => String(r.name)))
      if (!cols.has('saved_usd')) return zero
      const where = opts.session ? 'session_id=?' : 'ts>=?'
      const r = db.get(`SELECT COALESCE(SUM(CASE WHEN saved_usd>0 THEN saved_usd END),0) AS saved,
        COALESCE(-SUM(CASE WHEN saved_usd<0 THEN saved_usd END),0) AS extra, COUNT(saved_usd) AS routed
        FROM pennywise_events WHERE ${where}`, opts.session ?? opts.since ?? '')
      return { saved: Number(r?.saved) || 0, extra: Number(r?.extra) || 0, routed: Number(r?.routed) || 0 }
    }, { readOnly: true })
  } catch {
    return zero
  }
}

// ------------------------------------------------------------------ hook mode ---------------

/** The session's model, context size (tokens), when it last ran (epoch ms) and how long its cache
 *  lasts (s: 3600 once a turn wrote to the 1-hour cache, else 300), from the newest main-thread turn. */
export function lastTurn(path: string): { model: string | null, ctx: number, ts: number | null, ttl: number } {
  try {
    const fd = openSync(path, 'r')
    let text: string
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 400_000)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const lines = text.split(/\r?\n/).reverse()
    for (const [i, line] of lines.entries()) {
      let ev: Obj
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const m = ev?.message?.model
      if (ev.type === 'assistant' && m && !String(m).startsWith('<') && !ev.isSidechain) {
        const u = isObj(ev.message.usage) ? ev.message.usage : {}
        const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
        const ts = Date.parse(String(ev.timestamp ?? ''))
        // the TTL is whichever cache the newest turn that wrote one used
        let ttl = 300
        for (const l of lines.slice(i)) {
          const cc = /"ephemeral_(1h|5m)_input_tokens":\s*[1-9]/.exec(l)
          if (cc) {
            ttl = cc[1] === '1h' ? 3600 : 300
            break
          }
        }
        return { model: String(m), ctx, ts: Number.isFinite(ts) ? ts : null, ttl }
      }
    }
  } catch {
    // no transcript
  }
  return { model: null, ctx: 0, ts: null, ttl: 300 }
}

/** The session's cache right now, from its newest turn; AGENTARIUM_CACHE_TTL (seconds) overrides
 *  the TTL, as on the status line. A session with no turn yet has nothing cached: cold. */
export function cacheState(t: { ts: number | null, ttl: number }, at = Date.now()): Cache {
  const set = Number.parseInt(env('AGENTARIUM_CACHE_TTL'), 10)
  const ttl = set > 0 ? set : t.ttl
  return { cold: t.ts === null || at - t.ts > ttl * 1000, ttl }
}

export type Measured = { usd: number, steps: number, input: number, output: number, secs: number }

/** What subagents really used between `fromMs` and `toMs` (epoch ms), from the session transcript:
 *  sidechain turns in the transcript itself, and the per-agent files Claude Code keeps beside it
 *  (<session>/subagents/*.jsonl). Each message is priced at its own model and counted once (a
 *  streamed message repeats its usage on every line). Null when no subagent ran. */
export function measureSidechain(transcript: string, fromMs: number, toMs = Date.now()): Measured | null {
  // older Claude Code keeps sidechains in the transcript only; newer ones in per-agent files too
  const files = [transcript, ...subagentFiles(transcript)]
  const seen = new Set<string>()
  const m: Measured = { usd: 0, steps: 0, input: 0, output: 0, secs: 0 }
  let lastTs = fromMs
  for (const [i, f] of files.entries()) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"assistant"')) continue
      let ev: Obj
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type !== 'assistant' || (i === 0 && !ev.isSidechain) || !isObj(ev.message?.usage)) continue
      const ts = Date.parse(String(ev.timestamp ?? ''))
      if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue
      const id = String(ev.message.id ?? ev.uuid ?? line.length + ':' + ts)
      if (seen.has(id)) continue
      seen.add(id)
      const u = ev.message.usage
      const n = (k: string) => Number(u[k]) || 0
      m.usd += usd(String(ev.message.model ?? ''), { input: n('input_tokens'), write: n('cache_creation_input_tokens'),
        read: n('cache_read_input_tokens'), output: n('output_tokens') })
      m.steps++
      lastTs = Math.max(lastTs, ts)
      m.input += n('input_tokens') + n('cache_creation_input_tokens')
      m.output += n('output_tokens')
    }
  }
  if (!m.steps) return null
  // the WORK shape counts the task's own fresh reads, not the subagent's system prompt and tools
  m.input = Math.max(0, m.input - SUB_BASE)
  m.usd = Math.round(m.usd * 1e6) / 1e6
  m.secs = Math.round((lastTs - fromMs) / 1000)
  return m
}

/** The last route of a session, measured once its answer is in (the next prompt). Never throws. */
function measureLast(sid: string, transcript: string | null, last: LastRoute | undefined): void {
  if (!transcript || !last?.id || last.measured || last.estRouted == null) return
  try {
    const m = measureSidechain(transcript, last.ts * 1000)
    last.measured = true
    const all = readJson(routesPath())
    if (all[sid]) {
      all[sid].measured = true
      writeJson(routesPath(), all)
    }
    if (!m) return              // the session did it itself: nothing to compare
    withDb(defaultDbPath(), (db) => {
      ensureLog(db)
      db.run('UPDATE pennywise_events SET measured_usd=?, measured_saved_usd=ROUND(saved_usd + est_routed_usd - ?, 6), m_steps=?, ' +
        'm_input=?, m_output=?, m_secs=? WHERE id=?', m.usd, m.usd, m.steps, m.input, m.output, m.secs, last.id!)
    })
  } catch {
    // measuring is a bonus
  }
}

/** Estimated vs measured for the routes whose subagent was measured (USD; since an ISO date). */
export function measuredSummary(dbPath: string, since: string): { n: number, estimated: number, measured: number, estSaved: number, saved: number } {
  const zero = { n: 0, estimated: 0, measured: 0, estSaved: 0, saved: 0 }
  if (!existsSync(dbPath)) return zero
  try {
    return withDb(dbPath, (db) => {
      if (!db.columns('pennywise_events').has('measured_usd')) return zero
      const r = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(est_routed_usd),0) AS e, COALESCE(SUM(measured_usd),0) AS m,
        COALESCE(SUM(saved_usd),0) AS es, COALESCE(SUM(measured_saved_usd),0) AS s
        FROM pennywise_events WHERE ts>=? AND measured_usd IS NOT NULL`, since)
      return { n: Number(r?.n) || 0, estimated: Number(r?.e) || 0, measured: Number(r?.m) || 0, estSaved: Number(r?.es) || 0, saved: Number(r?.s) || 0 }
    }, { readOnly: true })
  } catch {
    return zero
  }
}

/** The subagent files Claude Code keeps beside a transcript (<session>/subagents/*.jsonl). */
function subagentFiles(transcript: string): string[] {
  const dir = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents')
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Evidence that a route taken at `sinceS` (epoch s) didn't land, or null: groundhog caught a loop
 *  in the session since, or the work since (the subagent's and the session's) ended on a failing
 *  check, was reverted, or had a change refused. The same rules as bang-for-buck's outcomes. */
export function missEvidence(transcript: string | null, sid: string, sinceS: number, dbPath = defaultDbPath()): string | null {
  try {
    const g = existsSync(dbPath) ? withDb(dbPath, (db) => (db.tables().has('groundhog_events')
      ? db.get('SELECT rule FROM groundhog_events WHERE session_id=? AND ts>=? ORDER BY id LIMIT 1', sid, now(new Date(sinceS * 1000)))
      : undefined), { readOnly: true }) : undefined
    if (g) return `groundhog caught it going round in circles (${String(g.rule).replace(/_/g, ' ')})`
  } catch {
    // no groundhog log
  }
  if (!transcript) return null
  const steps: trace.Step[] = []
  for (const f of [transcript, ...subagentFiles(transcript)]) {
    try {
      steps.push(...trace.parse(f, { tail: 3 * 1024 * 1024 }).steps.filter((s) => s.ts !== null && s.ts >= sinceS))
    } catch {
      continue
    }
  }
  steps.sort((a, b) => a.ts! - b.ts!).forEach((s, i) => { s.turn = i })
  const s = outcome.signals(outcome.activityFromTrace({ steps, interrupts: [] } as unknown as trace.Trace))
  if (s.reverted) return 'its change was reverted'
  if (s.checks.last === 'fail') return 'the last check it ran failed'
  if (s.rejected) return 'you refused its change'
  return null
}

/** Evidence, in a proxy request's tool loop, that the model it's on is stuck, from messages[from..]:
 *  a groundhog refusal, a revert of its own change, or the last two checks (test, lint, build) failed. */
export function loopEvidence(body: Obj, from = 0): string | null {
  const msgs = Array.isArray(body.messages) ? body.messages.slice(from) : []
  const cmds = new Map<string, string>()
  const results: { cmd: string, text: string, error: boolean }[] = []
  let reverted = false
  for (const m of msgs) {
    if (!isObj(m) || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (!isObj(p)) continue
      if (p.type === 'tool_use' && isObj(p.input)) {
        const cmd = String(p.input.command ?? '')
        cmds.set(String(p.id), cmd)
        if (cmd && outcome.commandKind(cmd) === 'revert') reverted = true
      } else if (p.type === 'tool_result') {
        results.push({ cmd: cmds.get(String(p.tool_use_id)) ?? '', text: trace.resultText(p.content), error: Boolean(p.is_error) })
      }
    }
  }
  if (results.some((r) => r.error && r.text.includes('groundhog:'))) return 'groundhog caught it going round in circles'
  if (reverted) return 'it reverted its own change'
  const checks = results.filter((r) => r.cmd && ['test', 'lint', 'build'].includes(outcome.commandKind(r.cmd)))
    .map((r) => outcome.passed({ isError: r.error, resultText: r.text } as trace.Step))
  if (checks.length >= 2 && !checks.at(-1) && !checks.at(-2)) return 'its checks failed twice in a row'
  return null
}

function currentModel(d: Obj): string | null {
  let m = d.model
  if (isObj(m)) m = m.id || m.display_name
  if (tierOf(m)) return String(m)
  if (d.transcript_path) {
    m = lastTurn(String(d.transcript_path)).model
    if (tierOf(m)) return m
  }
  if (tierOf(process.env.ANTHROPIC_MODEL)) return process.env.ANTHROPIC_MODEL!
  const cwd = d.cwd || '.'
  for (const p of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json')]) {
    try {
      m = JSON.parse(readFileSync(p, 'utf8')).model
      if (tierOf(m)) return String(m)
    } catch {
      continue
    }
  }
  return null
}

function proxyActive(): boolean {
  const port = env('AGENTARIUM_ROUTER_PORT', '8787')
  return mode() === 'proxy' || new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}\\b`).test(env('ANTHROPIC_BASE_URL'))
}

function routeInstruction(tier: number, why: string, up: boolean): string {
  const reason = up ? "it needs more than this session's model" : 'a cheaper model can do it'
  return `[agentarium pennywise model router] This prompt was scored ${why}, so it is routed to ` +
    `${NAMES[tier]} (${reason}). Do not do the task yourself. Make one call to the Agent tool ` +
    `(the subagent tool) with model: "${ALIASES[tier]}", passing the user's request word for word as its ` +
    'prompt, plus only the facts from this conversation it needs (file paths, names, earlier ' +
    'decisions), since the subagent cannot see this conversation. Then give the user its result ' +
    'briefly, without redoing or re-checking its work. If you have no Agent tool, or the request ' +
    'clearly depends on this conversation in a way you cannot hand over in a few lines, do it ' +
    'yourself as usual.'
}

/** Money for a message, in the display currency: '£0.04', or '<£0.01' for crumbs. */
function priced(usdAmount: number): string {
  try {
    const [, symbol, rate] = currency.current()
    const v = Math.abs(usdAmount) * rate
    return v < 0.01 ? `<${symbol}0.01` : currency.formatMoney(v, symbol)
  } catch {
    return `$${Math.abs(usdAmount).toFixed(2)}`
  }
}

/** The lesson for a model choice; none for a model the user picked with 'haiku:' and the like. */
function lesson(sid: string, model: string, cur: number, tier: number): string {
  return lessons.teach(defaultDbPath(), tier > cur ? 'model-up' : 'model-down', { sessionId: sid, source: 'claude-code' },
    { from: model, to: resolveModel(ALIASES[tier]), fromName: NAMES[cur], toName: NAMES[tier] })
}

function route(sid: string, model: string, cur: number, tier: number, why: string, x: LogExtra, forced = false): Obj {
  const up = tier > cur
  const id = log(sid, model, NAMES[tier], why, up ? 'routed-up' : 'routed', x)
  rememberRoute(sid, { tier, cur, ts: Date.now() / 1000, label: x.tier ?? null, score: x.score ?? null, id, estRouted: x.estRouted ?? null,
    sha: x.digest ?? null, text: evalMode() === 'text' ? x.text ?? null : null })
  const est = typeof x.saved === 'number'
    ? (x.saved >= 0 ? `, saves ~${priced(x.saved)} after the hand-off` : `, ~${priced(x.saved)} more for a stronger model`) : ''
  return {
    systemMessage: `pennywise: routing ${up ? 'up' : 'down'} to ${NAMES[tier]} (${why}${est}) instead of ${NAMES[cur]}. ` +
      `Start a prompt with 'keep-model:' to keep it on ${NAMES[cur]}.` + (forced ? '' : lesson(sid, model, cur, tier)),
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: routeInstruction(tier, why, up) },
  }
}

function readJson(path: string): Record<string, any> {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(s) ? s : {}
  } catch {
    return {}
  }
}

function writeJson(path: string, v: Record<string, unknown>, keep = 200): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(v).slice(-keep))))
  } catch {
    // state is a convenience
  }
}

const readState = (): Record<string, string> => readJson(statePath())

// ---- the last route per session: what a "that didn't work" is about -----------------------

type LastRoute = { tier: number, cur: number, ts: number, label: string | null, score: number | null,
  id?: number | null, estRouted?: number | null, measured?: boolean,
  /** the routed prompt, for the evaluation set: its hash, and its text only with AGENTARIUM_PENNYWISE_EVAL=text */
  sha?: string | null, text?: string | null }
const routesPath = () => join(dirname(defaultDbPath()), 'pennywise_routes.json')

function rememberRoute(sid: string, r: LastRoute | null): void {
  const all = readJson(routesPath())
  delete all[sid]
  if (r) all[sid] = r
  writeJson(routesPath(), all)
}

/** A prompt saying the last answer didn't land: the cue to move back up a tier. */
export const FAILED_RE = new RegExp(
  String.raw`\b(did ?n[o']?t|does ?n[o']?t|is ?n[o']?t|wo ?n[o']?t) (work|compile|build|pass|run|help|fix)|` +
  String.raw`\bnot (working|right|what i (asked|wanted|meant))\b|\bstill (fail\w*|broken|wrong|erroring|crashing|the same)\b|` +
  String.raw`\b(that|this|it)('s| is| was) (wrong|incorrect|broken)\b|\b(wrong|bad) (answer|fix|result|output)\b|` +
  String.raw`\btry (again|harder)\b|\bthat broke\b|\btests? (still )?fail`, 'i')

/** How long after a route a "that didn't work" still counts against it (seconds). */
export const ESCALATE_WINDOW = 1800

export function handle(d: Obj): Obj | null {
  const m0 = mode()
  if (m0 === 'off' || m0 === 'proxy' || proxyActive()) return null
  const prompt = String(d.prompt || d.userPrompt || '').trim()
  if (!prompt || prompt.startsWith('/')) return null
  const model = currentModel(d)
  const cur = tierOf(model)
  if (cur === null) return null
  const sid = String(d.session_id || d.sessionId || 'unknown')
  // the repository's name (never its path): learning keys on it
  const project = telemetry.project(d.cwd ? String(d.cwd) : null)
  const cfg = loadConfig(project)
  const turn = d.transcript_path ? lastTurn(String(d.transcript_path)) : null
  const ctx = turn?.ctx ?? 0
  const cache = turn ? cacheState(turn) : undefined

  // the last routed-down answer didn't land: the session's own (stronger) model takes this one
  const last = readJson(routesPath())[sid] as LastRoute | undefined
  measureLast(sid, d.transcript_path ? String(d.transcript_path) : null, last)
  if (last && last.tier < last.cur && Date.now() / 1000 - last.ts < ESCALATE_WINDOW && !prompt.startsWith('/')) {
    // the user's words, or what happened: a failed check, a revert, a refused change, a loop
    const said = FAILED_RE.test(prompt)
    const ev = said ? null : missEvidence(d.transcript_path ? String(d.transcript_path) : null, sid, last.ts)
    if (said || ev) {
      rememberRoute(sid, null)
      const kept = last.label && last.score !== null && last.sha
        ? addCase({ tier: up1(last.label), sha: last.sha, score: last.score, prompt: last.text ?? null, from: 'escalated' }) : false
      log(sid, model, NAMES[cur], said ? `the ${NAMES[last.tier]} answer didn't land` : `the ${NAMES[last.tier]} answer: ${ev}`, 'escalated',
        { tier: last.label, score: last.score, project })
      return { systemMessage: `pennywise: the last answer came from ${NAMES[last.tier]} and ${said ? "it didn't land" : ev}, so ` +
        `${NAMES[cur]} takes this one itself. pennywise learns from this: similar prompts will route higher.` +
        (kept ? ' It is kept as a labelled case for `agentarium router eval --mine`.' : '') }
    }
  }
  if (BYPASS_RE.test(prompt)) {
    // a label for learning: the user kept the model on a prompt pennywise would have routed down
    const r = score(prompt.replace(BYPASS_RE, ''), ctx, cfg)
    const t = tierOf(r.model)
    if (t !== null && t < cur && r.signals.some(([n]) => TASK_SIGNALS.has(n))) {
      log(sid, model, NAMES[t], `${r.tier}, score ${r.score}`, 'kept', { tier: r.tier, score: r.score, ctx, project })
      const p = prompt.replace(BYPASS_RE, '')
      addCase({ tier: up1(r.tier), sha: sha1(p).slice(0, 12), score: r.score, prompt: evalMode() === 'text' ? p : null, from: 'kept' })
    }
    return null
  }
  const f = forced(prompt)
  let tier: number | null
  let why: string
  let r: Score | null = null
  if (f) {
    [tier, why] = [FAMILY_TIER[f], `forced with '${f}:'`]
  } else {
    const p = budgetPressure(sid)
    r = score(prompt, ctx, p ? squeezed(cfg) : cfg)
    tier = tierOf(r.model)
    why = `${r.tier}, score ${r.score}` + (p ? `, ${p.kind === 'daily' ? "today's" : "this session's"} budget ${p.pct}% spent` : '')
    // a subagent starts blank: only hand over prompts that stand on their own and clearly read as a task
    if (FOLLOW_UP_RE.test(prompt) || !r.signals.some(([n]) => TASK_SIGNALS.has(n))) return null
    if (p && tier !== null && tier > cur) return null     // a budget running out: never route up
  }
  if (tier === null || tier === cur || (tier > cur && !routeUp() && !f)) return null
  const extra: LogExtra = { ctx, tier: r?.tier ?? null, score: r?.score ?? null, digest: sha1(prompt).slice(0, 12),
    cache: cache ? (cache.cold ? 'cold' : 'warm') : null, project }
  if (!(m0 === 'block' || m0 === 'warn') || f || tier > cur) {    // "route", forced, and upgrades always route
    const est = estimateHandoff(model!, resolveModel(ALIASES[tier]), ctx, cache)
    // a route down that the hand-off would eat: the session's model does it (cheaper, all in)
    if (tier < cur && !f && est.saving <= 0 && overheadGate()) {
      const long = cache && work().secs > cache.ttl ? `, and the task outlasts the ${Math.round(cache.ttl / 60)}-minute cache` : ''
      log(sid, model, NAMES[tier], `${why}; the hand-off (~${priced(est.handoff)}${long}) outweighs the saving`, 'skipped-overhead',
        { ...extra, saved: 0 })
      return null
    }
    return route(sid, model!, cur, tier, why, { ...extra, saved: est.saving, estRouted: est.routed, text: prompt }, Boolean(f))
  }

  const digest = sha1(prompt)
  const state = readState()
  if (state[sid] === digest) {                             // same prompt sent again = "I meant it"
    log(sid, model, NAMES[tier], why, 'overridden', extra)
    return null
  }
  const cheaper = NAMES[tier]
  const msg = `pennywise: this prompt scored ${why}, which ${cheaper} can handle, but this session is on ` +
    `${model} (${NAMES[cur]}), a pricier tier. Switch with /model ${cheaper.toLowerCase()} and resend, ` +
    `or send the same prompt again (or start it with 'keep-model:') to run it on ${NAMES[cur]} anyway.` +
    lesson(sid, model!, cur, tier)
  if (m0 === 'warn') {
    log(sid, model, cheaper, why, 'warned', extra)
    return { systemMessage: msg }
  }
  delete state[sid]
  state[sid] = digest
  writeJson(statePath(), state)
  log(sid, model, cheaper, why, 'blocked', extra)
  return { decision: 'block', reason: msg }
}

// ------------------------------------------------------------------ proxy mode --------------

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => isObj(p) && p.type === 'text').map((p) => p.text ?? '').join(' ')
  return ''
}

function clean(t: string): string {
  return t.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** Stable id for a conversation: system prompt head + first user message. */
export function conversationKey(body: Obj): string {
  const sysp = typeof body.system === 'string' ? body.system : text(body.system)
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const firstMsg = msgs.length && isObj(msgs[0]) ? text(msgs[0].content) : ''
  return sha1(sysp.slice(0, 2000) + '\x00' + firstMsg.slice(0, 2000)).slice(0, 16)
}

/** The last message is the user typing (not a tool result coming back mid-loop). */
function newUserTurn(body: Obj): string | null {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = msgs.at(-1)
  if (!isObj(last) || last.role !== 'user') return null
  const c = last.content
  if (Array.isArray(c) && c.some((p) => isObj(p) && p.type === 'tool_result')) return null
  return clean(text(c)) || null
}

function uses1hCache(body: Obj): boolean {
  return JSON.stringify(body).slice(0, 200_000).includes('"ttl":"1h"')
}

/** A conversation the proxy routed: its model, when, its cache TTL, and where in the messages the
 *  current stretch started (the evidence for a mid-loop escalation is read from there on). */
type Conv = { model: string, ts: number, ttl: number, from: number }

/** Per-conversation, cache-aware routing decisions for the proxy. */
export class Router {
  cfg: RouterConfig
  convs = new Map<string, Conv>()
  match: Set<string>
  stickyTokens: number
  fallback: string
  /** The estimated saving (USD) of the last decide(): requested model vs the one chosen. */
  lastSaving = 0

  /** The budget pressing on a conversation (`budgetPressure` unless a test swaps it). */
  pressure: (sid: string) => budget.Pressure | null

  constructor(cfg?: RouterConfig, opts: { pressure?: (sid: string) => budget.Pressure | null } = {}) {
    this.cfg = cfg ?? loadConfig()
    this.pressure = opts.pressure ?? budgetPressure
    this.match = new Set(env('AGENTARIUM_ROUTER_MODELS', 'pennywise,auto').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
    this.stickyTokens = Number.parseInt(env('AGENTARIUM_ROUTER_STICKY_TOKENS'), 10) || 20000
    this.fallback = resolveModel(env('AGENTARIUM_ROUTER_FALLBACK') || this.cfg.tiers.COMPLEX)
  }

  routes(model: unknown): boolean {
    const m = String(model ?? '').toLowerCase()
    if (this.match.has(m)) return true
    // "*" routes every request on a main model; Claude Code's small background calls stay put
    const t = tierOf(m)
    return this.match.has('*') && t !== null && t > 1
  }

  /** -> [modelToUse, reason, key, requested] for a /v1/messages body whose model we route.
   *  `sid` is Claude Code's session id when the request carries one (the session budget needs it;
   *  the daily budget doesn't). */
  decide(body: Obj, rawLen: number, at?: number, sid?: string | null): [string, string, string, string] {
    const ts = at ?? Date.now() / 1000
    const requested = String(body.model || '')
    const key = conversationKey(body)
    const ctx = Math.floor(rawLen / 4)
    const ttl = uses1hCache(body) ? 3600 : 300
    const prev = this.convs.get(key)
    const warm = Boolean(prev) && ts - prev!.ts < prev!.ttl
    const turn = newUserTurn(body)
    const nMsgs = Array.isArray(body.messages) ? body.messages.length : 0
    let from = prev?.from ?? 0
    let choice: string
    let reason: string
    // escalation only undoes a route down: never above the model asked for (or, for "pennywise", the fallback)
    const ceilingTier = tierOf(requested) ?? tierOf(this.fallback) ?? 3
    const ev = prev && !turn && (tierOf(prev.model) ?? 3) < ceilingTier ? loopEvidence(body, from) : null
    if (prev && !turn && ev) {
      // stuck mid-loop on a routed-down model: one tier up now, and only fresh evidence moves it again
      const tp = tierOf(prev.model) ?? 3
      choice = resolveModel(ALIASES[tp + 1])
      reason = `escalated: the ${NAMES[tp]} work: ${ev}`
      from = nMsgs
    } else if (prev && !turn) {
      [choice, reason] = [prev.model, 'same turn (tool loop)']
    } else if (prev && turn && FAILED_RE.test(turn)) {
      // the last answer didn't land: never lower than the model that gave it; if that was a routed-down
      // model, one tier up (at most what was asked for)
      const tp = tierOf(prev.model) ?? 3
      if (tp < ceilingTier) [choice, reason] = [resolveModel(ALIASES[tp + 1]), `escalated: the ${NAMES[tp]} answer didn't land`]
      else [choice, reason] = [prev.model, "kept: the last answer didn't land"]
    } else {
      const t = turn || ''
      const f = forced(t)
      if (f) {
        [choice, reason] = [resolveModel(f), `forced ${f}:`]
      } else if (BYPASS_RE.test(t) && prev) {
        [choice, reason] = [prev.model, 'keep-model:']
      } else {
        // a budget past its warning share: score against raised thresholds, as the hook does
        let p: budget.Pressure | null = null
        try {
          p = this.pressure(sid || key)
        } catch {
          p = null
        }
        const r = score(t, ctx, p ? squeezed(this.cfg) : this.cfg)
        choice = resolveModel(r.model)
        reason = `${r.tier} score ${r.score}` + (p ? `, ${p.kind === 'daily' ? "today's" : "this session's"} budget ${p.pct}% spent` : '')
        let tc = tierOf(choice)
        const tp = prev ? tierOf(prev.model) : null
        if (p && tc !== null) {
          // ...and never route up: no higher than the conversation's model so far, or the one asked for
          const ceiling = [prev?.model, requested].filter((m): m is string => Boolean(m) && tierOf(m!) !== null)
            .reduce<string | null>((a, m) => (!a || tierOf(m)! < tierOf(a)! ? m : a), null)
          if (ceiling && tierOf(ceiling)! < tc) {
            [choice, reason] = [resolveModel(ceiling), `${reason}; not routing up on a tight budget`]
            tc = tierOf(choice)
          }
        }
        if (prev && warm && tc && tp && tc < tp && ctx >= this.stickyTokens) {
          [choice, reason] = [prev.model, `${reason}; kept ${prev.model} while its cache is warm`]
        }
      }
      if (this.match.has(choice.toLowerCase()) || (tierOf(choice) === null && !choice.startsWith('claude'))) choice = this.fallback
    }
    const switched = Boolean(prev) && prev!.model !== choice && warm
    // the baseline: the model asked for, or (for "pennywise"/"auto") the fallback, what you'd run without routing
    this.lastSaving = turn !== null || !prev ? estimateRequest(tierOf(requested) !== null ? requested : this.fallback, choice, ctx, switched) : 0
    if (turn !== null) from = nMsgs
    this.convs.set(key, { model: choice, ts, ttl, from })
    if (this.convs.size > 500) {
      for (const [k] of [...this.convs].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100)) this.convs.delete(k)
    }
    return [choice, reason, key, requested]
  }
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'])
const RETRY = new Set([400, 404, 429, 500, 502, 503, 529])

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function forward(upstream: string, method: string, path: string, headers: IncomingMessage['headers'], body: Buffer | null): Promise<IncomingMessage> {
  const url = new URL(upstream + path)
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) out[k] = v
  out['accept-encoding'] = 'identity'
  if (body) out['content-length'] = String(body.length)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const r = send(url, { method, headers: out, timeout: 600_000 }, resolve)
    r.on('error', reject)
    r.on('timeout', () => r.destroy(new Error('upstream timed out')))
    r.end(body ?? undefined)
  })
}

function relay(resp: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(resp.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v
  headers.connection = 'close'
  res.writeHead(resp.statusCode ?? 502, headers)
  res.flushHeaders()
  return new Promise((resolve) => {
    resp.on('data', (chunk: Buffer) => res.write(chunk))         // streams pass straight through
    resp.on('end', () => res.end(resolve))
    resp.on('error', () => res.end(resolve))
  })
}

/** Claude Code's session id for a request: its X-Claude-Code-Session-Id header, or the
 *  `session_<uuid>` in metadata.user_id; null when neither is there. */
export function sessionId(headers: IncomingMessage['headers'], body: Obj): string | null {
  const h = headers['x-claude-code-session-id']
  const v = Array.isArray(h) ? h[0] : h
  if (v && v.trim()) return v.trim()
  const uid = isObj(body.metadata) ? String(body.metadata.user_id ?? '') : ''
  return /session_([0-9a-f-]{8,})/i.exec(uid)?.[1] ?? null
}

/** Start the routing proxy on 127.0.0.1:port (0 = any free port); resolves once it listens. */
export function serve(port: number, opts: { upstream?: string, router?: Router } = {}): Promise<Server> {
  const upstream = (opts.upstream || env('AGENTARIUM_ROUTER_UPSTREAM') || 'https://api.anthropic.com').replace(/\/+$/, '')
  const router = opts.router ?? new Router()
  const srv = createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]
    if (method === 'GET' && req.url === '/pennywise/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, upstream, tiers: router.cfg.tiers }))
      return
    }
    try {
      let raw: Buffer | null = await readBody(req)
      if (!raw.length) raw = null
      let routed: [string, string, string, string] | null = null      // requested, model, reason, key
      const countTokens = path.endsWith('count_tokens')
      if (raw && method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/count_tokens')) {
        try {
          const body = JSON.parse(raw.toString('utf8'))
          if (isObj(body) && router.routes(body.model)) {
            let model: string
            let reason: string
            let key: string
            let requested: string
            if (countTokens) [model, reason, key, requested] = [router.fallback, 'count_tokens', conversationKey(body), String(body.model)]
            else [model, reason, key, requested] = router.decide(body, raw.length, undefined, sessionId(req.headers, body))
            body.model = model
            raw = Buffer.from(JSON.stringify(body), 'utf8')
            routed = [requested, model, reason, key]
          }
        } catch {
          // not JSON: pass it through untouched
        }
      }
      let resp = await forward(upstream, method, req.url ?? '/', req.headers, raw)
      const code = resp.statusCode ?? 0
      if (routed && RETRY.has(code) && routed[1] !== router.fallback && !countTokens) {
        resp.resume()                                          // drop the failed answer
        const body = JSON.parse(raw!.toString('utf8'))
        body.model = router.fallback
        raw = Buffer.from(JSON.stringify(body), 'utf8')
        log(routed[3], routed[0], router.fallback, `${routed[1]} failed (${code})`, 'proxy-fallback')
        resp = await forward(upstream, method, req.url ?? '/', req.headers, raw)
      } else if (routed && !countTokens && routed[2] !== 'same turn (tool loop)') {
        const esc = routed[2].startsWith('escalated')
        log(routed[3], routed[0], routed[1], routed[2], esc ? 'escalated' : 'proxy-routed',
          { saved: router.lastSaving, ctx: Math.floor(raw!.length / 4), tier: /^(SIMPLE|MEDIUM|COMPLEX|REASONING)/.exec(routed[2])?.[1] ?? null })
      }
      await relay(resp, res)
    } catch (e) {
      logErr(defaultDbPath(), `pennywise proxy\n${errText(e)}`)
      try {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `pennywise proxy: ${e instanceof Error ? e.message : e}` } }))
      } catch {
        // the client went away
      }
    }
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

// ------------------------------------------------------------------ learning ----------------
//
// pennywise learns from what happened to its routes, never from token counts:
//   a miss  = a routed-down prompt followed by "that didn't work" (escalated), or a prompt the user
//             kept on the session's model with 'keep-model:' when pennywise would have routed it down
//   a hold  = a routed-down prompt that wasn't escalated
// For each tier, a miss rate above MISS_HIGH lowers the threshold above it (similar prompts route
// higher); a rate below MISS_LOW over enough routes raises it (route down more). Offsets are
// bounded to [-0.3, +0.2]. Outcomes (bang-for-buck's cost per *successful* result per model) suggest
// tier swaps, e.g. COMPLEX=sonnet when Sonnet lands complex work as often for less; those are only
// applied with --apply-tiers.

export const LEARN_MIN = 8               // routes a tier needs before its threshold moves
const MISS_HIGH = 0.2
const MISS_LOW = 0.05
const NEXT: Record<string, string> = { SIMPLE: 'MEDIUM', MEDIUM: 'COMPLEX', COMPLEX: 'REASONING' }

type Stats = Record<string, { holds: number, misses: number }>

export type Learned = { offsets: Record<string, number>, tiers: Record<string, string>, stats: Stats,
  suggestions: string[], updated: string, work?: Work & { n: number },
  /** Per project: the tiers with LEARN_MIN routes of their own, and the offsets they earned (0 = holding). */
  projects?: Record<string, { offsets: Record<string, number>, stats: Stats }> }

/** Holds and misses per tier, from routed / escalated / kept rows in order. */
function tally(rows: Obj[]): Stats {
  const stats: Stats = {}
  for (const r of rows) {
    const t = String(r.tier)
    if (!NEXT[t]) continue
    const s = (stats[t] ??= { holds: 0, misses: 0 })
    if (r.action === 'routed') s.holds++
    else {
      s.misses++
      if (r.action === 'escalated' && s.holds > 0) s.holds--        // that route didn't hold after all
    }
  }
  return stats
}

/** The threshold offsets a tally earns. `holding` also records 0 for a tier with enough routes
 *  and nothing to change, so a project's "this is fine" beats the global offset. */
function offsetsFrom(stats: Stats, holding = false): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [t, s] of Object.entries(stats)) {
    const n = s.holds + s.misses
    if (n < LEARN_MIN) continue
    const rate = s.misses / n
    let off = 0
    if (rate > MISS_HIGH) off = -Math.min(0.3, round2((rate - MISS_HIGH) * 0.75 + 0.05))
    else if (rate < MISS_LOW && n >= LEARN_MIN * 2.5) off = 0.05
    if (off || holding) out[NEXT[t]] = Math.max(-0.3, Math.min(0.2, off))
  }
  return out
}

/** Measured routes `learn` needs before it replaces the typical task shape with yours. */
export const CALIBRATE_MIN = 5
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b)
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}

/** Read the routes since `days` ago and work out the threshold offsets. Writes learnedPath()
 *  unless `dryRun`. Tier swaps from outcomes are suggested, and applied only with `applyTiers`. */
export async function learn(dbPath = defaultDbPath(), opts: { days?: number, dryRun?: boolean, applyTiers?: boolean } = {}): Promise<Learned> {
  const prev = (() => {
    try {
      return JSON.parse(readFileSync(learnedPath(), 'utf8'))
    } catch {
      return {}
    }
  })()
  const out: Learned = { offsets: {}, tiers: isObj(prev.tiers) ? { ...prev.tiers } : {}, stats: {}, suggestions: [], updated: now() }
  const since = new Date(Date.now() - (opts.days ?? 60) * 86400_000).toISOString().slice(0, 10)
  let rows: Obj[] = []
  if (existsSync(dbPath)) {
    try {
      rows = withDb(dbPath, (db) => {
        ensureLog(db)
        return db.all("SELECT session_id, action, tier, project FROM pennywise_events WHERE ts>=? AND tier IS NOT NULL AND " +
          "action IN ('routed','escalated','kept') ORDER BY id", since)
      })
    } catch {
      rows = []
    }
  }
  // the task shape, from what routed subagents really did (medians: one runaway task can't skew it)
  let shapes: Obj[] = []
  if (existsSync(dbPath)) {
    try {
      shapes = withDb(dbPath, (db) => {
        ensureLog(db)
        return db.all('SELECT m_steps, m_input, m_output, m_secs FROM pennywise_events WHERE ts>=? AND m_steps>0 ORDER BY id DESC LIMIT 200', since)
      })
    } catch {
      shapes = []
    }
  }
  if (shapes.length >= CALIBRATE_MIN) {
    out.work = { steps: Math.round(median(shapes.map((r) => Number(r.m_steps)))), input: Math.round(median(shapes.map((r) => Number(r.m_input)))),
      output: Math.round(median(shapes.map((r) => Number(r.m_output)))),
      secs: Math.round(median(shapes.map((r) => Number(r.m_secs) || WORK.secs))), n: shapes.length }
  } else if (isObj(prev.work)) {
    out.work = prev.work
  }
  out.stats = tally(rows)
  out.offsets = offsetsFrom(out.stats)
  // per project: only the tiers it has enough routes for; the rest fall back to the global offsets
  const byProject = new Map<string, Obj[]>()
  for (const r of rows) if (r.project) byProject.set(String(r.project), [...(byProject.get(String(r.project)) ?? []), r])
  for (const [p, rs] of byProject) {
    const stats = tally(rs)
    const offsets = offsetsFrom(stats, true)
    if (Object.keys(offsets).length) (out.projects ??= {})[p] = { offsets, stats }
  }
  // outcomes: a cheaper family that lands work as often, for less per success
  try {
    const bfb = await import('./bangforbuck.ts')
    const r = bfb.build(dbPath, opts.days ?? 60)
    const byFamily = new Map<number, Obj>()
    for (const m of (r.by_model ?? []) as Obj[]) {
      const t = tierOf(m.model)
      if (t !== null && m.productive >= 5 && m.cost_per_success !== null && (!byFamily.has(t) || m.sessions > byFamily.get(t)!.sessions)) byFamily.set(t, m)
    }
    const cfg = loadConfig()
    for (const tierName of ['MEDIUM', 'COMPLEX', 'REASONING']) {
      const t = tierOf(cfg.tiers[tierName])
      const curM = t !== null ? byFamily.get(t) : undefined
      const lower = t !== null ? byFamily.get(t - 1) : undefined
      if (curM && lower && lower.success_rate >= curM.success_rate - 0.05 && lower.cost_per_success < curM.cost_per_success) {
        const alias = ALIASES[t! - 1]
        out.suggestions.push(`${tierName}=${alias}: ${lower.model} landed ${Math.round(lower.success_rate * 100)}% of its work ` +
          `(vs ${Math.round(curM.success_rate * 100)}%) for less per success`)
        if (opts.applyTiers) out.tiers[tierName] = alias
      }
    }
  } catch {
    // no ledger yet: thresholds only
  }
  if (!opts.dryRun) writeJson(learnedPath(), out as unknown as Record<string, unknown>)
  return out
}

// ------------------------------------------------------------------ evaluation --------------

export const EVAL_PATH = join(import.meta.dirname, '..', 'data', 'pennywise-eval.json')
/** Your own labelled cases, from escalations and 'keep-model:' (see addCase). */
export const myEvalPath = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'pennywise_eval.json')
const evalMode = () => env('AGENTARIUM_PENNYWISE_EVAL', 'hash').trim().toLowerCase()
const MY_EVAL_KEEP = 500

/** One tier up: the label for a prompt that was routed too low. */
const up1 = (tier: string) => NEXT[tier] ?? tier

export type Case = { tier: string, prompt?: string | null, sha?: string, score?: number, from?: string, ts?: string }

/** Keep a labelled case in your own set: hash and score always, text only when given (the caller
 *  checks consent). The same prompt is kept once, with its newest label. -> true when kept. */
export function addCase(c: Case, path = myEvalPath()): boolean {
  if (evalMode() === 'off' || !(TIERS as readonly string[]).includes(c.tier)) return false
  try {
    let set: { about?: string, prompts: Case[] } = { prompts: [] }
    try {
      const v = JSON.parse(readFileSync(path, 'utf8'))
      if (isObj(v) && Array.isArray(v.prompts)) set = v as typeof set
    } catch {
      // the first case
    }
    set.about ??= 'Your own labelled prompts, from pennywise escalations and keep-model: overrides. Hash-only cases are ' +
      'scored by their recorded score; set AGENTARIUM_PENNYWISE_EVAL=text to keep the wording so the scorer can re-read them.'
    const rec: Case = { tier: c.tier, sha: c.sha, score: c.score, from: c.from, ts: now() }
    if (c.prompt) rec.prompt = c.prompt
    set.prompts = [...set.prompts.filter((p) => p.sha !== c.sha), rec].slice(-MY_EVAL_KEEP)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(set, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

export type EvalResult = { total: number, correct: number, accuracy: number, under: number, over: number,
  confusion: Record<string, Record<string, number>>, misses: { prompt: string, want: string, got: string, score: number }[] }

/** Score the labelled prompts in data/pennywise-eval.json (or your own set) against the default
 *  thresholds (or `cfg`). A case with text is re-scored; a hash-only case is placed by its recorded
 *  score, so it checks the thresholds, not the signals.
 *  `under` = routed lower than the label (the costly mistake: a model that flounders),
 *  `over` = routed higher (money left on the table). */
export function evaluate(cfg?: RouterConfig, path = EVAL_PATH): EvalResult {
  const set = JSON.parse(readFileSync(path, 'utf8')).prompts as Case[]
  const c = cfg ?? { tiers: { ...DEFAULT_TIERS }, thresholds: { ...DEFAULT_THRESHOLDS } }
  const res: EvalResult = { total: 0, correct: 0, accuracy: 0, under: 0, over: 0, confusion: {}, misses: [] }
  const rank = (t: string) => TIERS.indexOf(t as typeof TIERS[number])
  for (const { prompt, tier, sha, score: was } of set) {
    if (!prompt && typeof was !== 'number') continue
    const r = prompt ? score(prompt, 0, c) : { tier: tierFor(was!, c.thresholds), score: was! }
    res.total++;
    ((res.confusion[tier] ??= {})[r.tier] = (res.confusion[tier][r.tier] ?? 0) + 1)
    if (r.tier === tier) res.correct++
    else {
      if (rank(r.tier) < rank(tier)) res.under++
      else res.over++
      res.misses.push({ prompt: prompt || `(hash ${sha})`, want: tier, got: r.tier, score: r.score })
    }
  }
  res.accuracy = res.total ? round2(res.correct / res.total) : 0
  return res
}

// ------------------------------------------------------------------ the proxy, in the background

const pidPath = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'router.pid')
const routerLog = () => join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'router.log')

/** True when a pennywise proxy answers on `port`. */
export async function healthy(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/pennywise/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok && Boolean(((await r.json()) as Obj).ok)
  } catch {
    return false
  }
}

/** Start the proxy as a background process (if it isn't already up); resolves true once it answers. */
export async function startBackground(port: number): Promise<boolean> {
  if (await healthy(port)) return true
  mkdirSync(dirname(pidPath()), { recursive: true })
  const fd = openSync(routerLog(), 'a')
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', import.meta.filename, 'serve', '--port', String(port)],
    { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, AGENTARIUM_PENNYWISE: 'proxy' } })
  child.unref()
  closeSync(fd)
  writeFileSync(pidPath(), String(child.pid))
  for (let i = 0; i < 25; i++) {
    if (await healthy(port, 400)) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

export function stopBackground(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), 'utf8'), 10)
    if (pid > 0) process.kill(pid)
    writeFileSync(pidPath(), '')
    return pid > 0
  } catch {
    return false
  }
}

/** Claude Code settings file that `on` / `off` edit: the user's, or this project's local one. */
export function settingsFile(project: boolean, cwd = process.cwd()): string {
  return project ? join(cwd, '.claude', 'settings.local.json') : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

/** Point Claude Code at the proxy (on) or back at the API (off), in `file`'s "env". Only the two
 *  keys pennywise owns are touched; ANTHROPIC_MODEL is only removed when it is "pennywise". */
export function setProxyEnv(file: string, on: boolean, port: number): void {
  let s: Obj = {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    if (isObj(v)) s = v
  } catch {
    if (existsSync(file)) throw new Error(`${file} isn't valid JSON; not changing it`)
  }
  const e: Obj = isObj(s.env) ? { ...s.env } : {}
  if (on) {
    e.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
    e.ANTHROPIC_MODEL = 'pennywise'
  } else {
    if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(String(e.ANTHROPIC_BASE_URL ?? ''))) delete e.ANTHROPIC_BASE_URL
    if (String(e.ANTHROPIC_MODEL ?? '').toLowerCase() === 'pennywise') delete e.ANTHROPIC_MODEL
  }
  if (Object.keys(e).length) s.env = e
  else delete s.env
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
}

/** SessionStart: when Claude Code is pointed at the proxy and it isn't answering, start it, so a
 *  reboot never leaves the session talking to nothing. Quiet; never fails. */
export async function ensure(): Promise<void> {
  const m = /^https?:\/\/(127\.0\.0\.1|localhost):(\d+)/.exec(env('ANTHROPIC_BASE_URL'))
  // only our proxy: the router's port, or a session asking for the "pennywise" model
  if (!m || (m[2] !== env('AGENTARIUM_ROUTER_PORT', '8787') && env('ANTHROPIC_MODEL').toLowerCase() !== 'pennywise')) return
  try {
    await startBackground(Number(m[2]))
  } catch (e) {
    logErr(defaultDbPath(), `pennywise ensure\n${errText(e)}`)
  }
}

// ------------------------------------------------------------------ CLI ---------------------

/** Why a prompt lands where it does, with the thresholds learned for this folder's project. */
export function explain(prompt: string, cwd = process.cwd()): string {
  const cfg = loadConfig(telemetry.project(cwd))
  const r = score(prompt, 0, cfg)
  const f = forced(prompt)
  const signed = (w: number) => (w >= 0 ? '+' : '') + String(w)
  const th = cfg.thresholds
  return [
    `tier:    ${r.tier}  (score ${r.score})`,
    `model:   ${resolveModel(f || r.model)}` + (f ? `  (forced with '${f}:')` : ''),
    'signals: ' + (r.signals.map(([n, w]) => `${n} ${signed(w)}`).join(', ') || 'none'),
    'tiers:   ' + ['MEDIUM', 'COMPLEX', 'REASONING'].map((t) => `${t}>=${th[t]}`).join('  '),
  ].join('\n')
}

function portArg(args: string[]): number {
  return Number.parseInt(argValue(args, '--port') ?? env('AGENTARIUM_ROUTER_PORT', '8787'), 10) || 8787
}

export async function main(args: string[]): Promise<number> {
  const cmd = args[0] ?? ''
  if (cmd === 'explain') {
    process.stdout.write(explain(args.length > 1 ? args.slice(1).join(' ') : readStdin()) + '\n')
    return 0
  }
  if (cmd === 'env') {
    const p = portArg(args)
    process.stdout.write(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${p}\nexport ANTHROPIC_MODEL=pennywise\n`)
    return 0
  }
  if (cmd === 'on' || cmd === 'off') {
    const p = portArg(args)
    const file = settingsFile(args.includes('--project'))
    if (cmd === 'off') {
      setProxyEnv(file, false, p)
      const stopped = stopBackground()
      process.stdout.write(`pennywise proxy off${stopped ? ' (stopped)' : ''}. ${file} points Claude Code back at the API; ` +
        'the hook routes again from your next session.\n')
      return 0
    }
    if (!(await startBackground(p))) {
      process.stderr.write(`pennywise: the proxy didn't start on port ${p} (see ${routerLog()}). Nothing changed.\n`)
      return 1
    }
    setProxyEnv(file, true, p)
    process.stdout.write(`pennywise proxy on: http://127.0.0.1:${p} (running in the background, log: ${routerLog()}).\n` +
      `${file} now points Claude Code at it; start a new session to use it. Each request is routed per turn, ` +
      `cache-aware, with fallback, and no subagent hand-off. A SessionStart hook restarts it if it isn't running.\n` +
      `Undo: agentarium router off${args.includes('--project') ? ' --project' : ''}\n`)
    return 0
  }
  if (cmd === 'status') {
    const p = portArg(args)
    const up = await healthy(p)
    const s = savings(defaultDbPath(), { since: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10) })
    const configured = [settingsFile(false), settingsFile(true)].find((f) => {
      try {
        return /^https?:\/\/(127\.0\.0\.1|localhost):/.test(String(JSON.parse(readFileSync(f, 'utf8'))?.env?.ANTHROPIC_BASE_URL ?? ''))
      } catch {
        return false
      }
    })
    const using = proxyActive() || Boolean(configured)
    const ms = measuredSummary(defaultDbPath(), new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
    const pct = (a: number, b: number) => (b > 0 ? ` (${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%)` : '')
    process.stdout.write(`proxy:    ${up ? `running on http://127.0.0.1:${p}` : 'not running'}\n` +
      `routing:  ${mode() === 'off' ? 'off' : using ? `proxy (per request${configured ? `, set in ${configured}` : ''})` : 'hook (subagent hand-off)'}\n` +
      `30 days:  ` + (s.routed ? `${s.routed} routes, saved ~${priced(s.saved)} net of hand-offs` +
        (s.extra > 0.0001 ? `, ~${priced(s.extra)} extra on routes up` : '') : 'nothing routed yet') + '\n' +
      `measured: ` + (ms.n ? `${ms.n} routed subagents: estimated ~${priced(ms.estimated)}, measured ~${priced(ms.measured)}` +
        `${pct(ms.measured, ms.estimated)}; saving estimated ~${priced(ms.estSaved)}, measured ~${priced(ms.saved)}` : 'no routed subagent measured yet') + '\n')
    return 0
  }
  if (cmd === 'ensure') {
    await ensure()
    return 0
  }
  if (cmd === 'learn') {
    const r = await learn(defaultDbPath(), { days: Number(argValue(args, '--days')) || 60, dryRun: args.includes('--dry-run'),
      applyTiers: args.includes('--apply-tiers') })
    if (args.includes('--quiet')) return 0
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n')
      return 0
    }
    const L = ['pennywise learn: what routing down did for you', '']
    for (const [t, st] of Object.entries(r.stats)) {
      const n = st.holds + st.misses
      L.push(`  ${t.padEnd(9)} ${n} routes, ${st.misses} missed (${n ? Math.round(st.misses / n * 100) : 0}%)` +
        (r.offsets[NEXT[t]] ? `  ->  ${NEXT[t]} threshold ${r.offsets[NEXT[t]] > 0 ? '+' : ''}${r.offsets[NEXT[t]]}` : n < LEARN_MIN ? '  (not enough yet)' : '  (holding)'))
    }
    if (!Object.keys(r.stats).length) L.push('  nothing routed down yet: nothing to learn from')
    L.push('', r.work ? `  task shape, from ${r.work.n} measured routes: ${r.work.steps} steps, ${r.work.input} tokens read, ${r.work.output} written, ` +
      `${r.work.secs}s (typical: ${WORK.steps}, ${WORK.input}, ${WORK.output}, ${WORK.secs}s)` : `  task shape: the typical one until ${CALIBRATE_MIN} routes are measured`)
    for (const [p, pr] of Object.entries(r.projects ?? {})) {
      L.push('', `  ${p}: its own thresholds, from its own routes`)
      for (const [t, off] of Object.entries(pr.offsets)) L.push(`    ${t.padEnd(9)} ${off > 0 ? '+' : ''}${off}${off ? '' : ' (holding)'}`)
    }
    for (const sug of r.suggestions) L.push('', `  suggestion: ${sug}` + (args.includes('--apply-tiers') ? ' (applied)' : ' (apply with --apply-tiers)'))
    L.push('', args.includes('--dry-run') ? '(dry run: nothing written)' : `written to ${learnedPath()}  ·  AGENTARIUM_PENNYWISE_LEARN=off ignores it`)
    process.stdout.write(L.join('\n') + '\n')
    return 0
  }
  if (cmd === 'eval') {
    const mine = args.includes('--mine')
    if (mine && !existsSync(myEvalPath())) {
      process.stdout.write(`pennywise eval --mine: no cases yet. Each escalation and keep-model: override adds one to ${myEvalPath()}.\n`)
      return 0
    }
    if (args.includes('--export')) {
      // your cases with text, in the shape of data/pennywise-eval.json, to add to the shared set
      const cases = (JSON.parse(readFileSync(myEvalPath(), 'utf8')).prompts as Case[]).filter((p) => p.prompt)
      process.stdout.write(JSON.stringify({ prompts: cases.map((p) => ({ tier: p.tier, prompt: p.prompt })) }, null, 2) + '\n')
      return 0
    }
    const r = evaluate(args.includes('--learned') ? loadConfig() : undefined, mine ? myEvalPath() : EVAL_PATH)
    if (args.includes('--check')) {
      // for CI: a scorer change that routes the labelled set worse fails the build
      const minAcc = Number(argValue(args, '--min-accuracy') ?? 0.85)
      const maxUnder = Number(argValue(args, '--max-under') ?? 3)
      const ok = r.accuracy >= minAcc && r.under <= maxUnder
      process.stdout.write(`pennywise eval --check: ${r.correct}/${r.total} on the right tier (${Math.round(r.accuracy * 100)}%, need ` +
        `${Math.round(minAcc * 100)}%), ${r.under} routed too low (at most ${maxUnder}): ${ok ? 'ok' : 'FAILED'}\n`)
      if (!ok) for (const m of r.misses) process.stdout.write(`  ${m.want} -> ${m.got} (${m.score}): ${m.prompt}\n`)
      return ok ? 0 : 1
    }
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n')
      return 0
    }
    const L = [`pennywise eval: ${r.correct}/${r.total} prompts on the right tier (${Math.round(r.accuracy * 100)}%)`,
      `  routed too low: ${r.under}  ·  routed too high: ${r.over}`, '', '  label \\ routed   ' + TIERS.map((t) => t.padEnd(10)).join('')]
    for (const t of TIERS) L.push(`  ${t.padEnd(16)} ` + TIERS.map((g) => String(r.confusion[t]?.[g] ?? 0).padEnd(10)).join(''))
    if (args.includes('--misses')) for (const m of r.misses) L.push(`  ${m.want} -> ${m.got} (${m.score}): ${m.prompt}`)
    process.stdout.write(L.join('\n') + '\n')
    return 0
  }
  if (cmd === 'serve') {
    const p = portArg(args)
    await serve(p)
    const tiers = loadConfig().tiers
    process.stdout.write(`pennywise router on http://127.0.0.1:${p}  ->  ${env('AGENTARIUM_ROUTER_UPSTREAM') || 'https://api.anthropic.com'}\n` +
      `tiers: ${TIERS.map((t) => `${t}=${resolveModel(tiers[t])}`).join(', ')}\n` +
      `use it:  ANTHROPIC_BASE_URL=http://127.0.0.1:${p} ANTHROPIC_MODEL=pennywise claude\n`)
    process.on('SIGINT', () => process.exit(0))
    return 0
  }
  try {                                                      // hook mode
    const raw = readStdin()
    const d = raw.trim() ? JSON.parse(raw) : {}
    const out = handle(isObj(d) ? d : {})
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `pennywise hook\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
