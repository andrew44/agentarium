/**
 * Profiles and the config file: a few dozen switches, set with one word.
 *
 * Every helper still reads its own TOKENOMICS_* environment variable. This module fills in the
 * ones you haven't set, before any helper reads them, from (strongest first):
 *
 *   1. the environment itself                          always wins
 *   2. ~/.tokenomics/config.json "settings"            your own defaults, in one file
 *   3. the profile, the first of:
 *        TOKENOMICS_PROFILE                            in the environment
 *        the budget phase                              opted in with "budget_profile" (TOKENOMICS_BUDGET_PROFILE):
 *                                                      once today's budget passes its warning share,
 *                                                      that profile for the rest of the day (budget.ts marks it)
 *        config.json "projects"                        by folder: the longest path prefix of the working
 *                                                      folder ("~" works); a key without a slash matches
 *                                                      TOKENOMICS_PROJECT
 *        config.json "profile"                         everywhere else
 *        frugal     route down harder, never up; pause floods, loops, carried context and needless subagents;
 *                   pause pastes from 5,000 tokens; confirm instruction-file edits mid-session; warn at 70%
 *        balanced   the defaults (the same as no profile)
 *        quality    never below Sonnet, Fable for reasoning; guard-rails warn instead of pausing;
 *                   no budget squeeze (the budget's hard pause still applies)
 *
 * config.json:
 *   { "profile": "balanced",
 *     "projects": { "~/work/api": "quality", "~/scratch": "frugal" },
 *     "settings": { "budget_daily": 20, "budget_profile": "frugal", "currency": "USD", "TOKENOMICS_DIET_MAX_KB": 128 } }
 * A lower-case key is a TOKENOMICS_ name without the prefix ("budget_daily" = TOKENOMICS_BUDGET_DAILY).
 *
 * `tokenomics profile` shows what is in effect and where each value came from. This file must not
 * import anything from tokenomics/ (util.ts imports it, for its side effect, before anything else).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'

export const PROFILES: Record<string, Record<string, string>> = {
  frugal: {
    TOKENOMICS_ROUTER_TIERS: 'SIMPLE=haiku,MEDIUM=haiku,COMPLEX=sonnet,REASONING=opus',
    TOKENOMICS_PENNYWISE_UP: 'off',
    TOKENOMICS_BUDGET_WARN: '70',
    TOKENOMICS_DIET: 'block',
    TOKENOMICS_GROUNDHOG: 'block',
    TOKENOMICS_BALLAST: 'block',
    TOKENOMICS_BALLAST_MIN_TOKENS: '40000',
    TOKENOMICS_HOLDUP_MIN_TOKENS: '5000',
    TOKENOMICS_CACHEBUSTER: 'ask',
    TOKENOMICS_TOOMANYCOOKS: 'block',
  },
  balanced: {},
  quality: {
    TOKENOMICS_ROUTER_TIERS: 'SIMPLE=sonnet,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable',
    TOKENOMICS_PENNYWISE_BUDGET: 'off',
    TOKENOMICS_DIET: 'warn',
    TOKENOMICS_GROUNDHOG: 'warn',
    TOKENOMICS_BALLAST: 'warn',
    TOKENOMICS_HOLDUP: 'warn',
  },
}

export const configFile = () => join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'config.json')

/** Where budget.ts marks the day a budget passed its warning share: {"day": "YYYY-MM-DD", "pct": 84}. */
export const phaseFile = () => join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'budget_phase.json')

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** True when today's budget has passed its warning share (the phase file is from today). */
export function inBudgetPhase(file = phaseFile(), d = new Date()): boolean {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.day === localDay(d)
  } catch {
    return false
  }
}

