#!/usr/bin/env node
/**
 * agentarium / dashboard: a local web UI over the till SQLite database.
 *
 *   node scripts/dashboard.ts                 # serve http://127.0.0.1:8765
 *   node scripts/dashboard.ts --port 9000 --db /path/to/till.db
 *   node scripts/dashboard.ts --demo          # seeded fake data, to preview the UI
 *   node scripts/dashboard.ts --background    # start it in the background and return
 *   node scripts/dashboard.ts --stop          # stop a background dashboard
 *   node scripts/dashboard.ts --copilot       # open /copilot in a small window instead:
 *                                             # Copilot's premium requests, for the Copilot app
 *
 * The window is for apps with no status line or mods (the GitHub Copilot app): a chromeless
 * Chrome or Edge window (--app) to keep beside it, else a browser tab. Its numbers are
 * statusline.ts's (copilotStatus), so it shows what VS Code's status bar and the CLI show.
 *
 * Shows tokens, sessions, prompts and spend (estimated, token-billed sessions only: Copilot's
 * premium requests are never priced) split OPEX / CAPEX by day and project, and what agentarium
 * did: what pennywise and each guard stopped or flagged and what that saved (PolicyEngine.activity).
 * Money is in the display currency (AGENTARIUM_CURRENCY or the statusline's saved choice).
 *
 * Read-only: the DB is opened read-only and never written to (except --demo, which uses a
 * temp file). Binds to 127.0.0.1 only.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDbPath } from '../agentarium/config.ts'
import * as budget from '../agentarium/engine/budget.ts'
import * as contract from '../agentarium/engine/contract.ts'
import * as currency from '../agentarium/engine/currency.ts'
import { withDb, type Row } from '../agentarium/engine/db.ts'
import * as events from '../agentarium/engine/events.ts'
import * as store from '../agentarium/engine/store.ts'
import { PolicyEngine } from '../agentarium/services/index.ts'
import { ensureHandoffs } from './doggybag.ts'
import { ensureLog as ensurePennywiseLog } from './pennywise.ts'
import { copilotStatus } from './statusline.ts'
import { argValue, isMain, today, type Obj } from '../agentarium/util.ts'

const HERE = import.meta.dirname
const INDEX = join(HERE, '..', 'dashboard', 'index.html')
const COPILOT = join(HERE, '..', 'dashboard', 'copilot.html')
const LABELS = ['opex', 'capex', 'mixed', 'unknown'] as const

const zero = () => ({ sessions: 0, prompts: 0, tokens: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, spend: 0 })
const byLabel = () => Object.fromEntries(LABELS.map((k) => [k, zero()])) as Record<string, ReturnType<typeof zero>>

function add(acc: ReturnType<typeof zero>, r: Row): void {
  const inp = r.input_tokens || 0
  const out = r.output_tokens || 0
  acc.sessions += 1
  acc.prompts += r.prompt_count || 0
  acc.tokens += inp + out
  acc.input += inp
  acc.output += out
  acc.cache_read += r.cache_read_tokens || 0
  acc.cache_creation += r.cache_creation_tokens || 0
}

function shiftDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** A path under the home folder as ~/...: shorter, and a screenshot of the page doesn't show your username. */
export function tilde(path: string, home = homedir()): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

