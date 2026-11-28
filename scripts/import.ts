#!/usr/bin/env node
/**
 * agentarium / import: bring a tokenomics install's history and settings over.
 *
 * agentarium was called tokenomics until 0.0.1. This copies what tokenomics recorded and was told
 * into agentarium's data folder, and leaves tokenomics's own files exactly as they are:
 *
 *   spendlens.db -> till.db  every session, cost and guard event: a consistent copy, safe while
 *                            tokenomics is still running. Only into an agentarium that has recorded
 *                            nothing yet; --force replaces what it has (kept as till.db.bak).
 *   config.json              the profile, per-folder profiles and "settings" (TOKENOMICS_ keys become
 *                            AGENTARIUM_ ones), merged key by key: a value agentarium has is kept
 *   statusline.json, router.json, providers.json, plans.json, pennywise_learned.json, pennywise_eval.json
 *                            merged the same way
 *   TOKENOMICS_* settings    from this shell and from Claude Code's settings.json "env", into
 *                            config.json "settings", where agentarium reads them (an AGENTARIUM_*
 *                            variable still wins over the file)
 *   the statusline           moved to agentarium's copy if it still runs tokenomics's
 *
 * `agentarium setup` runs it by itself when agentarium has recorded nothing yet.
 *
 * Usage:
 *   import.ts [--from DIR] [--force] [--dry-run] [--json]
 *
 * Settings: TOKENOMICS_HOME (where tokenomics kept its data, default ~/.tokenomics; --from wins),
 * AGENTARIUM_HOME and AGENTARIUM_DB (where it goes).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { dataDir, defaultDbPath } from '../agentarium/config.ts'
import { Db } from '../agentarium/engine/db.ts'
import { connect } from '../agentarium/engine/store.ts'
import { argValue, errText, isMain, isObj, now, type Obj } from '../agentarium/util.ts'
import * as statusline from './statusline.ts'

const readObj = (path: string): Obj | null => {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** A TOKENOMICS_ setting from this shell, else from Claude Code's settings.json "env". */
function tokenomicsEnv(name: string): string {
  const claude = readObj(statusline.settingsPath('claude'))?.env
  return process.env[name] || (isObj(claude) && typeof claude[name] === 'string' ? claude[name] : '')
}

export const tokenomicsHome = () => tokenomicsEnv('TOKENOMICS_HOME') || join(homedir(), '.tokenomics')

/** Files merged key by key: a key agentarium already has wins. */
export const MERGED = ['statusline.json', 'router.json', 'providers.json', 'plans.json', 'pennywise_learned.json', 'pennywise_eval.json']

/** TOKENOMICS_ names that say where tokenomics lives or how its installer ran, not how it behaves. */
const PLACES = new Set(['HOME', 'DB', 'REPO', 'REF', 'NODE', 'ROOT', 'SETUP_ARGS'])

export type Result = {
  from: string
  /** false: no tokenomics install there, and nothing was done. */
  found: boolean
  /** kept: agentarium has sessions of its own (or brought these over already: `before`). */
  db: { action: 'copied' | 'replaced' | 'kept' | 'none', sessions: number, kept: number, path: string, before: string | null }
  /** config.json and the MERGED files: what each gained. */
  files: { name: string, keys: number, created: boolean }[]
  /** TOKENOMICS_* settings carried into config.json, as config keys ("budget_daily"). */
  settings: string[]
  statusline: string[]
  tokenomicsPluginOn: boolean
  dryRun: boolean
}

