/** Running the installer again, and upgrading: nothing is lost, nothing is churned, nothing that
 *  isn't agentarium's is replaced or deleted. (The real one-liners run in .github/workflows/installer.yml.) */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, parse, sep } from 'node:path'
import { describe, test } from 'node:test'

import { fakeClaude, runScript, useTemp, withEnv, type Env } from './helpers.ts'

import { guardUpgrade, keepCount, prune, snapshot, versionNumber } from '../agentarium/engine/backup.ts'
import { Db } from '../agentarium/engine/db.ts'
import { connect } from '../agentarium/engine/store.ts'
import { VERSION } from '../agentarium/index.ts'
import { download, holdsDb, isApp, unsafeToPurge } from '../scripts/cli.ts'

const POSIX = process.platform !== 'win32'

/** A home with a stand-in `claude`, the way the installer finds one, and the user's own settings. */
function machine(c: Parameters<typeof useTemp>[0], settings: object | null = { theme: 'dark', env: { MY_VAR: '1' } },
  plugin: { installed?: string, updates?: boolean } = {}) {
  const t = useTemp(c)
  const h = t.home
  const fakebin = t.mkdir('fakebin')
  const log = join(h, 'claude.log')
  fakeClaude(fakebin, log, { latest: VERSION, ...plugin })
  const env: Env = t.env({ AGENTARIUM_HOME: join(h, '.agentarium'), CLAUDE_CONFIG_DIR: join(h, '.claude'),
    COPILOT_HOME: join(h, '.copilot'), SHELL: '/bin/bash', PATH: `${fakebin}:/usr/bin:/bin` })
  const claudeSettings = join(h, '.claude', 'settings.json')
  if (settings) {
    mkdirSync(dirname(claudeSettings), { recursive: true })
    writeFileSync(claudeSettings, JSON.stringify(settings))
  }
  const cli = (...args: string[]) => {
    const p = runScript('cli.ts', args, { env, timeout: 60_000 })
    assert.equal(p.status, 0, p.stdout + p.stderr)
    return p.stdout
  }
  return { t, h, fakebin, log, env, claudeSettings, backup: `${claudeSettings}.agentarium.bak`, cli }
}

const mtime = (p: string) => statSync(p).mtimeMs

describe('running setup again', { skip: !POSIX && 'uses a shell-script stand-in for claude' }, () => {
  test("changes nothing, and the backup stays the user's settings from before agentarium", (c) => {
    const { h, claudeSettings, backup, cli } = machine(c)
    cli('setup')
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), { theme: 'dark', env: { MY_VAR: '1' } })
    const files = [claudeSettings, join(h, '.local', 'bin', 'agentarium'), join(h, '.agentarium', 'node'), join(h, '.agentarium', 'statusline.mts')]
    const before = files.map(mtime)
    const text = readFileSync(claudeSettings, 'utf8')

    spawnSync('sleep', ['0.05'])
    cli('setup')
    cli('setup')
    assert.deepEqual(files.map(mtime), before, 'nothing rewritten')
    assert.equal(readFileSync(claudeSettings, 'utf8'), text)
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), { theme: 'dark', env: { MY_VAR: '1' } })
    const rc = join(h, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')   // what bash reads
    assert.equal(readFileSync(rc, 'utf8').split('agentarium installer').length - 1, 1, 'one PATH line')
  })

  test('a settings file agentarium created is backed up as the empty one it was, so uninstall never backs up its own', (c) => {
    const { backup, cli } = machine(c, null)
    cli('setup')
    assert.equal(readFileSync(backup, 'utf8').trim(), '{}')
    cli('uninstall')
    assert.equal(readFileSync(backup, 'utf8').trim(), '{}')
  })

  test("uninstall leaves an app folder that isn't agentarium's alone", (c) => {
    const { h, cli } = machine(c)
    const notOurs = join(h, '.agentarium', 'app')
    mkdirSync(notOurs, { recursive: true })
    writeFileSync(join(notOurs, 'mine.txt'), 'keep me')
    assert.ok(cli('uninstall').includes("it isn't an agentarium install"))
    assert.equal(readFileSync(join(notOurs, 'mine.txt'), 'utf8'), 'keep me')
  })

  test('--purge refuses a data folder that holds the home folder', (c) => {
    const { h, env } = machine(c)
    writeFileSync(join(h, 'precious.txt'), 'mine')
    const p = runScript('cli.ts', ['uninstall', '--purge'], { env: { ...env, AGENTARIUM_HOME: h }, timeout: 60_000 })
    assert.equal(p.status, 1, p.stdout + p.stderr)
    assert.ok(p.stdout.includes('Not deleting'), p.stdout)
    assert.equal(readFileSync(join(h, 'precious.txt'), 'utf8'), 'mine')
  })
})