export function build(dbPath: string, days: number): Obj {
  if (!(existsSync(dbPath) && statSync(dbPath).isFile())) return { empty: true, db_path: tilde(dbPath), reason: 'no-database' }
  const cutoff = days ? today(shiftDays(new Date(), -(days - 1))) : null
  const since = cutoff ?? '0000-00-00'
  const got = withDb(dbPath, (db) => {
    const cols = db.columns('sessions')
    if (!cols.size) return null
    const want = ['session_id', 'source', 'cwd', 'label', 'prompt_count', 'first_seen', 'updated_at',
      'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'skills', 'skill_detail']
    const rows = db.all(`SELECT ${want.map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ')} FROM sessions ORDER BY first_seen`)
    // cost_events are dated increments, so a long session's spend lands on the days it was spent
    const costs = db.tables().has('cost_events')
      ? db.all('SELECT session_id, day, SUM(usd) AS usd FROM cost_events WHERE day >= ? GROUP BY session_id, day', since) : []
    return { rows, costs, activity: PolicyEngine.activity(db, since) }
  }, { readOnly: true })                               // the server is long-running: never leak handles
  if (got === null) return { empty: true, db_path: tilde(dbPath), reason: 'no-table' }
  const { costs, activity } = got
  const bySid = new Map(got.rows.map((r) => [r.session_id, r]))
  const rows = got.rows.filter((r) => !cutoff || String(r.first_seen || '').slice(0, 10) >= cutoff)

  const totals = byLabel()
  const daily = new Map<string, ReturnType<typeof byLabel>>()
  const projects = new Map<string, ReturnType<typeof byLabel>>()
  const skills = new Map<string, { name: string, side: string | null, sessions: number }>()
  const sources: Record<string, number> = {}
  for (const r of rows) {
    const lab = (LABELS as readonly string[]).includes(r.label) ? r.label : 'unknown'
    add(totals[lab], r)
    const day = String(r.first_seen || '').slice(0, 10) || 'unknown'
    if (!daily.has(day)) daily.set(day, byLabel())
    add(daily.get(day)![lab], r)
    const proj = String(r.cwd || 'unknown').replace(/[/\\]+$/, '')
    if (!projects.has(proj)) projects.set(proj, byLabel())
    add(projects.get(proj)![lab], r)
    const src = r.source || 'unknown'
    sources[src] = (sources[src] ?? 0) + 1
    let detail: Obj[] = []
    try {
      detail = r.skill_detail ? JSON.parse(r.skill_detail) : []
    } catch {
      detail = []
    }
    for (const s of Array.isArray(detail) ? detail : []) {
      const k = s?.name
      if (!k) continue
      if (!skills.has(k)) skills.set(k, { name: k, side: s.side ?? null, sessions: 0 })
      skills.get(k)!.sessions += 1
    }
  }
  const sessionSpend = new Map<string, number>()
  let spendUsd = 0
  for (const c of costs) {
    const usd = Number(c.usd) || 0
    if (!usd) continue
    const s = bySid.get(c.session_id)
    const lab = s && (LABELS as readonly string[]).includes(s.label) ? s.label : 'unknown'
    const day = String(c.day || '') || 'unknown'
    const proj = String(s?.cwd || 'unknown').replace(/[/\\]+$/, '')
    if (!daily.has(day)) daily.set(day, byLabel())
    if (!projects.has(proj)) projects.set(proj, byLabel())
    totals[lab].spend += usd
    daily.get(day)![lab].spend += usd
    projects.get(proj)![lab].spend += usd
    sessionSpend.set(c.session_id, (sessionSpend.get(c.session_id) ?? 0) + usd)
    spendUsd += usd
  }

  // dense daily series so quiet days show as gaps, not as missing bars
  const series: Obj[] = []
  const dated = [...daily.keys()].filter((d) => d !== 'unknown').sort()
  if (cutoff || dated.length) {
    const startKey = cutoff || dated[0]
    const [y, mo, d] = startKey.split('-').map(Number)
    const end = today()
    for (let day = new Date(y, mo - 1, d); today(day) <= end; day = shiftDays(day, 1)) {
      const key = today(day)
      series.push({ date: key, ...(daily.get(key) ?? byLabel()) })
    }
  }

  const recent = [...rows].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 12)
    .map((r) => ({ session_id: r.session_id, source: r.source, cwd: r.cwd, label: r.label, prompts: r.prompt_count || 0,
      tokens: (r.input_tokens || 0) + (r.output_tokens || 0), spend: sessionSpend.get(r.session_id) ?? 0, updated_at: r.updated_at }))
  const [code, symbol, rate] = currency.current()
  return {
    empty: !rows.length && !spendUsd && !activity.stepped_in, reason: rows.length || spendUsd || activity.stepped_in ? null : 'no-rows',
    db_path: tilde(dbPath), days,
    generated: new Date().toISOString(),
    money: { code, symbol, rate },
    spend_usd: spendUsd,
    activity,
    totals, daily: series, projects: [...projects].map(([cwd, by]) => ({ cwd, by })),
    skills: [...skills.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    sources, recent,
  }
}

/** A small seeded PRNG, so the demo data is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = (mu: number, sigma: number) => mu + sigma * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  return {
    random: next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    choice: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    uniform: (a: number, b: number) => a + (b - a) * next(),
    gauss,
    lognorm: (mu: number, sigma: number) => Math.exp(gauss(mu, sigma)),
  }
}

export function seedDemo(path: string): void {
  const db = store.connect(path)
  const rnd = rng(7)
  const projects = ['/work/payments-api', '/work/platform-infra', '/work/web-app', '/work/observability', '/work/data-pipeline']
  const bias: Record<string, number> = { '/work/payments-api': 0.25, '/work/platform-infra': 0.7, '/work/web-app': 0.1,
    '/work/observability': 0.92, '/work/data-pipeline': 0.35 }
  const skills: [string, string][] = [['grafana-triage', 'opex'], ['incident-review', 'opex'], ['loki-queries', 'opex'],
    ['frontend-design', 'capex'], ['unit-tests', 'capex'], ['skill-creator', 'capex']]
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = (ts: Date) => `${today(ts)}T${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}+0000`
  const seeded: { sid: string, ts: Date, source: string, cwd: string, prompts: number, ctx: number, usd: number }[] = []
  try {
    db.transaction(() => { for (let i = 0; i < 190; i++) {
      let age = Math.floor(Math.abs(rnd.gauss(0, 24)))
      if (age > 59) age = rnd.int(0, 59)
      const ts = new Date(now.getTime() - ((age * 24 + rnd.int(0, 9)) * 60 + rnd.int(0, 59)) * 60_000)
      if ((ts.getDay() === 0 || ts.getDay() === 6) && rnd.random() < 0.7) continue
      const proj = rnd.choice(projects)
      let side = rnd.random() < bias[proj] ? 'opex' : 'capex'
      if (rnd.random() < 0.12) side = 'mixed'
      if (rnd.random() < 0.05) side = 'unknown'
      const inp = Math.floor(rnd.lognorm(10.4, 0.8))
      let out = Math.floor(inp * rnd.uniform(0.15, 0.6))
      if (side === 'capex') out = Math.floor(out * 1.8)
      const cr = Math.floor(inp * rnd.uniform(6, 40))
      const cc = Math.floor(inp * rnd.uniform(0.6, 2.5))
      const sk = skills.filter((s) => s[1] === side && rnd.random() < 0.35).slice(0, 2)
      const detail = sk.map(([n, sd]) => ({ name: n, side: sd, basis: 'name', description: '' }))
      const when = stamp(ts)
      const sid = `demo-${String(i).padStart(4, '0')}`
      const source = rnd.choice(['claude-code', 'claude-code', 'claude-code', 'claude-code', 'copilot'])
      const prompts = rnd.int(2, 40)
      db.run(`INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,
              first_seen,updated_at,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
              total_tokens,skills,skill_opex,skill_capex,skill_detail)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sid, source, proj, side, rnd.int(0, 30), rnd.int(0, 30), prompts, when, when, inp, out, cc, cr, inp + out + cc + cr,
      JSON.stringify(sk.map(([n]) => n)), sk.filter(([, sd]) => sd === 'opex').length,
      sk.filter(([, sd]) => sd === 'capex').length, JSON.stringify(detail))
      // Sonnet list prices per million: input 3, output 15, cache write 3.75, cache read 0.30.
      // Copilot bills premium requests, so its sessions get no cost_events.
      const usd = source === 'copilot' ? 0 : (inp * 3 + out * 15 + cc * 3.75 + cr * 0.3) / 1e6
      if (usd) db.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', sid, when, today(ts), usd)
      seeded.push({ sid, ts, source, cwd: proj, prompts, ctx: inp + cc, usd })
    } })
    seedActivity(db, seeded, stamp)
  } finally {
    db.close()
  }
}

/** What pennywise and the guards would have logged in those sessions, so the demo shows "What agentarium did". */
function seedActivity(db: store.Db, sessions: { sid: string, ts: Date, source: string, cwd: string, prompts: number, ctx: number, usd: number }[],
  stamp: (ts: Date) => string): void {
  const rnd = rng(11)
  const sieve = rng(23)          // its own stream, so the other helpers' demo numbers don't move
  for (const t of ['diet_events', 'groundhog_events', 'blinkers_events', 'ballast_events', 'cachebuster_events', 'toomanycooks_events',
    'kettle_events', 'parrot_events', 'colander_events', 'holdup_events']) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t}(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ${events.TABLES[t]})`)
  }
  ensurePennywiseLog(db)
  contract.ensure(db)
  ensureHandoffs(db)
  budget.ensure(db)
  const later = (s: { ts: Date }, mins: number) => new Date(s.ts.getTime() + mins * 60_000)
  const ins = (table: string, fields: Record<string, string | number | null>) => {
    const cols = Object.keys(fields)
    db.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...Object.values(fields))
  }
  db.transaction(() => {
    for (const s of sessions) {
      const at = (mins: number) => stamp(later(s, mins))
      const base = { session_id: s.sid, source: s.source }
      if (s.source === 'claude-code') {
        // about a third of prompts suit a cheaper model; pennywise routes the ones where the saving beats the hand-off
        for (let k = 0, n = Math.floor(s.prompts * rnd.uniform(0.1, 0.35)); k < n; k++) {
          ins('pennywise_events', { session_id: s.sid, ts: at(k * 3), model: 'claude-opus-5-5', suggested: 'Haiku', reason: 'SIMPLE',
            action: 'routed', saved_usd: rnd.uniform(0.004, 0.05), tier: 'SIMPLE', project: s.cwd.split('/').pop() ?? null })
        }
        if (rnd.random() < 0.15) {
          ins('pennywise_events', { session_id: s.sid, ts: at(5), model: 'claude-haiku-5-5', suggested: 'Opus', reason: 'REASONING',
            action: 'routed-up', saved_usd: -rnd.uniform(0.03, 0.12), tier: 'REASONING', project: s.cwd.split('/').pop() ?? null })
        }
        if (rnd.random() < 0.06) {
          ins('cachebuster_events', { ...base, ts: at(20), tool: 'Edit', kind: 'instructions', path: 'CLAUDE.md', ctx_tokens: s.ctx,
            usd: rnd.uniform(0.15, 0.7), action: rnd.random() < 0.5 ? 'deny' : 'warn' })
        }
        if (rnd.random() < 0.05) {
          ins('toomanycooks_events', { ...base, ts: at(12), rule: rnd.choice(['overlap', 'lookup', 'fan_out']), agent: 'general-purpose',
            est_usd: rnd.uniform(0.08, 0.35), action: 'warn' })
        }
        if (rnd.random() < 0.12) {
          ins('ballast_events', { ...base, ts: at(30), rule: 'new_task', ctx_tokens: rnd.int(60_000, 180_000), step_usd: rnd.uniform(0.01, 0.04),
            band: 1, action: 'warn' })
        }
        if (rnd.random() < 0.04) {
          ins('holdup_events', { ...base, ts: at(2), kind: rnd.choice(['log', 'log', 'data', 'doc', 'code', 'paste']), est_tokens: rnd.int(12_000, 90_000),
            lines: rnd.int(800, 6_000), usd: rnd.uniform(0.1, 0.9), prompt_sha: null, action: 'block' })
        }
        if (rnd.random() < 0.35) {
          ins('kettle_events', { ...base, ts: at(40), ctx_tokens: s.ctx, at_risk_usd: rnd.uniform(0.04, 0.6), seconds_left: 200, action: 'told:3' })
        }
        // a test run or a build that passed, strained before the model read it
        for (let k = 0, n = sieve.int(0, 4); k < n; k++) {
          const raw = sieve.int(4_000, 20_000)
          const kept = Math.round(raw * sieve.uniform(0.02, 0.12))
          ins('colander_events', { ...base, ts: at(10 + k * 7), tool: 'Bash', program: sieve.choice(['npm', 'pytest', 'cargo', 'go']),
            raw_tokens: raw, kept_tokens: kept, saved_usd: (raw - kept) * 3.75 / 1e6, action: 'strained' })
        }
        if (rnd.random() < 0.22) {
          ins('doggybag_events', { session_id: s.sid, ts: at(45), reason: 'cache-expiry', ttl: 300, context_tokens: rnd.int(50_000, 200_000),
            handoff_tokens: rnd.int(800, 2_500), path: '.doggybag/latest.md' })
        }
      }
      if (rnd.random() < 0.16) {
        ins('diet_events', { ...base, ts: at(8), tool: rnd.choice(['Read', 'Bash']),
          rule: rnd.choice(['generated-file', 'unbounded-logs', 'large-cat', 'unbounded-git-log', 'recursive-listing']),
          est_tokens: rnd.int(20_000, 180_000), action: 'denied' })
      }
      if (rnd.random() < 0.07) {
        ins('groundhog_events', { ...base, ts: at(25), tool: 'Bash', rule: 'failing_command', loop_key: `fail:${s.sid}`,
          action: rnd.random() < 0.7 ? 'denied' : 'warned', detail: null })
      }
      if (rnd.random() < 0.08) {
        ins('blinkers_events', { ...base, ts: at(18), tool: 'Write', rule: 'docs', path: 'README.md', action: rnd.random() < 0.6 ? 'asked' : 'warned' })
      }
    }
    const recent = sessions.filter((s) => s.source === 'claude-code').sort((a, b) => b.ts.getTime() - a.ts.getTime())
    for (const [i, s] of recent.slice(0, 6).entries()) {
      const spent = s.usd * rnd.uniform(0.6, 1.3)
      const cap = i === 0 ? spent * 0.95 : spent * 1.6
      ins('contracts', { session_id: s.sid, ts: stamp(s.ts), day: today(s.ts), tier: 'COMPLEX', est_low: spent * 0.5, est_mid: spent,
        est_high: spent * 2, target_usd: spent, cap_usd: cap, explicit: 1, spent_usd: spent, status: 'closed' })
    }
    for (const [i, s] of recent.slice(2, 5).entries()) {
      ins('budget_events', { session_id: s.sid, ts: stamp(s.ts), day: today(s.ts), kind: 'daily', action: i === 0 ? 'blocked' : 'warned',
        spent: 16 + i, limit_amount: 20, currency: 'GBP', digest: null })
    }
    for (const s of recent.slice(1, 4)) {
      ins('parrot_events', { session_id: s.sid, ts: stamp(s.ts), source: s.source, project: s.cwd, key: s.sid, kind: 'rule', action: 'nudged' })
    }
  })
}

export function serve(dbPath: string, port: number, onListening?: () => void) {
  const srv = createServer((req, res) => {
    const send = (code: number, body: string | Buffer, ctype: string) => {
      const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
      res.writeHead(code, { 'Content-Type': ctype, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
      res.end(data)
    }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET') return send(405, 'method not allowed', 'text/plain')
    if (u.pathname === '/' || u.pathname === '/index.html') {
      try {
        send(200, readFileSync(INDEX), 'text/html; charset=utf-8')
      } catch {
        send(500, 'dashboard/index.html is missing', 'text/plain')
      }
    } else if (u.pathname === '/copilot') {
      try {
        send(200, readFileSync(COPILOT), 'text/html; charset=utf-8')
      } catch {
        send(500, 'dashboard/copilot.html is missing', 'text/plain')
      }
    } else if (u.pathname === '/api/copilot') {
      try {
        send(200, JSON.stringify(copilotStatus()), 'application/json')
      } catch (e) {
        send(500, JSON.stringify({ error: String(e instanceof Error ? e.message : e) }), 'application/json')
      }
    } else if (u.pathname === '/api/data') {
      try {
        const n = Number.parseInt(u.searchParams.get('days') ?? '30', 10)
        const days = Math.max(0, Math.min(Number.isNaN(n) ? 30 : n, 3650))
        send(200, JSON.stringify(build(dbPath, days)), 'application/json')
      } catch (e) {                                 // never crash the server on a bad DB
        send(500, JSON.stringify({ error: String(e instanceof Error ? e.message : e) }), 'application/json')
      }
    } else {
      send(404, 'not found', 'text/plain')
    }
  })
  srv.listen(port, '127.0.0.1', onListening)
  return srv
}

const PID_FILE = join(process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium'), 'dashboard.pid')

export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port })
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(300, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) return
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {
    // no browser: the URL is printed anyway
  }
}

// Chromium browsers that open a page as a bare window (--app), per platform, best first.
const APP_BROWSERS: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  win32: [join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')],
  linux: ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
}

/** A page in a small window of its own (Chrome or Edge --app), else a browser tab. */
function openWindow(url: string, noOpen: boolean): void {
  if (noOpen) return
  const exe = (APP_BROWSERS[process.platform] ?? []).find((p) => p && existsSync(p))
  if (!exe) return openBrowser(url, false)
  try {
    spawn(exe, [`--app=${url}`, '--window-size=560,170'], { stdio: 'ignore', detached: true }).on('error', () => openBrowser(url, false)).unref()
  } catch {
    openBrowser(url, false)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start the server as a detached process, wait until it answers, open the browser, return. */
async function background(port: number, demo: boolean, noOpen: boolean, argv: string[]): Promise<number> {
  const win = argv.includes('--copilot')
  const url = `http://127.0.0.1:${port}/${win ? 'copilot' : ''}`
  const show = () => (win ? openWindow(url, noOpen) : openBrowser(url, noOpen))
  if (await portBusy(port)) {
    process.stdout.write(`agentarium ${win ? 'Copilot window' : 'dashboard'} is already running on ${url}\n`)
    show()
    return 0
  }
  const args = [...argv.filter((x) => x !== '--background'), '--no-open']
  mkdirSync(join(PID_FILE, '..'), { recursive: true })
  const logPath = join(PID_FILE, '..', 'dashboard.log')
  const log = openSync(logPath, 'a')
  const proc = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args],
    { stdio: ['ignore', log, log], detached: true, windowsHide: true })
  closeSync(log)
  let exited = false
  proc.on('exit', () => { exited = true })
  proc.unref()
  writeFileSync(PID_FILE, String(proc.pid), 'utf8')
  const deadline = Date.now() + 20_000                   // a cold start on a busy Mac can be slow
  while (!(await portBusy(port))) {
    if (exited || Date.now() > deadline) {
      let tail = ''
      try {
        tail = readFileSync(logPath, 'utf8').slice(-2000)
      } catch {
        // no log
      }
      process.stderr.write(`The dashboard didn't start (see ${logPath}).\n${tail}\n`)
      return 1
    }
    await sleep(100)
  }
  process.stdout.write(`agentarium ${win ? 'Copilot window' : 'dashboard'} running on ${url}${demo ? '  (demo data)' : ''}\n` +
    `  stop it with: agentarium ${win ? 'copilot --window' : 'dashboard'} --stop\n`)
  show()
  return 0
}

