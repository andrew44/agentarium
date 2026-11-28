#!/usr/bin/env node
/**
 * agentarium / import: bring a tokenomics install's history and settings over.
 *
 * agentarium was called tokenomics until 0.0.1. This copies what tokenomics recorded and was told
 * into agentarium's data folder, and leaves tokenomics's own files exactly as they are:
 *
 *   spendlens.db -> till.db  every session, cost and guard event, added to till.db in one
 *                            transaction: the file is never replaced, and nothing in it is changed or
 *                            removed (a session agentarium has already keeps agentarium's row). Read
 *                            from a consistent copy, so it is safe while tokenomics is running. The
 *                            first time, the history goes in ahead of what agentarium has recorded
 *                            since; a later run adds only what tokenomics recorded after the last.
 *                            A copy of till.db as it was is kept in backups/ first.
 *   config.json              the profile, per-folder profiles and "settings" (TOKENOMICS_ keys become
 *                            AGENTARIUM_ ones), merged key by key: a value agentarium has is kept
 *   statusline.json, router.json, providers.json, plans.json, pennywise_learned.json, pennywise_eval.json
 *                            merged the same way
 *   TOKENOMICS_* settings    from this shell and from Claude Code's settings.json "env", into
 *                            config.json "settings", where agentarium reads them (an AGENTARIUM_*
 *                            variable still wins over the file)
 *   the status line          moved to agentarium's copy if it still runs tokenomics's
 *
 * `agentarium setup` runs it by itself when agentarium has recorded nothing yet.
 *
 * Usage:
 *   import.ts [--from DIR] [--dry-run] [--json]
 *
 * Settings: TOKENOMICS_HOME (where tokenomics kept its data, default ~/.tokenomics; --from wins),
 * AGENTARIUM_HOME and AGENTARIUM_DB (where it goes).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { dataDir, defaultDbPath } from '../agentarium/config.ts'
import { snapshot, stamp } from '../agentarium/engine/backup.ts'
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
  /** merged: rows were added; current: nothing new since the last import; none: no history to bring. */
  db: { action: 'merged' | 'current' | 'none', sessions: number, added: number, rows: number, already: number, path: string, backup: string | null }
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

/** Read tokenomics's database through a consistent copy (VACUUM INTO from a read-only handle: safe
 *  while tokenomics writes), with doggybag's table and the controller's first step renamed the way
 *  agentarium calls them. The caller deletes the copy. */
