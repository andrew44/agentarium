/** Running the installer again, and upgrading: nothing is lost, nothing is churned, nothing that
 *  isn't agentarium's is replaced or deleted. (The real one-liners run in .github/workflows/installer.yml.) */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, parse, sep } from 'node:path'
import { describe, test } from 'node:test'

import { runScript, useTemp, type Env } from './helpers.ts'

import { download, isApp, unsafeToPurge } from '../scripts/cli.ts'

const POSIX = process.platform !== 'win32'

/** A home with a stand-in `claude`, the way the installer finds one, and the user's own settings. */
function machine(c: Parameters<typeof useTemp>[0], settings: object | null = { theme: 'dark', env: { MY_VAR: '1' } }) {
  const t = useTemp(c)
  const h = t.home
  const fakebin = t.mkdir('fakebin')
  writeFileSync(join(fakebin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(fakebin, 'claude'), 0o755)
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
  return { t, h, env, claudeSettings, backup: `${claudeSettings}.agentarium.bak`, cli }
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
    assert.equal(readFileSync(join(h, '.bashrc'), 'utf8').split('agentarium installer').length - 1, 1, 'one PATH line')
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

describe('what --purge may delete', () => {
  test('never the home folder, a folder holding it, or a root', () => {
    const home = join(sep, 'home', 'ada')
    assert.ok(unsafeToPurge(home, home))
    assert.ok(unsafeToPurge(join(sep, 'home'), home))
    assert.ok(unsafeToPurge(parse(process.cwd()).root, home))
    assert.ok(!unsafeToPurge(join(home, '.agentarium'), home))
    assert.ok(!unsafeToPurge(join(sep, 'srv', 'agentarium'), home))
  })
})