describe('running the installer ends with the latest version', { skip: !POSIX && 'uses shell-script stand-ins for claude and code' }, () => {
  test('a first run installs the plugin', (c) => {
    const { log, cli } = machine(c)
    assert.ok(cli('setup').includes(`plugin ${VERSION} installed`))
    assert.match(readFileSync(log, 'utf8'), /plugin update agentarium@agentarium\n(.*\n)*plugin install agentarium@agentarium/)
  })

  test('a re-run updates an older plugin rather than leaving it (install alone keeps the old one)', (c) => {
    const { log, cli } = machine(c, undefined, { installed: '0.0.0' })
    const out = cli('setup')
    assert.ok(out.includes(`plugin ${VERSION} installed`), out)
    const calls = readFileSync(log, 'utf8')
    assert.ok(calls.includes('plugin marketplace update agentarium'), 'the latest listing first')
    assert.ok(calls.includes('plugin update agentarium@agentarium'))
    assert.ok(!calls.includes('plugin install agentarium@agentarium'), calls)
  })

  test('says so when Claude Code still has an older one', (c) => {
    const { cli } = machine(c, undefined, { installed: '0.0.0', updates: false })
    const out = cli('setup')
    assert.ok(out.includes(`! Claude Code: plugin 0.0.0 installed, but ${VERSION} is the latest`), out)
    assert.ok(out.includes('claude plugin update agentarium@agentarium'))
  })

  test("brings VS Code's status bar item up to date, if it was added", (c) => {
    const { h, fakebin, cli } = machine(c)
    const codeLog = join(h, 'code.log')
    const listed = join(h, 'code-listed')
    writeFileSync(join(fakebin, 'code'), `#!/bin/sh\necho "$*" >> "${codeLog}"\n[ "$1" = --list-extensions ] && cat "${listed}"\nexit 0\n`)
    chmodSync(join(fakebin, 'code'), 0o755)
    writeFileSync(listed, 'ms-python.python@2026.1.0\nagentarium.agentarium-status@0.0.0\n')
    assert.ok(cli('setup').includes(`status bar item updated to ${VERSION}`))
    assert.match(readFileSync(codeLog, 'utf8'), /--install-extension .*agentarium-status\.vsix --force/)
    writeFileSync(listed, `agentarium.agentarium-status@${VERSION}\n`)
    writeFileSync(codeLog, '')
    assert.ok(!cli('setup').includes('status bar item updated'))
    assert.ok(!readFileSync(codeLog, 'utf8').includes('--install-extension'), 'already current: left as it is')
  })
})

