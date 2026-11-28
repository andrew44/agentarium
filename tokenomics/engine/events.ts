/** Small append-only event tables for the guard hooks (diet, sherlock, groundhog, ...). Never throws. */
import { errText, logErr, now } from '../util.ts'
import { withDb } from './db.ts'

export const TABLES: Record<string, string> = {
  diet_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, est_tokens INTEGER, action TEXT',
  sherlock_events: 'session_id TEXT, wasted_usd REAL, session_usd REAL, findings INTEGER, top_kind TEXT',
  groundhog_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, loop_key TEXT, action TEXT, detail TEXT',
  blinkers_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, path TEXT, action TEXT',
  ballast_events: 'session_id TEXT, source TEXT, rule TEXT, ctx_tokens INTEGER, step_usd REAL, band INTEGER, action TEXT',
  parrot_events: 'session_id TEXT, source TEXT, project TEXT, key TEXT, kind TEXT, action TEXT',
  fishingrod_events: 'session_id TEXT, source TEXT, lesson TEXT, action TEXT',
  cachebuster_events: 'session_id TEXT, source TEXT, tool TEXT, kind TEXT, path TEXT, ctx_tokens INTEGER, usd REAL, action TEXT',
  toomanycooks_events: 'session_id TEXT, source TEXT, rule TEXT, agent TEXT, est_usd REAL, action TEXT',
  toomanycooks_agents: 'session_id TEXT, agent TEXT, model TEXT, requests INTEGER, tokens INTEGER, usd REAL',
  kettle_events: 'session_id TEXT, source TEXT, ctx_tokens INTEGER, at_risk_usd REAL, seconds_left INTEGER, action TEXT',
  diet_sizes: 'session_id TEXT, source TEXT, tool TEXT, kind TEXT, chars INTEGER, est_tokens INTEGER',
  premium_events:'session_id TEXT, source TEXT, used REAL, allowance REAL, prompt_sha TEXT, action TEXT',
  colander_events: 'session_id TEXT, source TEXT, tool TEXT, program TEXT, raw_tokens INTEGER, kept_tokens INTEGER, saved_usd REAL, action TEXT',
  holdup_events: 'session_id TEXT, source TEXT, kind TEXT, est_tokens INTEGER, lines INTEGER, usd REAL, prompt_sha TEXT, action TEXT',
}

export function log(dbPath: string, table: string, fields: Record<string, string | number | null>): void {
  try {
    withDb(dbPath, (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ${TABLES[table]})`)
      const cols = ['ts', ...Object.keys(fields)]
      db.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
        now(), ...Object.values(fields))
    })
  } catch (e) {
    logErr(dbPath, `event log failed (${table}: ${errText(e).split('\n')[0]})`)
  }
}