function stop(): number {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (Number.isNaN(pid)) throw new Error('bad pid')
  } catch {
    process.stdout.write('No background dashboard is running.\n')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
    process.stdout.write(`Stopped the dashboard (pid ${pid}).\n`)
  } catch {
    process.stdout.write('No background dashboard is running.\n')
  }
  try {
    unlinkSync(PID_FILE)
  } catch {
    // already gone
  }
  return 0
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write('usage: dashboard.ts [--db PATH] [--port N] [--demo] [--no-open] [--background] [--stop] [--copilot]\n')
    return 0
  }
  const port = Number.parseInt(argValue(argv, '--port') ?? '8765', 10)
  const demo = argv.includes('--demo')
  const noOpen = argv.includes('--no-open')
  if (argv.includes('--stop')) return stop()
  if (argv.includes('--background')) return background(port, demo, noOpen, argv)
  let dbPath = argValue(argv, '--db') ?? defaultDbPath()
  if (demo) {
    dbPath = join(mkdtempSync(join(tmpdir(), 'agentarium-demo-')), 'till.db')
    seedDemo(dbPath)
  }
  const win = argv.includes('--copilot')
  const url = `http://127.0.0.1:${port}/${win ? 'copilot' : ''}`
  process.env.AGENTARIUM_DB = dbPath                    // the Copilot window reads the same database as the dashboard
  serve(dbPath, port, () => {
    process.stdout.write(`agentarium dashboard on ${url}\n  db: ${dbPath}${demo ? '  (demo data)' : ''}\n  Ctrl+C to stop\n`)
    if (win) openWindow(url, noOpen)
    else openBrowser(url, noOpen)
  }).on('error', (e) => {
    process.stderr.write(`agentarium dashboard: ${e.message}\n`)
    process.exitCode = 1
  })
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
