/** Moving from tokenomics: `agentarium import` (scripts/import.ts) and the status line hand-over. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { runScript, useTemp, type Env } from './helpers.ts'

import { Db } from '../agentarium/engine/db.ts'
import * as dashboard from '../scripts/dashboard.ts'
import { envSettings, merge, translateConfig } from '../scripts/import.ts'

/** A tokenomics install as 4.x left it: its history (doggybag's table under its old name, the
 *  controller's first step called spendlens), its settings and its status line in Claude Code. */
function setup(c: Parameters<typeof useTemp>[0], { plugin = true } = {}) {
  const t = useTemp(c)
  const h = t.home
  const tk = join(h, '.tokenomics')
  const ours = join(h, '.agentarium')
  mkdirSync(tk, { recursive: true })
  dashboard.seedDemo(join(tk, 'spendlens.db'))
  const db = new Db(join(tk, 'spendlens.db'))
  try {
    db.exec('ALTER TABLE doggybag_events RENAME TO handoff_events')
    db.exec('CREATE TABLE IF NOT EXISTS controller_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session_id TEXT, run TEXT, source TEXT, step TEXT, ms REAL)')
    db.run("INSERT INTO controller_events(ts,session_id,run,source,step,ms) VALUES('2026-11-01T10:00:00+0000','s','r','claude-code','spendlens',40)")
  } finally {
    db.close()
  }
  writeFileSync(join(tk, 'config.json'), JSON.stringify({ profile: 'frugal', projects: { '~/work/api': 'quality' },
    settings: { currency: 'USD', TOKENOMICS_DIET_MAX_KB: 128 } }))
  writeFileSync(join(tk, 'statusline.json'), JSON.stringify({ theme: 'light', currency: 'USD' }))
  writeFileSync(join(tk, 'statusline.mts'), '// tokenomics\'s status line\n')
  const settings = join(h, '.claude', 'settings.json')
  mkdirSync(join(h, '.claude'), { recursive: true })
  writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: `"node" "${join(tk, 'statusline.mts')}"` },
    env: { TOKENOMICS_BUDGET_DAILY: '20', TOKENOMICS_HOME: tk },
    enabledPlugins: plugin ? { 'tokenomics@tokenomics': true, 'agentarium@agentarium': true } : { 'agentarium@agentarium': true },
  }))
  const env: Env = t.env({ AGENTARIUM_HOME: ours, CLAUDE_CONFIG_DIR: join(h, '.claude'), COPILOT_HOME: join(h, '.copilot') })
  delete env.AGENTARIUM_DB                                        // the data folder decides, as for a user
  const run = (script: string, args: string[], extra: Env = {}) => {
    const p = runScript(script, args, { input: '{}', env: { ...env, ...extra } })
    assert.equal(p.status, 0, p.stderr)
    return p.stdout
  }
  const rows = (sql: string) => {
    const d = new Db(join(ours, 'till.db'), { readOnly: true })
    try {
      return d.all(sql)
    } finally {
      d.close()
    }
  }
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  /** Every file in tokenomics's folder, hashed: the import must leave all of them as they were. */
  const snapshot = () => Object.fromEntries(readdirSync(tk).map((f) => [f, createHash('sha1').update(readFileSync(join(tk, f))).digest('hex')]))
  return { t, h, tk, ours, settings, env, run, rows, json, snapshot }
}