function readableCopy(from: string, tmp: string): void {
  rmSync(tmp, { force: true })
  const src = new Db(from, { readOnly: true })
  try {
    src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
  } finally {
    src.close()
  }
  const db = new Db(tmp)
  try {
    if (db.columns('handoff_events').size && !db.columns('doggybag_events').size) db.exec('ALTER TABLE handoff_events RENAME TO doggybag_events')
    if (db.columns('controller_events').has('step')) db.run("UPDATE controller_events SET step='till' WHERE step='spendlens'")
  } finally {
    db.close()
  }
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Add table `t` of the attached `src` to main, inside the caller's transaction. Nothing in main is
 *  changed but ids: on the first import, main's own rows move up to make room, so the older history
 *  sits before them and "the latest" stays the latest. Returns the rows added. */
function mergeTable(db: Db, t: string): number {
  const srcCols = db.all(`PRAGMA src.table_info(${q(t)})`)
  if (!db.all(`PRAGMA main.table_info(${q(t)})`).length) {
    db.exec(String(db.get("SELECT sql FROM src.sqlite_master WHERE type='table' AND name=?", t)!.sql))
  }
  const have = new Set(db.all(`PRAGMA main.table_info(${q(t)})`).map((c) => String(c.name)))
  for (const c of srcCols) if (!have.has(c.name)) db.exec(`ALTER TABLE main.${q(t)} ADD COLUMN ${q(c.name)} ${c.type || ''}`)
  const cols = srcCols.map((c) => String(c.name))
  const pk = srcCols.filter((c) => c.pk > 0)
  const before = Number(db.get(`SELECT COUNT(*) AS n FROM main.${q(t)}`)!.n)
  // a natural key (sessions, ledger, blinkers_scope ...): a row agentarium already has keeps its own
  if (pk.length && !(pk.length === 1 && String(pk[0].type).toUpperCase() === 'INTEGER')) {
    db.run(`INSERT OR IGNORE INTO main.${q(t)} (${cols.map(q).join(',')}) SELECT ${cols.map(q).join(',')} FROM src.${q(t)}`)
    return Number(db.get(`SELECT COUNT(*) AS n FROM main.${q(t)}`)!.n) - before
  }
  // an event table, keyed by its row id
  const name = pk.length ? String(pk[0].name) : 'rowid'
  const id = pk.length ? q(name) : 'rowid'              // bare: a quoted "rowid" can read as a string
  const rest = cols.filter((c) => c !== name).map(q).join(',')
  const done = db.get('SELECT last_id FROM import_progress WHERE source=? AND tbl=?', 'tokenomics', t)
  if (!done) {
    const n = Number(db.get(`SELECT COUNT(*) AS n FROM src.${q(t)}`)!.n)
    if (n && before) {                                   // two steps, so no id ever clashes on the way
      db.run(`UPDATE main.${q(t)} SET ${id} = -${id}`)
      db.run(`UPDATE main.${q(t)} SET ${id} = ? - ${id}`, n)
    }
    db.run(`INSERT INTO main.${q(t)} (${id},${rest}) SELECT ROW_NUMBER() OVER (ORDER BY ${id}),${rest} FROM src.${q(t)}`)
  } else {
    db.run(`INSERT INTO main.${q(t)} (${rest}) SELECT ${rest} FROM src.${q(t)} WHERE ${id} > ? ORDER BY ${id}`, Number(done.last_id))
  }
  const last = db.get(`SELECT MAX(${id}) AS m FROM src.${q(t)}`)!.m
  db.run('INSERT OR REPLACE INTO import_progress(source, tbl, last_id) VALUES(?,?,?)', 'tokenomics', t, Number(last ?? 0))
  // AUTOINCREMENT carries on past the highest id now in the table, not the one before the move
  if (db.get("SELECT 1 AS x FROM main.sqlite_master WHERE name='sqlite_sequence'")) {
    db.run(`UPDATE main.sqlite_sequence SET seq = (SELECT MAX(${id}) FROM main.${q(t)}) WHERE name = ? AND seq < (SELECT MAX(${id}) FROM main.${q(t)})`, t)
  }
  return Number(db.get(`SELECT COUNT(*) AS n FROM main.${q(t)}`)!.n) - before
}

/** Bring tokenomics's history into till.db (see the top of this file). */
function mergeDb(from: string, to: string, r: Result): void {
  const tmp = `${to}.tokenomics.${process.pid}.tmp`
  mkdirSync(dirname(to), { recursive: true })
  readableCopy(from, tmp)
  try {
    const db = connect(to)                          // the live file: created if need be, never replaced
    try {
      if (r.db.already) r.db.backup = snapshot(db, to, `before-import-${stamp()}`)
      db.exec('CREATE TABLE IF NOT EXISTS import_progress(source TEXT, tbl TEXT, last_id INTEGER, PRIMARY KEY(source, tbl))')
      db.run('ATTACH DATABASE ? AS src', tmp)
      try {
        const tables = db.all("SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((x) => String(x.name))
        db.raw.exec('BEGIN IMMEDIATE')
        try {
          for (const t of tables) {
            const added = mergeTable(db, t)
            r.db.rows += added
            if (t === 'sessions') r.db.added = added
          }
          db.raw.exec('COMMIT')
        } catch (e) {
          db.raw.exec('ROLLBACK')
          throw e
        }
      } finally {
        db.run('DETACH DATABASE src')
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** A tokenomics install at `from`: its database or any of its settings files. */
export const found = (from = tokenomicsHome()): boolean =>
  ['spendlens.db', 'config.json', ...MERGED].some((f) => existsSync(join(from, f)))

/** Brought over already: scripts/import.ts left its record. */
export const imported = (): boolean => existsSync(statusline.IMPORTED_FILE)

export function bringOver(opts: { from?: string, dryRun?: boolean } = {}): Result {
  const from = opts.from ?? tokenomicsHome()
  const to = dataDir()
  const dbFrom = (!opts.from && tokenomicsEnv('TOKENOMICS_DB')) || join(from, 'spendlens.db')
  const dbTo = defaultDbPath()
  const r: Result = { from, found: false, db: { action: 'none', sessions: 0, added: 0, rows: 0, already: 0, path: dbTo, backup: null }, files: [], settings: [],
    statusline: [], tokenomicsPluginOn: statusline.tokenomicsPluginOn(), dryRun: Boolean(opts.dryRun) }
  r.found = existsSync(dbFrom) || found(from)
  if (!r.found) return r

  // the history
  if (existsSync(dbFrom)) {
    r.db.sessions = count(dbFrom)
    r.db.already = count(dbTo)
    if (opts.dryRun) {
      r.db.action = 'merged'
    } else {
      mergeDb(dbFrom, dbTo, r)
      r.db.action = r.db.rows || !existsSync(statusline.IMPORTED_FILE) ? 'merged' : 'current'
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
    if (r.db.action !== 'current') {                         // a re-run that added nothing keeps the first record
      mkdirSync(dirname(statusline.IMPORTED_FILE), { recursive: true })
      writeFileSync(statusline.IMPORTED_FILE, JSON.stringify({ from, at: now(), sessions: r.db.sessions, added: r.db.added }) + '\n')
    }
  }
  return r
}

/** What happened, in words. */
export function summary(r: Result): string[] {
  if (!r.found) return [`No tokenomics install in ${r.from}: nothing to bring over.`]
  const changed = r.db.action === 'merged' || r.files.length > 0 || r.statusline.length > 0
  const L = [changed ? `${r.dryRun ? 'Would bring' : 'Brought'} over from ${r.from} (its own files are left as they are):`
    : `Nothing new to bring over from ${r.from}:`]
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
  if (r.db.action === 'current') {
    L.push(`  · history: nothing new since the last import (${n(r.db.sessions, 'session')} in ${r.db.path})`)
  } else if (r.db.action === 'merged' && r.dryRun) {
    L.push(`  ✓ history: ${n(r.db.sessions, 'session')}, added to ${r.db.path}${r.db.already ? `, beside agentarium's own ${n(r.db.already, 'session')}` : ''}`)
  } else if (r.db.action === 'merged') {
    L.push(`  ✓ history: ${r.db.added || !r.db.rows ? n(r.db.added, 'session') : n(r.db.rows, 'record')} added to ${r.db.path}${r.db.already ? ` (agentarium's own ${n(r.db.already, 'session')} kept; ` +
      `a copy from before is in ${r.db.backup ? basename(dirname(r.db.backup)) + '/' + basename(r.db.backup) : 'backups/'})` : ''}`)
  }
  for (const f of r.files) L.push(`  ✓ ${f.name}: ${n(f.keys, 'value')}${f.created ? '' : ' added, yours kept'}`)
  if (r.settings.length) L.push(`  ✓ settings from your environment: ${r.settings.join(', ')}, into config.json (agentarium doesn't read TOKENOMICS_ variables)`)
  if (r.statusline.length) L.push(`  ✓ status line: agentarium's copy ${r.dryRun ? 'would replace' : 'replaced'} tokenomics's (${r.statusline.join(' and ')})`)
  if (L.length === 1) L.push('  · agentarium already has all of it')
  if (r.tokenomicsPluginOn) L.push('  ! tokenomics is still installed in Claude Code, so every prompt is checked twice. Remove it: claude plugin uninstall tokenomics@tokenomics')
  return L
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const r = bringOver({ from: argValue(argv, '--from') ?? undefined, dryRun: argv.includes('--dry-run') })
    process.stdout.write(argv.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : summary(r).join('\n') + '\n')
    return 0
  } catch (e) {
    process.stderr.write(`agentarium import: ${errText(e).split('\n')[0]}\n`)
    return 1
  }
}

if (isMain(import.meta.url)) process.exitCode = main()