describe('updating the app (agentarium update)', () => {
  /** Serve one tarball, as GitHub's archive URL would. */
  async function serve(c: Parameters<typeof useTemp>[0], tgz: Buffer): Promise<string> {
    const server = createServer((_q, res) => res.end(tgz))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    c.after(() => server.close())
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/archive/main.tar.gz`
  }

  /** A tarball of one top folder holding `files`, as GitHub packs a repository. */
  function tarball(dir: string, files: Record<string, string>): Buffer {
    const top = join(dir, 'pack', 'agentarium-main')
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(top, name)), { recursive: true })
      writeFileSync(join(top, name), text)
    }
    const out = join(dir, 'pack.tgz')
    assert.equal(spawnSync('tar', ['-czf', out, '-C', join(dir, 'pack'), 'agentarium-main']).status, 0)
    return readFileSync(out)
  }

  test('swaps the new copy in and touches nothing else beside it', async (c) => {
    const t = useTemp(c)
    const home = t.mkdir('.agentarium')
    const app = join(home, 'app')
    mkdirSync(join(app, 'scripts'), { recursive: true })
    writeFileSync(join(app, 'scripts', 'cli.ts'), '// old')
    writeFileSync(join(app, 'old-only.txt'), 'old')
    writeFileSync(join(home, 'till.db'), 'the recorded data')
    writeFileSync(join(home, 'config.json'), '{"profile":"frugal"}')

    await download(app, await serve(c, tarball(t.home, { 'scripts/cli.ts': '// new', 'README.md': 'new' })))
    assert.equal(readFileSync(join(app, 'scripts', 'cli.ts'), 'utf8'), '// new')
    assert.ok(!existsSync(join(app, 'old-only.txt')), 'the old copy is gone')
    assert.equal(readFileSync(join(home, 'till.db'), 'utf8'), 'the recorded data')
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{"profile":"frugal"}')
    assert.deepEqual(readdirSync(home).sort(), ['app', 'config.json', 'till.db'], 'no staging or old copies left')
  })

  test("refuses to replace a folder that isn't an agentarium app, and leaves it as it is", async (c) => {
    const t = useTemp(c)
    const app = t.mkdir('.agentarium', 'app')
    writeFileSync(join(app, 'mine.txt'), 'keep me')
    await assert.rejects(download(app, await serve(c, tarball(t.home, { 'scripts/cli.ts': '// new' }))), /isn't an agentarium install/)
    assert.equal(readFileSync(join(app, 'mine.txt'), 'utf8'), 'keep me')
    assert.ok(isApp(join(t.home, 'pack', 'agentarium-main')) && !isApp(app))
  })

  test("a download that isn't agentarium leaves the installed copy working", async (c) => {
    const t = useTemp(c)
    const app = t.mkdir('.agentarium', 'app')
    mkdirSync(join(app, 'scripts'))
    writeFileSync(join(app, 'scripts', 'cli.ts'), '// installed')
    await assert.rejects(download(app, await serve(c, tarball(t.home, { 'index.html': 'an error page' }))), /doesn't look like agentarium/)
    assert.equal(readFileSync(join(app, 'scripts', 'cli.ts'), 'utf8'), '// installed')
    assert.deepEqual(readdirSync(dirname(app)), ['app'])
  })
})

describe('an upgrade never loses the database', () => {
  const header = (path: string) => {
    const db = new Db(path, { readOnly: true })
    try {
      return Number(db.get('PRAGMA user_version')!.user_version)
    } finally {
      db.close()
    }
  }

  test('the first time a new version opens it, a copy of it as the last version left it', (c) => {
    const t = useTemp(c)
    const path = join(t.home, 'till.db')
    connect(path).close()                                       // made by this version
    assert.equal(header(path), versionNumber(VERSION))
    assert.ok(!existsSync(join(t.home, 'backups')), 'a new database has nothing to keep')

    const db = connect(path)
    db.run("INSERT INTO sessions(session_id, label) VALUES('s1', 'capex')")
    guardUpgrade(db, path, '0.0.2')                             // the next version opens it
    guardUpgrade(db, path, '0.0.2')                             // and again: no second copy
    db.close()
    assert.equal(header(path), versionNumber('0.0.2'))
    const copies = readdirSync(join(t.home, 'backups'))
    assert.equal(copies.length, 1, copies.join(' '))
    assert.match(copies[0], /^till-before-0\.0\.2-\d{8}\.db$/)
    const copy = new Db(join(t.home, 'backups', copies[0]), { readOnly: true })
    try {
      assert.equal(copy.get('SELECT label FROM sessions WHERE session_id=?', 's1')!.label, 'capex')
    } finally {
      copy.close()
    }
  })

  test('a real hook run after an upgrade keeps the copy before it touches anything', (c) => {
    const t = useTemp(c)
    connect(t.db).close()
    const old = new Db(t.db)
    old.exec(`PRAGMA user_version = ${versionNumber('0.0.0')}`)     // as an older version left it
    old.close()
    const p = runScript('till.ts', ['prompt', 'claude-code'], { input: JSON.stringify({ session_id: 's', cwd: '/x', prompt: 'hi' }), env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    assert.ok(readdirSync(join(t.home, 'backups')).some((f) => f.startsWith(`till-before-${VERSION}-`)))
    assert.equal(header(t.db), versionNumber(VERSION))
  })

  test('only the newest upgrade copies are pruned to AGENTARIUM_BACKUPS; nothing else in backups/ is touched', async (c) => {
    const t = useTemp(c)
    const path = join(t.home, 'till.db')
    const dir = t.mkdir('backups')
    const upgrade = ['0.0.1-20261101', '0.0.2-20261102', '0.0.3-20261103', '0.0.4-20261104', '0.0.5-20261105'].map((v) => `till-before-${v}.db`)
    const others = ['till-before-import-20261101-101010.db', 'notes.txt', 'other-before-0.0.1-20261101.db']
    for (const [i, f] of [...upgrade, ...others].entries()) {
      writeFileSync(join(dir, f), f)
      const when = new Date(2026, 10, i + 1)
      utimesSync(join(dir, f), when, when)
    }
    prune(path, 3)
    assert.deepEqual(readdirSync(dir).sort(), [...upgrade.slice(2), ...others].sort())
    assert.equal(await withEnv({ AGENTARIUM_BACKUPS: '0' }, keepCount), 0)
    assert.equal(await withEnv({ AGENTARIUM_BACKUPS: 'lots' }, keepCount), 3)
  })

  test('AGENTARIUM_BACKUPS=0 keeps no copy, but still notes the version', async (c) => {
    const t = useTemp(c)
    const path = join(t.home, 'till.db')
    const db = connect(path)
    await withEnv({ AGENTARIUM_BACKUPS: '0' }, () => guardUpgrade(db, path, '0.0.9'))
    db.close()
    assert.ok(!existsSync(join(t.home, 'backups')))
    assert.equal(header(path), versionNumber('0.0.9'))
  })

  test('a copy never lands on a file that is already there', (c) => {
    const t = useTemp(c)
    const path = join(t.home, 'till.db')
    const db = connect(path)
    try {
      mkdirSync(join(t.home, 'backups'))
      writeFileSync(join(t.home, 'backups', 'till-x.db'), 'not to be touched')
      assert.equal(snapshot(db, path, 'x'), null)
      assert.equal(readFileSync(join(t.home, 'backups', 'till-x.db'), 'utf8'), 'not to be touched')
      assert.ok(snapshot(db, path, 'y')?.endsWith('till-y.db'))
    } finally {
      db.close()
    }
    assert.deepEqual(readdirSync(join(t.home, 'backups')).sort(), ['till-x.db', 'till-y.db'], 'no temporary files left')
  })

  test('versions read as the numbers the header holds', () => {
    assert.equal(versionNumber('0.0.1'), 1)
    assert.equal(versionNumber('1.2.3'), 1_002_003)
    assert.ok(versionNumber('0.10.0') > versionNumber('0.9.9'))
    assert.equal(versionNumber('unknown'), 0)
  })

  test("update and uninstall leave an app folder alone when AGENTARIUM_DB puts the data inside it", async (c) => {
    const t = useTemp(c)
    const app = t.mkdir('.agentarium', 'app')
    mkdirSync(join(app, 'scripts'))
    writeFileSync(join(app, 'scripts', 'cli.ts'), '// installed')
    writeFileSync(join(app, 'till.db'), 'the recorded data')
    await withEnv({ AGENTARIUM_DB: join(app, 'till.db') }, async () => {
      assert.ok(holdsDb(app))
      await assert.rejects(download(app, 'http://127.0.0.1:9/never-reached'), /AGENTARIUM_DB puts the database inside/)
    })
    assert.equal(readFileSync(join(app, 'till.db'), 'utf8'), 'the recorded data')
    assert.ok(!holdsDb(app, join(t.home, '.agentarium', 'till.db')))
  })
})

describe('what --purge may delete', () => {
  test('a linked folder (as macOS links /home and /var) is still caught, the path existing or not', { skip: !POSIX && 'symlinks' }, (c) => {
    const t = useTemp(c)
    const realDir = t.mkdir('real')
    const link = join(t.home, 'link')
    symlinkSync(realDir, link)
    assert.ok(unsafeToPurge(link, join(link, 'ada')), 'holds a home that does not exist yet')
    assert.ok(unsafeToPurge(realDir, join(link, 'ada')))
    const app = join(link, 'app')
    mkdirSync(app)
    assert.ok(holdsDb(app, join(link, 'app', 'till.db')), 'a database not created yet')
    assert.ok(holdsDb(join(realDir, 'app'), join(link, 'app', 'till.db')))
  })

  test('never the home folder, a folder holding it, or a root', () => {
    const home = join(sep, 'home', 'ada')
    assert.ok(unsafeToPurge(home, home))
    assert.ok(unsafeToPurge(join(sep, 'home'), home))
    assert.ok(unsafeToPurge(parse(process.cwd()).root, home))
    assert.ok(!unsafeToPurge(join(home, '.agentarium'), home))
    assert.ok(!unsafeToPurge(join(sep, 'srv', 'agentarium'), home))
  })
})