/** The "projects" entry for `cwd`: the longest folder prefix, or a bare name equal to `name`. */
export function projectProfile(projects: unknown, cwd: string, name = ''): { key: string, profile: string } | null {
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null
  const here = resolvePath(cwd)
  let best: { key: string, profile: string, len: number } | null = null
  for (const [key, v] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    let len = -1
    if (/[\\/~]/.test(key)) {
      const dir = resolvePath(key === '~' || key.startsWith('~/') || key.startsWith('~\\') ? join(homedir(), key.slice(1)) : key)
      if (here === dir || here.startsWith(dir.endsWith(sep) ? dir : dir + sep)) len = dir.length
    } else if (name && key === name) {
      len = 0
    }
    if (len >= 0 && (!best || len > best.len)) best = { key, profile: v.trim().toLowerCase(), len }
  }
  return best && { key: best.key, profile: best.profile }
}

/** 'budget_daily' -> 'TOKENOMICS_BUDGET_DAILY'; upper-case names pass through. */
export function envName(key: string): string | null {
  const k = key.trim()
  if (/^TOKENOMICS_[A-Z0-9_]+$/.test(k)) return k
  if (/^[a-z][a-z0-9_]*$/.test(k)) return `TOKENOMICS_${k.toUpperCase()}`
  return null
}

export type Source = 'env' | 'config' | 'profile'
/** Where the profile came from: the environment, the budget phase, a "projects" entry or "profile". */
export type ProfileFrom = 'env' | 'phase' | 'project' | 'config'
export type Resolved = { profile: string | null, from: ProfileFrom | null, project: string | null,
  values: Record<string, { value: string, from: Source }>, errors: string[] }

/** What the environment would be after filling in: each value and where it came from. Pure, but
 *  for reading the config file and the phase file. */
export function resolve(env: NodeJS.ProcessEnv = process.env, file = configFile(), cwd = process.cwd(), phase = phaseFile()): Resolved {
  const errors: string[] = []
  let cfg: Record<string, any> = {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) cfg = v
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') errors.push(`${file}: not valid JSON, ignored`)
  }
  const settings = cfg.settings && typeof cfg.settings === 'object' ? cfg.settings : {}
  const setting = (name: string) => String(env[`TOKENOMICS_${name.toUpperCase()}`] || settings[name] || settings[`TOKENOMICS_${name.toUpperCase()}`] || '').trim()
  const proj = projectProfile(cfg.projects, cwd, setting('project'))
  const phased = setting('budget_profile').toLowerCase()
  let profile: string | null = null
  let from: ProfileFrom | null = null
  if (env.TOKENOMICS_PROFILE?.trim()) [profile, from] = [env.TOKENOMICS_PROFILE.trim().toLowerCase(), 'env']
  else if (phased && inBudgetPhase(phase)) [profile, from] = [phased, 'phase']
  else if (proj) [profile, from] = [proj.profile, 'project']
  else if (typeof cfg.profile === 'string' && cfg.profile.trim()) [profile, from] = [cfg.profile.trim().toLowerCase(), 'config']
  if (profile && !(profile in PROFILES)) errors.push(`unknown profile "${profile}" (frugal, balanced or quality)`)
  const values: Resolved['values'] = {}
  for (const [k, v] of Object.entries(PROFILES[profile ?? ''] ?? {})) values[k] = { value: v, from: 'profile' }
  for (const [k, v] of Object.entries(settings)) {
    const name = envName(k)
    if (!name || v === null || typeof v === 'object') {
      errors.push(`settings.${k}: not a TOKENOMICS_ setting, ignored`)
      continue
    }
    values[name] = { value: String(v), from: 'config' }
  }
  for (const [k, v] of Object.entries(env)) if (k.startsWith('TOKENOMICS_') && v !== undefined && v !== '') values[k] = { value: v, from: 'env' }
  return { profile, from, project: from === 'project' ? proj!.key : null, values, errors }
}

/** The names applyProfile filled in for this process (so `tokenomics profile` can tell them apart). */
export const FILLED = new Set<string>()

/** Fill in the unset TOKENOMICS_* variables from the config file and the profile. Never throws. */
export function applyProfile(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const r = resolve(env)
    for (const [k, { value, from }] of Object.entries(r.values)) {
      if (from === 'env') continue
      env[k] = value
      if (env === process.env) FILLED.add(k)
    }
  } catch {
    // a broken config file never stops a hook
  }
}

applyProfile()