const count = (path: string): number => {
  if (!existsSync(path)) return 0
  try {
    const db = new Db(path, { readOnly: true })
    try {
      return db.columns('sessions').size ? Number(db.get('SELECT COUNT(*) AS n FROM sessions')!.n) : 0
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}

/** tokenomics's config.json in agentarium's terms: TOKENOMICS_ settings keys renamed. */
export function translateConfig(cfg: Obj): Obj {
  const out: Obj = { ...cfg }
  if (isObj(cfg.settings)) {
    out.settings = Object.fromEntries(Object.entries(cfg.settings).map(([k, v]) =>
      [/^TOKENOMICS_[A-Z0-9_]+$/.test(k) ? `AGENTARIUM_${k.slice('TOKENOMICS_'.length)}` : k, v]))
  }
  return out
}

/** A setting's one name, however config.json spells it: budget_daily and AGENTARIUM_BUDGET_DAILY are the same. */
const settingName = (k: string) => (k.startsWith('AGENTARIUM_') ? k : `AGENTARIUM_${k.toUpperCase()}`)

/** Add what `ours` lacks from `theirs`, one level into "settings" and "projects"; ours wins. */
export function merge(ours: Obj, theirs: Obj): { merged: Obj, added: number } {
  const merged: Obj = { ...ours }
  let added = 0
  for (const [k, v] of Object.entries(theirs)) {
    if (!(k in merged)) {
      merged[k] = v
      added += isObj(v) ? Object.keys(v).length || 1 : 1
    } else if ((k === 'settings' || k === 'projects') && isObj(merged[k]) && isObj(v)) {
      const inner = { ...merged[k] }
      const name = k === 'settings' ? settingName : (key: string) => key
      const have = new Set(Object.keys(inner).map(name))
      for (const [ik, iv] of Object.entries(v)) {
        if (!have.has(name(ik))) {
          inner[ik] = iv
          added++
        }
      }
      merged[k] = inner
    }
  }
  return { merged, added }
}

/** The TOKENOMICS_* settings in force: Claude Code's settings.json "env" over this shell's. */
export function envSettings(env: NodeJS.ProcessEnv = process.env, claudeSettings = statusline.settingsPath('claude')): Record<string, string> {
  const claude = readObj(claudeSettings)?.env
  const out: Record<string, string> = {}
  for (const source of [env, isObj(claude) ? claude : {}]) {
    for (const [k, v] of Object.entries(source)) {
      const m = /^TOKENOMICS_([A-Z0-9_]+)$/.exec(k)
      if (m && !PLACES.has(m[1]) && typeof v === 'string' && v.trim() !== '') out[m[1]] = v
    }
  }
  return out
}

/** Copy tokenomics's database to `to` in one consistent snapshot, then bring it up to date. */
function copyDb(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  const tmp = `${to}.import`
  rmSync(tmp, { force: true })
  try {
    const src = new Db(from, { readOnly: true })
    try {
      src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
    } finally {
      src.close()
    }
    const db = new Db(tmp)
    try {
      // doggybag's table had the name it had before it was doggybag; the controller's first step was spendlens
      if (db.columns('handoff_events').size && !db.columns('doggybag_events').size) db.exec('ALTER TABLE handoff_events RENAME TO doggybag_events')
      if (db.columns('controller_events').has('step')) db.run("UPDATE controller_events SET step='till' WHERE step='spendlens'")
    } finally {
      db.close()
    }
    connect(tmp).close()                           // any columns tokenomics's schema predates
    renameSync(tmp, to)
  } catch (e) {
    rmSync(tmp, { force: true })                   // a half-made copy never stays behind
    throw e
  }
}

/** A tokenomics install at `from`: its database or any of its settings files. */
export const found = (from = tokenomicsHome()): boolean =>
  ['spendlens.db', 'config.json', ...MERGED].some((f) => existsSync(join(from, f)))

/** Brought over already: scripts/import.ts left its record. */
export const imported = (): boolean => existsSync(statusline.IMPORTED_FILE)

export function bringOver(opts: { from?: string, force?: boolean, dryRun?: boolean } = {}): Result {
  const from = opts.from ?? tokenomicsHome()
  const to = dataDir()
  const dbFrom = (!opts.from && tokenomicsEnv('TOKENOMICS_DB')) || join(from, 'spendlens.db')
  const dbTo = defaultDbPath()
  const before = readObj(statusline.IMPORTED_FILE)
  const r: Result = { from, found: false, db: { action: 'none', sessions: 0, kept: 0, path: dbTo,
    before: before && ['copied', 'replaced'].includes(before.db) ? String(before.at ?? '') : null }, files: [], settings: [],
    statusline: [], tokenomicsPluginOn: statusline.tokenomicsPluginOn(), dryRun: Boolean(opts.dryRun) }
  r.found = existsSync(dbFrom) || found(from)
  if (!r.found) return r

  // the history
  if (existsSync(dbFrom)) {
    r.db.sessions = count(dbFrom)
    r.db.kept = count(dbTo)
    r.db.action = !existsSync(dbTo) ? 'copied' : r.db.kept === 0 || opts.force ? 'replaced' : 'kept'
    if (!opts.dryRun && r.db.action !== 'kept') {
      if (existsSync(dbTo)) copyFileSync(dbTo, `${dbTo}.bak`)
      copyDb(dbFrom, dbTo)
    }
  }

  // config.json: tokenomics's file, then the settings it was given in the environment
  const cfgTo = join(to, 'config.json')
  const ours = readObj(cfgTo)
  let { merged, added } = merge(ours ?? {}, translateConfig(readObj(join(from, 'config.json')) ?? {}))
  const settings: Obj = isObj(merged.settings) ? { ...merged.settings } : {}
  for (const [name, value] of Object.entries(envSettings())) {
    if (name === 'PROFILE') {
      if (!merged.profile) {
        merged.profile = value.trim().toLowerCase()
        added++
        r.settings.push('profile')
      }
      continue
    }
    const key = name.toLowerCase()
    if (Object.keys(settings).some((k) => settingName(k) === `AGENTARIUM_${name}`)) continue
    settings[key] = value
    added++
    r.settings.push(key)
  }
  if (Object.keys(settings).length) merged = { ...merged, settings }
  if (added) {
    r.files.push({ name: 'config.json', keys: added, created: ours === null })
    if (!opts.dryRun) {
      mkdirSync(to, { recursive: true })
      writeFileSync(cfgTo, JSON.stringify(merged, null, 2) + '\n')
    }
  }

  // the rest of the settings files
  for (const name of MERGED) {
    const theirs = readObj(join(from, name))
    if (!theirs) continue
    const mine = readObj(join(to, name))
    const m = merge(mine ?? {}, theirs)
    if (!m.added) continue
    r.files.push({ name, keys: m.added, created: mine === null })
    if (!opts.dryRun) {
      mkdirSync(to, { recursive: true })
      writeFileSync(join(to, name), JSON.stringify(m.merged, null, 2) + '\n')
    }
  }

  if (opts.dryRun) {
    r.statusline = ['claude', 'copilot'].filter((t) => statusline.isTokenomics(statusline.statusLine(t)))
  } else {
    r.statusline = statusline.migrate()
    if (r.db.action !== 'kept' || !r.db.before) {         // a re-run that changed nothing keeps the first record
      mkdirSync(dirname(statusline.IMPORTED_FILE), { recursive: true })
      writeFileSync(statusline.IMPORTED_FILE, JSON.stringify({ from, at: now(), sessions: r.db.sessions, db: r.db.action }) + '\n')
    }
  }
  return r
}

/** What happened, in words. */
export function summary(r: Result): string[] {
  if (!r.found) return [`No tokenomics install in ${r.from}: nothing to bring over.`]
  const changed = ['copied', 'replaced'].includes(r.db.action) || r.files.length > 0 || r.statusline.length > 0
  const L = [changed ? `${r.dryRun ? 'Would bring' : 'Brought'} over from ${r.from} (its own files are left as they are):`
    : `Nothing new to bring over from ${r.from}:`]
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
  if (r.db.action === 'kept' && r.db.before) {
    L.push(`  · history: brought over already (${r.db.before.slice(0, 10)}); --force copies tokenomics's ${n(r.db.sessions, 'session')} again`)
  } else if (r.db.action === 'kept') {
    L.push(`  · history: kept agentarium's own ${n(r.db.kept, 'session')}; --force replaces them with tokenomics's ${n(r.db.sessions, 'session')}`)
  } else if (r.db.action !== 'none') {
    L.push(`  ✓ history: ${n(r.db.sessions, 'session')}, into ${r.db.path}${r.db.action === 'replaced' && r.db.kept ? ` (agentarium's ${n(r.db.kept, 'session')} kept in ${basename(r.db.path)}.bak)` : ''}`)
  }
  for (const f of r.files) L.push(`  ✓ ${f.name}: ${n(f.keys, 'value')}${f.created ? '' : ' added, yours kept'}`)
  if (r.settings.length) L.push(`  ✓ settings from your environment: ${r.settings.join(', ')}, into config.json (agentarium doesn't read TOKENOMICS_ variables)`)
  if (r.statusline.length) L.push(`  ✓ statusline: agentarium's copy ${r.dryRun ? 'would replace' : 'replaced'} tokenomics's (${r.statusline.join(' and ')})`)
  if (L.length === 1) L.push('  · agentarium already has all of it')
  if (r.tokenomicsPluginOn) L.push('  ! tokenomics is still installed in Claude Code, so every prompt is checked twice. Remove it: claude plugin uninstall tokenomics@tokenomics')
  return L
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const r = bringOver({ from: argValue(argv, '--from') ?? undefined, force: argv.includes('--force'), dryRun: argv.includes('--dry-run') })
    process.stdout.write(argv.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : summary(r).join('\n') + '\n')
    return 0
  } catch (e) {
    process.stderr.write(`agentarium import: ${errText(e).split('\n')[0]}\n`)
    return 1
  }
}

if (isMain(import.meta.url)) process.exitCode = main()