describe('agentarium import', () => {
  test('brings the history, settings and status line over, and leaves tokenomics as it was', (c) => {
    const { tk, ours, settings, run, rows, json, snapshot } = setup(c)
    const before = snapshot()
    const sessions = (() => {
      const d = new Db(join(tk, 'spendlens.db'), { readOnly: true })
      try {
        return Number(d.get('SELECT COUNT(*) AS n FROM sessions')!.n)
      } finally {
        d.close()
      }
    })()

    const dry = run('import.ts', ['--dry-run'])
    assert.ok(dry.startsWith('Would bring over'), dry)
    assert.ok(!existsSync(ours), 'a dry run writes nothing')

    const out = run('import.ts', [])
    assert.ok(out.includes(`history: ${sessions} sessions`), out)
    assert.ok(out.includes('tokenomics is still installed'), out)
    assert.deepEqual(snapshot(), before, "tokenomics's files are untouched")

    // the history, with doggybag's table and the controller's first step under their new names
    assert.equal(Number(rows('SELECT COUNT(*) AS n FROM sessions')[0].n), sessions)
    const tables = rows("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
    assert.ok(tables.includes('doggybag_events') && !tables.includes('handoff_events'), tables.join(' '))
    assert.ok(Number(rows('SELECT COUNT(*) AS n FROM doggybag_events')[0].n) > 0)
    assert.deepEqual(rows('SELECT DISTINCT step FROM controller_events').map((r) => r.step), ['till'])

    // the settings: tokenomics's file in agentarium's terms, plus what Claude Code's env set
    const cfg = json(join(ours, 'config.json'))
    assert.equal(cfg.profile, 'frugal')
    assert.deepEqual(cfg.projects, { '~/work/api': 'quality' })
    assert.deepEqual(cfg.settings, { currency: 'USD', AGENTARIUM_DIET_MAX_KB: 128, budget_daily: '20' })   // not TOKENOMICS_HOME
    assert.equal(json(join(ours, 'statusline.json')).theme, 'light')

    // the status line runs agentarium's copy now
    assert.ok(json(settings).statusLine.command.includes(join(ours, 'statusline.mts')))
    assert.ok(existsSync(join(ours, 'statusline.mts')))

    // and the hooks read what came over: today's budget is the imported one
    assert.ok(run('cli.ts', ['profile']).includes('AGENTARIUM_BUDGET_DAILY'))

    // again: nothing new, and the first record stands
    const record = readFileSync(join(ours, 'tokenomics-import.json'), 'utf8')
    const again = run('import.ts', [])
    assert.ok(again.startsWith('Nothing new to bring over'), again)
    assert.ok(again.includes('nothing new since the last import'), again)
    assert.equal(readFileSync(join(ours, 'tokenomics-import.json'), 'utf8'), record)
  })

  test("agentarium's own history stays: tokenomics's goes in beside it, oldest first, and the file is never replaced", (c) => {
    const { tk, ours, env, run, rows } = setup(c, { plugin: false })
    // agentarium recorded a session of its own first: a session row and its cost and prompt events
    const p = runScript('till.ts', ['prompt', 'claude-code'], { input: JSON.stringify({ session_id: 'mine', cwd: '/x', prompt: 'fix the login bug' }), env })
    assert.equal(p.status, 0, p.stderr)
    const db = join(ours, 'till.db')
    const inode = statSync(db).ino
    const mine = rows("SELECT * FROM prompt_events WHERE session_id='mine'")
    const theirs = (sql: string) => {
      const d = new Db(join(tk, 'spendlens.db'), { readOnly: true })
      try {
        return d.all(sql)
      } finally {
        d.close()
      }
    }
    const sessions = Number(theirs('SELECT COUNT(*) AS n FROM sessions')[0].n)
    const events = theirs('SELECT session_id, ts FROM prompt_events ORDER BY id')

    const out = run('import.ts', [])
    assert.ok(out.includes(`history: ${sessions} sessions added`), out)
    assert.ok(out.includes("agentarium's own 1 session kept"), out)
    assert.equal(statSync(db).ino, inode, 'the same file: added to, never replaced')
    assert.equal(Number(rows('SELECT COUNT(*) AS n FROM sessions')[0].n), sessions + 1)
    // agentarium's own rows are all there, unchanged but for their ids, and still the newest
    const after = rows("SELECT * FROM prompt_events WHERE session_id='mine'")
    assert.deepEqual(after.map(({ id: _, ...r }) => r), mine.map(({ id: _, ...r }) => r))
    assert.equal(Number(rows('SELECT MAX(id) AS m FROM prompt_events')[0].m), Number(after.at(-1)!.id))
    // tokenomics's events in their own order, ahead of agentarium's
    assert.deepEqual(rows(`SELECT session_id, ts FROM prompt_events WHERE session_id != 'mine' ORDER BY id`).map((r) => ({ ...r })),
      events.map((r) => ({ ...r })))
    // a copy of till.db as it was before
    const backups = readdirSync(join(ours, 'backups'))
    assert.ok(backups.some((f) => /^till-before-import-\d{8}-\d{6}\.db$/.test(f)), backups.join(' '))
    // and new events after it carry on from the top
    const again = runScript('till.ts', ['prompt', 'claude-code'], { input: JSON.stringify({ session_id: 'mine', cwd: '/x', prompt: 'and the tests' }), env })
    assert.equal(again.status, 0, again.stderr)
    assert.equal(rows('SELECT session_id FROM prompt_events ORDER BY id DESC LIMIT 1')[0].session_id, 'mine')

    // again: nothing is added twice
    const count = Number(rows('SELECT COUNT(*) AS n FROM prompt_events')[0].n)
    assert.ok(run('import.ts', []).includes('nothing new since the last import'))
    assert.equal(Number(rows('SELECT COUNT(*) AS n FROM prompt_events')[0].n), count)
  })

  test('setup brings it over by itself, the first time only', { skip: process.platform === 'win32' && 'uses a shell-script stand-in for claude' }, (c) => {
    const { h, ours, env } = setup(c)
    const fakebin = join(h, 'fakebin')
    mkdirSync(fakebin)
    writeFileSync(join(fakebin, 'claude'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(fakebin, 'claude'), 0o755)
    const e: Env = { ...env, SHELL: '/bin/bash', PATH: `${fakebin}:/usr/bin:/bin` }
    const first = runScript('cli.ts', ['setup'], { env: e, timeout: 60_000 })
    assert.equal(first.status, 0, first.stderr)
    assert.ok(first.stdout.includes('Brought over from'), first.stdout)
    assert.ok(existsSync(join(ours, 'till.db')))
    const second = runScript('cli.ts', ['setup'], { env: e, timeout: 60_000 })
    assert.equal(second.status, 0, second.stderr)
    assert.ok(!second.stdout.includes('Brought over'), second.stdout)
  })

  test('no tokenomics install: nothing to do', (c) => {
    const t = useTemp(c)
    const env = t.env({ AGENTARIUM_HOME: join(t.home, '.agentarium'), CLAUDE_CONFIG_DIR: join(t.home, '.claude') })
    const p = runScript('import.ts', [], { env })
    assert.equal(p.status, 0, p.stderr)
    assert.ok(p.stdout.includes('No tokenomics install'), p.stdout)
    assert.ok(!existsSync(join(t.home, '.agentarium')))
  })

  test('settings merge key by key, and agentarium keeps its own values', () => {
    assert.deepEqual(translateConfig({ profile: 'quality', settings: { TOKENOMICS_DIET: 'warn', budget_daily: 5 } }),
      { profile: 'quality', settings: { AGENTARIUM_DIET: 'warn', budget_daily: 5 } })
    const { merged, added } = merge({ profile: 'balanced', settings: { currency: 'EUR' } },
      { profile: 'frugal', projects: { '~/a': 'quality' }, settings: { currency: 'USD', budget_daily: 5 } })
    assert.deepEqual(merged, { profile: 'balanced', projects: { '~/a': 'quality' }, settings: { currency: 'EUR', budget_daily: 5 } })
    assert.equal(added, 2)
    // a setting spelled the other way is still the same setting: agentarium's value stays the only one
    assert.deepEqual(merge({ settings: { budget_daily: 5 } }, translateConfig({ settings: { TOKENOMICS_BUDGET_DAILY: 20, TOKENOMICS_DIET: 'warn' } })).merged,
      { settings: { budget_daily: 5, AGENTARIUM_DIET: 'warn' } })
  })

  test("TOKENOMICS_ settings come from the shell and Claude Code's env; where tokenomics lives does not", (c) => {
    const t = useTemp(c)
    const claude = join(t.home, 'settings.json')
    writeFileSync(claude, JSON.stringify({ env: { TOKENOMICS_CURRENCY: 'EUR', TOKENOMICS_DB: '/x/spendlens.db' } }))
    assert.deepEqual(envSettings({ TOKENOMICS_CURRENCY: 'USD', TOKENOMICS_BUDGET_SESSION: '2', TOKENOMICS_HOME: '/x', TOKENOMICS_REPO: 'a/b' }, claude),
      { CURRENCY: 'EUR', BUDGET_SESSION: '2' })                   // Claude Code's env wins, as in its hooks
  })
})

describe('the status line hand-over from tokenomics', () => {
  test("a session start moves tokenomics's status line to agentarium's and says once what is left", (c) => {
    const { h, tk, ours, settings, run, json } = setup(c)
    const copilot = join(h, '.copilot', 'settings.json')
    mkdirSync(join(h, '.copilot'), { recursive: true })
    writeFileSync(copilot, JSON.stringify({ statusLine: { type: 'command', command: `"node" "${join(tk, 'statusline.mts')}"` },
      feature_flags: { enabled: ['STATUS_LINE'] } }))
    assert.ok(run('statusline.ts', ['--status']).includes("claude status line: tokenomics's copy"))

    const msg = JSON.parse(run('statusline.ts', ['--sync'])).systemMessage as string
    for (const path of [settings, copilot]) assert.ok(json(path).statusLine.command.includes(join(ours, 'statusline.mts')), path)
    assert.ok(msg.startsWith('agentarium, moving from tokenomics:'), msg)
    assert.ok(msg.includes("The status line is agentarium's now."), msg)
    assert.ok(msg.includes('/plugin uninstall tokenomics@tokenomics'), msg)
    assert.ok(msg.includes('`agentarium import` brings it over'), msg)
    assert.ok(readFileSync(join(tk, 'statusline.mts'), 'utf8').includes("tokenomics's status line"), "tokenomics's copy is left alone")

    assert.equal(run('statusline.ts', ['--sync']), '', 'said once')
  })

  test("--keep-existing replaces tokenomics's status line: it is an older copy of this one", (c) => {
    const { ours, settings, run, json } = setup(c)
    assert.ok(!run('statusline.ts', ['--install', 'claude', '--keep-existing']).includes('Skipped'))
    assert.ok(json(settings).statusLine.command.includes(join(ours, 'statusline.mts')))
  })

  test('after an import, the session start no longer offers one', (c) => {
    const { run } = setup(c, { plugin: false })
    run('import.ts', [])
    assert.equal(run('statusline.ts', ['--sync']), '')
  })
})
