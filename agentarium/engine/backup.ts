/**
 * Copies of till's database, so an upgrade or an import never costs recorded history.
 *
 * snapshot() takes a consistent copy with VACUUM INTO (safe while hooks are writing) into a
 * backups/ folder beside the database, under a name nothing else uses, and never over another
 * file. guardUpgrade() runs as store.connect() opens the database: the first time a different
 * agentarium version opens it, it keeps a copy as it was, `<name>-before-<version>-<day>.db`, then
 * notes the new version in the database header (PRAGMA user_version). Only those copies are ever
 * pruned, the newest AGENTARIUM_BACKUPS (default 3) kept; 0 turns them off. Copies made before an
 * import (`<name>-before-import-<when>.db`) are never deleted by agentarium.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

import { VERSION } from '../index.ts'
import { errText, logErr } from '../util.ts'
import type { Db } from './db.ts'

export const backupDir = (dbPath: string) => join(dirname(dbPath), 'backups')

/** '1.2.3' as the integer the database header holds (1002003); 0 for anything else. */
export function versionNumber(v: string): number {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
  return m ? Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]) : 0
}

/** How many upgrade copies to keep: AGENTARIUM_BACKUPS, default 3, 0 for none. */
export function keepCount(): number {
  const n = Number((process.env.AGENTARIUM_BACKUPS ?? '').trim() || 3)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Local time as 20261128-093015. */
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** Move `tmp` to `out` unless `out` exists: a hard link fails rather than replace, so two hooks
 *  copying at once can't both write the same file. Returns whether `tmp` landed. */
function placeNew(tmp: string, out: string): boolean {
  try {
    linkSync(tmp, out)
    rmSync(tmp, { force: true })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      rmSync(tmp, { force: true })
      return false
    }
  }
  if (existsSync(out)) {                                   // a filesystem without hard links
    rmSync(tmp, { force: true })
    return false
  }
  renameSync(tmp, out)
  return true
}

/** A consistent copy of the open database `db` (whose file is `dbPath`) as
 *  backups/<name>-<label>.db. Returns its path, or null when a copy by that name exists already.
 *  Must run outside a transaction: VACUUM can't run inside one. */
export function snapshot(db: Db, dbPath: string, label: string): string | null {
  const dir = backupDir(dbPath)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${basename(dbPath, extname(dbPath))}-${label}.db`)
  if (existsSync(out)) return null
  const tmp = `${out}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
  return placeNew(tmp, out) ? out : null
}

/** Delete all but the newest `keep` upgrade copies of `dbPath`. Nothing else in backups/ is touched. */
export function prune(dbPath: string, keep = keepCount()): void {
  const dir = backupDir(dbPath)
  const name = basename(dbPath, extname(dbPath)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const upgrade = new RegExp(`^${name}-before-\\d+\\.\\d+\\.\\d+-\\d{8}\\.db$`)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => upgrade.test(f))
  } catch {
    return
  }
  const newest = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  for (const { f } of newest.slice(keep)) rmSync(join(dir, f), { force: true })
}

/** The first time this version opens the database, keep a copy of it as the last version left it,
 *  then record this version in its header. A brand-new database has nothing to keep. Never throws:
 *  a copy that fails is logged, and the upgrade goes ahead (every schema change only adds). */
export function guardUpgrade(db: Db, dbPath: string, version = VERSION): void {
  try {
    const now = versionNumber(version)
    if (!now) return
    const was = Number(db.get('PRAGMA user_version')?.user_version ?? 0)
    if (was === now) return
    const hasData = db.tables().size > 0
    if (hasData && keepCount() > 0) {
      try {
        snapshot(db, dbPath, `before-${version}-${stamp().slice(0, 8)}`)
        prune(dbPath)
      } catch (e) {
        logErr(dbPath, `backup before ${version} first opened the database\n${errText(e)}`)
      }
    }
    db.exec(`PRAGMA user_version = ${now}`)
  } catch (e) {
    logErr(dbPath, `upgrade guard\n${errText(e)}`)
  }
}
