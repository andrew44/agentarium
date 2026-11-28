#!/usr/bin/env node
/**
 * agentarium: one command for setup, the dashboard, reports and updates.
 *
 * Installed by the one-line installer (install.sh / install.ps1) as `agentarium` on your PATH:
 *
 *   agentarium                    what's installed, and what to try next
 *   agentarium dashboard [--demo] open the dashboard (runs in the background; --stop to stop it)
 *   agentarium report [--days N]  spend report in the terminal
 *   agentarium statusline [...]   status line and band options, e.g. --demo, --set-currency USD,
 *                                 --band-off, --status
 *   agentarium router [...]       sommelier model router: on | off [--project] (the proxy, in the
 *                                 background), status, learn, eval, serve [--port N], explain "prompt", env
 *   agentarium profile [name]     show the settings in effect; frugal | balanced | quality sets the profile
 *   agentarium audit [...]        every leak check in one report, biggest money first (--days 30)
 *   agentarium copilot [--json]   Copilot premium requests: left this month, the pace, when they run out;
 *                                 --window keeps them in a small window, for the Copilot app (--window --stop)
 *   agentarium vscode [folder]    add the VS Code agent hooks to a workspace (.github/hooks/agentarium.json);
 *                                 --remove takes them out, --print shows them; --status-bar puts Copilot's
 *                                 premium requests in VS Code's status bar (--status-bar --remove takes it out)
 *   agentarium doggybag           pack a doggybag (resume note) for this folder's latest session now
 *   agentarium bang-for-buck [...] cost per outcome: per feature, bug fixed, passing suite (alias: value)
 *   agentarium waistline [...]    cost regression: is the same work getting dearer? (--ci for pipelines)
 *   agentarium sherlock [...]     agent forensics: where this folder's latest session wasted money
 *   agentarium taste-test [...]   compare two runs of a task: cost vs quality (--a ... --b ...)
 *   agentarium haggle [...]       quote a task before it starts: haggle quote "task" --price 2
 *   agentarium spring-clean       audit CLAUDE.md / AGENTS.md for duplicate, stale and bloated context
 *   agentarium groundhog          list the loops this folder's latest session went round
 *   agentarium split-the-bill [...] who and what spent the budget: project, developer, agent, model ... (--csv)
 *   agentarium bazaar [...]       the best-value provider for the same work (quote, list)
 *   agentarium blinkers [...]     scope creep in a session (check) or a branch (diff --task "...")
 *   agentarium crystal-ball [...] what a team's AI adoption will cost a month (--devs 10 --tasks 20 ...)
 *   agentarium deadwood [...]     this month's spend on work that produced nothing (session, mark)
 *   agentarium pack-light [...]   what every request carries (MCP servers, skills) and which you never use
 *   agentarium ballast [...]      context carried from one task into the next in a session, and its cost
 *   agentarium waffle [...]       output spend: long replies, recaps, whole-file rewrites, thinking (--days 7)
 *   agentarium cold-snap [...]    every time the prompt cache went cold, why (break, model switch, prefix change), and its cost
 *   agentarium parrot [...]       what you keep telling the AI across sessions: rules, corrections, prompts (report)
 *   agentarium all-you-can-eat [...] pay-as-you-go or a subscription: which plan fits your spend (--plan pro|max5|max20)
 *   agentarium fishingrod [name]  the why behind each notice, and what to do next time (alias: lessons)
 *   agentarium cache-buster       edits to CLAUDE.md, settings or skills in this folder's latest session, priced
 *   agentarium too-many-cooks     what your subagents cost, and the ones caught before they ran (--days 30)
 *   agentarium diet sizes         what each program and file type typically prints into the context
 *   agentarium colander [...]     what colander strained out of test, build and install output (report --days 7),
 *                                 or what it would keep of some output: npm test 2>&1 | agentarium colander strain
 *   agentarium receipt [...]      what the AI work on this branch cost (--trailer for a commit, --markdown for a PR)
 *   agentarium dry-run [...]      what a skill, plugin or MCP server will cost before you install it
 *   agentarium rate-my-prompt "prompt"  a prompt scored out of 10 for what it will cost (--last; alias: judge)
 *   (a hyphenated name also works as one word, the way its setting spells it: bangforbuck, coldsnap ...)
 *
 * Signature features: value-meter (bang-for-buck), agent-forensics (sherlock), quality-gate (taste-test).
 *   agentarium --version          the version installed
 *   agentarium update             fetch the latest version and refresh everything
 *   agentarium uninstall [--purge]  remove it all (--purge also deletes your recorded data)
 *   agentarium setup              (re)do the setup the installer does; idempotent
 *   agentarium import             bring a tokenomics install's history and settings over (--dry-run first;
 *                                 setup does it by itself the first time)
 *
 * Setup does, for each assistant it finds on this computer:
 *   Claude Code  -> adds the plugin, or updates it to the latest (skills + hooks + its row in the apps'
 *                   band), and the status line
 *   Copilot CLI  -> adds or updates the plugin, and the status line
 * It never replaces a status line you already have. Node.js 22.18+, built-ins only.
 *
 * Settings: AGENTARIUM_REPO and AGENTARIUM_REF (a branch, a tag or a commit on one) choose what setup
 * and update fetch, by default andrew44/agentarium at main. Setup adds Claude Code's marketplace at
 * that ref too, so the plugin is the same code as the app.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDbPath } from '../agentarium/config.ts'
import { versionNumber } from '../agentarium/engine/backup.ts'
import { VERSION } from '../agentarium/index.ts'
import { configFile, FILLED, PROFILES, resolve as resolveProfile } from '../agentarium/profile.ts'
import * as statusline from './statusline.ts'
import * as controller from './controller.ts'
import * as importer from './import.ts'

const HERE = import.meta.dirname
const SELF = fileURLToPath(import.meta.url)
const HOME = homedir()
const TK_HOME = process.env.AGENTARIUM_HOME || join(HOME, '.agentarium')
const APP_DIR = join(TK_HOME, 'app')
const REPO = process.env.AGENTARIUM_REPO || 'andrew44/agentarium'
const REF = process.env.AGENTARIUM_REF || 'main'
// The marketplace entry's source is "./", the marketplace's own checkout, so the ref it is added at is
// the ref the plugin comes from. Claude Code refuses a commit that no branch or tag holds.
const SOURCE = REF === 'main' ? REPO : `${REPO}#${REF}`
const MARKETPLACE = 'agentarium'
const PLUGIN = 'agentarium@agentarium'
const WINDOWS = process.platform === 'win32'
const RC_MARK = '# added by the agentarium installer'
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning']

const say = (msg = '') => process.stdout.write(msg + '\n')

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Full path of a command on PATH (with PATHEXT on Windows), or null. */
export function which(cmd: string): string | null {
  // Windows: a bare name only runs through PATHEXT (claude -> claude.cmd), as cmd.exe and Python's
  // shutil.which resolve it. npm also puts an extension-less sh shim beside claude.cmd that Node
  // can't start, so that one must never be picked.
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const exts = !WINDOWS ? [''] : pathext.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase())) ? [''] : pathext
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      try {
        if (isFile(p)) {
          if (!WINDOWS) accessSync(p, constants.X_OK)
          return p
        }
      } catch {
        // not executable
      }
    }
  }
  return null
}

/** Run a command: its exit status and what it printed, or null when it can't start. Never reads our
 *  stdin (the installer may be piped in). */
function exec(cmd: string[], quiet = true): { ok: boolean, stdout: string } | null {
  const exe = which(cmd[0])          // on Windows `claude` is often claude.cmd, which needs a shell
  if (!exe) return null
  try {
    const stdio: ('ignore' | 'pipe' | 'inherit')[] = ['ignore', quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit']
    // A .cmd/.bat only runs through cmd.exe: hand it one quoted command line (passing an args
    // array with shell: true is deprecated, as the args aren't escaped).
    const p = WINDOWS && /\.(cmd|bat)$/i.test(exe)
      ? spawnSync([exe, ...cmd.slice(1)].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)).join(' '),
        { stdio, timeout: 300_000, shell: true, windowsHide: true, encoding: 'utf8' })
      : spawnSync(exe, cmd.slice(1), { stdio, timeout: 300_000, windowsHide: true, encoding: 'utf8' })
    return { ok: p.status === 0, stdout: String(p.stdout ?? '') }
  } catch {
    return null
  }
}

/** Run a command; true on success. */
const run = (cmd: string[], quiet = true): boolean => exec(cmd, quiet)?.ok ?? false

function script(name: string, ...args: string[]): number {
  const p = spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, name), ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  return p.status ?? 1
}

/** script(), with stdin passed through, for a helper that reads what is piped into it (`colander strain`). */
function piped(name: string, ...args: string[]): number {
  const p = spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, name), ...args], { stdio: 'inherit' })
  return p.status ?? 1
}

// ---- assistants ---------------------------------------------------------------------------------

const has = (cli: string) => which(cli) !== null

function claudePlugin(action: 'install' | 'update' | 'uninstall'): boolean {
  if (action !== 'uninstall') {
    if (action === 'install') run(['claude', 'plugin', 'marketplace', 'add', SOURCE])
    run(['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])          // the latest listing
    // update first: `plugin install` leaves an installed plugin at its old version and exits 0;
    // `plugin update` moves it to the latest, and fails when there is none to update
    return run(['claude', 'plugin', 'update', PLUGIN]) || (action === 'install' && run(['claude', 'plugin', 'install', PLUGIN]))
  }
  const ok = run(['claude', 'plugin', 'uninstall', PLUGIN])
  run(['claude', 'plugin', 'marketplace', 'remove', MARKETPLACE])
  return ok
}

function copilotPlugin(action: 'install' | 'update' | 'uninstall'): boolean {
  // update first here too, so an installed plugin moves to the latest rather than staying put
  if (action !== 'uninstall') return run(['copilot', 'plugin', 'update', 'agentarium']) || run(['copilot', 'plugin', 'install', REPO])
  return run(['copilot', 'plugin', 'uninstall', 'agentarium'])
}

/** The agentarium version Claude Code has installed (`claude plugin list --json`), or null. */
function claudePluginVersion(): string | null {
  try {
    const list = JSON.parse(exec(['claude', 'plugin', 'list', '--json'])?.stdout || '[]')
    const ours = Array.isArray(list) ? list.find((p) => p?.id === PLUGIN) : null
    return typeof ours?.version === 'string' && ours.version !== 'unknown' ? ours.version : null
  } catch {
    return null
  }
}

/** Claude Code keeps a marketplace at the source it was first added from and refuses to add it again
 *  from another, so a run at a new ref (or back at main) can't move it. Where it is and the commands
 *  that move it to SOURCE, or null when it is there already or `marketplace list --json` can't tell. */
function marketplaceElsewhere(): { at: string, fix: string } | null {
  try {
    const list = JSON.parse(exec(['claude', 'plugin', 'marketplace', 'list', '--json'])?.stdout || '[]')
    const ours = Array.isArray(list) ? list.find((m) => m?.name === MARKETPLACE) : null
    if (ours?.source !== 'github' || typeof ours.repo !== 'string') return null     // e.g. a folder, for development
    const ref = typeof ours.ref === 'string' && ours.ref ? ours.ref : 'main'
    if (ours.repo.toLowerCase() === REPO.toLowerCase() && ref === REF) return null
    return { at: ref === 'main' ? ours.repo : `${ours.repo}#${ref}`,
      // removing it at user scope (where setup adds it) uninstalls the plugin, so install, not update, follows
      fix: `claude plugin marketplace remove ${MARKETPLACE} --scope user && claude plugin marketplace add ${SOURCE} && claude plugin install ${PLUGIN}` }
  } catch {
    return null
  }
}

// ---- the `agentarium` launcher ------------------------------------------------------------------

function real(p: string): string {
  let r: string
  try {
    r = realpathSync(p)
  } catch {
    r = resolve(p)
  }
  return WINDOWS ? r.toLowerCase() : r
}

function onPath(d: string): boolean {
  return (process.env.PATH || '').split(delimiter).filter(Boolean).map(real).includes(real(d))
}

function binDir(): string {
  if (WINDOWS) return join(TK_HOME, 'bin')
  for (const d of [join(HOME, '.local', 'bin'), join(HOME, 'bin')]) if (onPath(d)) return d
  return join(HOME, '.local', 'bin')
}

function rcFiles(): string[] {
  const shell = basename(process.env.SHELL || '')
  if (shell === 'zsh') return [join(HOME, '.zshrc')]
  if (shell === 'bash') return [join(HOME, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')]
  if (shell === 'fish') return []
  return [join(HOME, '.profile')]
}

/** Write `text` to `path` unless it already says exactly that, so a re-run changes nothing. On Windows
 *  that matters: `agentarium update` runs setup while cmd.exe is still reading agentarium.cmd. */
function writeIfChanged(path: string, text: string): void {
  try {
    if (readFileSync(path, 'utf8') === text) return
  } catch {
    // not there yet
  }
  writeFileSync(path, text, 'utf8')
}

/** An app folder this installer made: replacing or deleting anything else would lose someone's files. */
export const isApp = (dir: string) => isFile(join(dir, 'scripts', 'cli.ts'))

/** `p` with links resolved, through its deepest parent that exists when `p` itself doesn't yet. */
function resolvedPath(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head))
    head = dirname(head)
  }
  return join(real(head), ...tail)
}

/** Both spellings of a pair of paths: as given, and with links resolved (macOS links /var and /home
 *  elsewhere), so a check can't miss either way. */
function spellings(a: string, b: string): [string, string][] {
  const plain = (p: string) => (WINDOWS ? resolve(p).toLowerCase() : resolve(p))
  const linked = (p: string) => (WINDOWS ? resolvedPath(p).toLowerCase() : resolvedPath(p))
  return [[plain(a), plain(b)], [linked(a), linked(b)]]
}

const inside = (child: string, dir: string) => child.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** True when till's database (AGENTARIUM_DB) sits inside `dir`, which an update or uninstall replaces. */
export function holdsDb(dir: string, db = defaultDbPath()): boolean {
  return spellings(dir, db).some(([d, f]) => inside(f, d))
}

/** A folder `--purge` must never delete, whatever AGENTARIUM_HOME says: the home folder, one that
 *  holds it, or the root of a drive. */
export function unsafeToPurge(dir: string, home = HOME): boolean {
  return spellings(dir, home).some(([d, h]) => d === h || inside(h, d) || dirname(d) === d)
}

/** Record this Node.js for scripts/run.sh and the Copilot hooks, so they never have to guess. */
function rememberNode(): void {
  try {
    mkdirSync(TK_HOME, { recursive: true })
    writeIfChanged(join(TK_HOME, 'node'), process.execPath.replaceAll('\\', '/') + '\n')
  } catch {
    // run.sh will look for one itself
  }
}

/** Write the `agentarium` command; returns [path, needsNewTerminal]. */
function installLauncher(): [string, boolean] {
  const d = binDir()
  mkdirSync(d, { recursive: true })
  let path: string
  if (WINDOWS) {
    path = join(d, 'agentarium.cmd')
    writeIfChanged(path, `@"${process.execPath}" ${NODE_FLAGS.join(' ')} "${SELF}" %*\r\n`)
  } else {
    path = join(d, 'agentarium')
    writeIfChanged(path, `#!/bin/sh\nexec "${process.execPath}" ${NODE_FLAGS.join(' ')} "${SELF}" "$@"\n`)
    chmodSync(path, 0o755)
  }
  if (onPath(d)) return [path, false]
  if (WINDOWS) return [path, true]                         // install.ps1 puts this folder on PATH
  const line = `export PATH="${d}:$PATH"  ${RC_MARK}\n`
  for (const rc of rcFiles()) {
    try {
      const text = existsSync(rc) ? readFileSync(rc, 'utf8') : ''
      if (!text.includes(RC_MARK)) appendFileSync(rc, (text && !text.endsWith('\n') ? '\n' : '') + line, 'utf8')
    } catch {
      // the user can add it by hand
    }
  }
  if (basename(process.env.SHELL || '') === 'fish') {
    const fish = join(HOME, '.config', 'fish', 'conf.d')
    mkdirSync(fish, { recursive: true })
    writeIfChanged(join(fish, 'agentarium.fish'), `fish_add_path ${d}  ${RC_MARK}\n`)
  }
  return [path, true]
}

/** Windows: delete a file or folder a few seconds from now, from a detached process, for
 *  things in use by this very command (its .cmd launcher, the Node.js running it). */
function deleteLater(path: string): void {
  const rm = isDir(path) ? `rmdir /s /q "${path}"` : `del /f /q "${path}"`
  spawn('cmd', ['/c', `ping -n 3 127.0.0.1 >nul & ${rm}`], { stdio: 'ignore', detached: true, windowsHide: true, shell: false }).unref()
}

function removeLauncher(): void {
  for (const d of new Set([join(HOME, '.local', 'bin'), join(HOME, 'bin'), join(TK_HOME, 'bin')])) {
    for (const name of ['agentarium', 'agentarium.cmd']) {
      const p = join(d, name)
      if (!isFile(p)) continue
      // cmd.exe is still running this very file and re-reads it when node exits, so deleting it
      // now makes cmd fail with "The batch file cannot be found".
      if (WINDOWS && name.endsWith('.cmd')) deleteLater(p)
      else unlinkSync(p)
    }
  }
  for (const rc of ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map((n) => join(HOME, n))) {
    let text: string
    try {
      text = readFileSync(rc, 'utf8')
    } catch {
      continue
    }
    if (text.includes(RC_MARK)) {
      writeFileSync(rc, text.split(/(?<=\n)/).filter((l) => !l.includes(RC_MARK)).join(''), 'utf8')
    }
  }
  const fish = join(HOME, '.config', 'fish', 'conf.d', 'agentarium.fish')
  if (isFile(fish)) unlinkSync(fish)
}

// ---- commands -----------------------------------------------------------------------------------

function setup(args: string[]): number {
  const wantPlugin = !args.includes('--no-plugin')
  const wantLine = !args.includes('--no-statusline')
  const found = ['claude', 'copilot'].filter(has)
  say(`Setting up agentarium ${VERSION}`)
  say('')
  if (!found.length) {
    say("  ! Neither Claude Code ('claude') nor GitHub Copilot CLI ('copilot') was found on PATH.")
    say('    Install one (https://claude.com/claude-code), then run: agentarium setup')
  }
  for (const cli of found) {
    const name = cli === 'claude' ? 'Claude Code' : 'Copilot CLI'
    if (wantPlugin) {
      if (cli === 'claude' ? claudePlugin('install') : copilotPlugin('install')) {
        const v = cli === 'claude' ? claudePluginVersion() : null
        const elsewhere = cli === 'claude' ? marketplaceElsewhere() : null
        if (elsewhere) {
          say(`  ! ${name}: plugin ${v ? `${v} ` : ''}installed from ${elsewhere.at}, where its marketplace was first added. For ${SOURCE}, run: ${elsewhere.fix}`)
        } else if (v && versionNumber(v) < versionNumber(VERSION)) {
          say(`  ! ${name}: plugin ${v} installed, but ${VERSION} is the latest. Run: claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN}`)
        } else {
          say(`  ✓ ${name}: plugin ${v ? `${v} ` : ''}installed (skills + hooks)`)
        }
      } else {
        const manual = cli === 'claude' ? `claude plugin marketplace add ${SOURCE} && claude plugin install ${PLUGIN}`
          : `copilot plugin install ${REPO}`
        say(`  ! ${name}: couldn't add the plugin automatically. Run: ${manual}`)
      }
    }
    if (wantLine) {
      const lines: string[] = []
      try {
        statusline.install(cli, { keepExisting: true, out: (s) => lines.push(s) })
      } catch (e) {                                          // e.g. settings.json isn't valid JSON
        lines.push(`Skipped ${cli}: ${e instanceof Error ? e.message : e}`)
      }
      if (lines.join('\n').includes('Skipped')) {
        say(`  · ${name}: kept your existing status line (replace it with: agentarium statusline --install ${cli})`)
      } else {
        say(`  ✓ ${name}: status line installed`)
      }
    }
  }
  // VS Code copies the status bar item's code when it is added, so one added before is brought up to date
  for (const c of CODE_CLIS.filter(has)) {
    const listed = (exec([c, '--list-extensions', '--show-versions'])?.stdout ?? '').split(/\r?\n/)
    const at = listed.find((l) => l.trim().toLowerCase().startsWith(`${EXTENSION_ID}@`))
    if (at && at.trim().slice(EXTENSION_ID.length + 1) !== VERSION && run([c, '--install-extension', writeVsix(), '--force'])) {
      say(`  ✓ ${c}: status bar item updated to ${VERSION}`)
    }
  }
  // agentarium was tokenomics until 0.0.1: an install of it comes over once (its own files untouched)
  if (importer.found() && !importer.imported()) {
    try {
      for (const line of importer.summary(importer.bringOver())) say(`  ${line}`)
    } catch (e) {
      say(`  ! tokenomics: couldn't bring its history over (${e instanceof Error ? e.message : e}). Try again with: agentarium import`)
    }
  }
  rememberNode()
  const [path, newTerminal] = installLauncher()
  say(`  ✓ 'agentarium' command: ${path}`)
  say('')
  const names = found.map((c) => (c === 'claude' ? 'Claude Code' : 'Copilot CLI')).join(' / ')
  let step: number
  if (found.length) {
    say('Done! Next steps:')
    say(`  1. Quit and reopen ${names} (type /exit, then start it again).`)
    say('  2. Ask it: "coach, review my prompts" or "spend report".')
    step = 3
    if (found.includes('claude')) {
      say('  3. Get updates automatically: in Claude Code open /plugin > Marketplaces > agentarium')
      say('     and turn on auto-update.')
      step = 4
    }
  } else {
    say('Done (no assistant to connect yet). Next steps:')
    step = 1
  }
  say(newTerminal ? `  ${step}. Open a new terminal window, then try: agentarium dashboard --demo`
    : `  ${step}. See where your tokens go: agentarium dashboard --demo`)
  return 0
}

class CliError extends Error {}

/** Fetch REPO@REF (fetch() first, then curl) and swap it in at dest. It is unpacked beside dest, since
 *  a rename from a /tmp on another filesystem fails; the old copy is renamed aside before the new one
 *  moves in, and put back if that fails, so there is always a working app; and only a folder that is
 *  an agentarium app is ever replaced. */
export async function download(dest: string, url = `https://github.com/${REPO}/archive/${REF}.tar.gz`): Promise<void> {
  if (existsSync(dest) && !isApp(dest)) throw new CliError(`${dest} exists but isn't an agentarium install; move it out of the way and try again.`)
  if (holdsDb(dest)) throw new CliError(`AGENTARIUM_DB puts the database inside ${dest}, which an update replaces. Move it out first (and point AGENTARIUM_DB at the new place); nothing was changed.`)
  mkdirSync(dirname(dest), { recursive: true })
  for (const f of readdirSync(dirname(dest))) {             // what an earlier run couldn't delete (Windows)
    if (f.startsWith(`${basename(dest)}.old-`) || f.startsWith('.download-')) rmSync(join(dirname(dest), f), { recursive: true, force: true })
  }
  const tmp = mkdtempSync(join(dirname(dest), '.download-'))
  try {
    const tgz = join(tmp, 'src.tar.gz')
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      writeFileSync(tgz, Buffer.from(await r.arrayBuffer()))
    } catch {
      if (!run(['curl', '-fsSL', '-o', tgz, url])) throw new CliError(`Couldn't download ${url}. Check your connection and try again.`)
    }
    const list = spawnSync('tar', ['-tvzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const names = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (list.status !== 0 || names.status !== 0) throw new CliError("Couldn't read the download.")
    const unsafe = String(names.stdout).split('\n').filter(Boolean).some((n) => n.startsWith('/') || n.split(/[/\\]/).includes('..')) ||
      String(list.stdout).split('\n').some((l) => /^[lh]/.test(l))
    if (unsafe) throw new CliError('Refusing an archive with unsafe paths.')
    const out = join(tmp, 'src')
    mkdirSync(out)
    if (spawnSync('tar', ['-xzf', tgz, '-C', out]).status !== 0) throw new CliError("Couldn't unpack the download.")
    const tops = readdirSync(out).map((f) => join(out, f)).filter(isDir)
    if (tops.length !== 1 || !isApp(tops[0])) throw new CliError("The download doesn't look like agentarium.")
    const old = `${dest}.old-${process.pid}`
    if (existsSync(dest)) {
      try {
        renameSync(dest, old)
      } catch {
        throw new CliError(`Couldn't replace ${dest}: something has a file in it open (VS Code, the dashboard?). Close it and try again; nothing was changed.`)
      }
    }
    try {
      renameSync(tops[0], dest)
    } catch (e) {
      if (existsSync(old)) renameSync(old, dest)            // never leave no app at all
      throw e
    }
    try {
      rmSync(old, { recursive: true, force: true })
    } catch {
      // in use on Windows: the next update clears it
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function update(args: string[]): Promise<number> {
  say(`Downloading the latest agentarium (${REPO}@${REF})...`)
  try {
    await download(APP_DIR)
  } catch (e) {
    if (!(e instanceof CliError)) throw e
    process.stderr.write(e.message + '\n')
    return 1
  }
  if (has('claude')) {
    say(claudePlugin('update') ? '  ✓ Claude Code plugin updated' : '  · Claude Code plugin: no update applied')
    const elsewhere = marketplaceElsewhere()
    if (elsewhere) say(`  ! Claude Code plugin: it comes from ${elsewhere.at}, where its marketplace was first added. For ${SOURCE}, run: ${elsewhere.fix}`)
  }
  if (has('copilot')) say(copilotPlugin('update') ? '  ✓ Copilot CLI plugin updated' : '  · Copilot CLI plugin: no update applied')
  // Re-run setup from the fresh copy so the status line, launcher and anything new are current.
  return spawnSync(process.execPath, [...NODE_FLAGS, join(APP_DIR, 'scripts', 'cli.ts'), 'setup', '--no-plugin', ...args],
    { stdio: ['ignore', 'inherit', 'inherit'] }).status ?? 1
}

function uninstall(args: string[]): number {
  for (const t of ['claude', 'copilot']) {
    if (statusline.isOurs(statusline.statusLine(t))) statusline.install(t, { remove: true })
  }
  if (has('claude') && claudePlugin('uninstall')) say('Removed the Claude Code plugin.')
  if (has('copilot') && copilotPlugin('uninstall')) say('Removed the Copilot CLI plugin.')
  removeLauncher()
  for (const c of CODE_CLIS.filter(has)) if (run([c, '--uninstall-extension', EXTENSION_ID])) say(`Removed the status bar item from ${c}.`)
  spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, 'dashboard.ts'), '--stop'], { stdio: 'ignore' })
  if (args.includes('--purge')) {
    if (unsafeToPurge(TK_HOME)) {
      say(`Not deleting ${TK_HOME}: AGENTARIUM_HOME points at a folder that holds more than agentarium's data. Delete what you mean to by hand.`)
      return 1
    }
    rmSync(TK_HOME, { recursive: true, force: true })
    say(`Deleted ${TK_HOME} (all recorded data).`)
    return 0
  }
  if (holdsDb(APP_DIR)) say(`Left ${APP_DIR} alone: AGENTARIUM_DB puts the recorded data inside it.`)
  else if (isApp(APP_DIR)) rmSync(APP_DIR, { recursive: true, force: true })
  else if (existsSync(APP_DIR)) say(`Left ${APP_DIR} alone: it isn't an agentarium install.`)
  const runtime = join(TK_HOME, 'runtime')                 // the private Node.js, if any
  if (!isDir(join(runtime, 'node'))) {
    // none, or not the installer's: leave it
  } else if (WINDOWS) deleteLater(runtime)                 // it may be running this command
  else rmSync(runtime, { recursive: true, force: true })
  for (const name of ['statusline.mts', 'model-prices.json', 'node']) {
    try {
      unlinkSync(join(TK_HOME, name))
    } catch {
      // not there
    }
  }
  say(`agentarium is uninstalled. Your recorded data is kept in ${TK_HOME}; delete that folder to remove it too.`)
  return 0
}

/** `agentarium profile [frugal|balanced|quality|off]`: show what's in effect, or set the profile. */
function profileCmd(args: string[]): number {
  const file = configFile()
  const name = (args[0] ?? '').toLowerCase()
  if (name) {
    if (name !== 'off' && !(name in PROFILES)) {
      say(`Unknown profile: ${name}. Choose frugal, balanced or quality (or off).`)
      return 2
    }
    let cfg: Record<string, any> = {}
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      cfg = {}
    }
    if (name === 'off') delete cfg.profile
    else cfg.profile = name
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
    say(name === 'off' ? `Profile cleared in ${file}.` : `Profile set to ${name} in ${file}. It applies from the next prompt.`)
    if (process.env.AGENTARIUM_PROFILE) say(`Note: AGENTARIUM_PROFILE=${process.env.AGENTARIUM_PROFILE} is set in your environment and wins.`)
    return 0
  }
  // what the hooks see: this process already filled the env in, so resolve against a clean copy
  const r = resolveProfile(Object.fromEntries(Object.entries(process.env).filter(([k]) => !FILLED.has(k))))
  const why = { env: 'AGENTARIUM_PROFILE', phase: "today's budget passed its warning share", project: `projects: ${r.project}`, config: 'config.json' }
  say(`profile: ${r.profile ? `${r.profile} (${why[r.from!]})` : 'none (balanced defaults)'}   ·   config: ${existsSync(file) ? file : `${file} (not created)`}`)
  const rows = Object.entries(r.values).filter(([k]) => !['AGENTARIUM_HOME', 'AGENTARIUM_DB'].includes(k)).sort()
  if (!rows.length) say('No settings changed from the defaults.')
  for (const [k, v] of rows) say(`  ${k.padEnd(34)} ${v.value.padEnd(40)} (${v.from})`)
  for (const e of r.errors) say(`  ! ${e}`)
  say('')
  say('Set: agentarium profile frugal | balanced | quality | off   ·   per setting: "settings" in config.json, or the env')
  say('Per folder: "projects": {"~/work/api": "quality"} in config.json   ·   on a tight day: "settings": {"budget_profile": "frugal"}')
  return 0
}

/** `agentarium copilot`: the premium-request allowance, the way the band shows a budget. */
function copilotCmd(args: string[]): number {
  // --window: the same numbers in a small window, for the Copilot app (which has no status line)
  if (args.includes('--window')) return script('dashboard.ts', ...(args.includes('--stop') ? ['--stop'] : ['--background', '--copilot']))
  const a = statusline.copilotAllowance()
  const u = statusline.copilotUsage(new Date(), a?.multiplier ?? 1)
  const n = u?.prompts ?? 0
  if (!a) {
    say(`Copilot prompts recorded this month: ${n ?? 0}.`)
    const r = statusline.copilotRoute()
    if (r) say(`Latest routed prompt: ${statusline.fusionLabel(r.router)} → ${r.model}.`)
    say('Set your monthly allowance to see what is left and when it runs out, e.g.:')
    say('  agentarium profile   ·   config.json "settings": { "copilot_allowance": 300, "copilot_multiplier": 1 }')
    say('  (or AGENTARIUM_COPILOT_ALLOWANCE=300; the multiplier is your model\'s premium-request multiplier)')
    return 0
  }
  const p = statusline.premiumOutlook(n, a, new Date(), statusline.FORECAST_STEPS, u)
  if (args.includes('--json')) {
    say(JSON.stringify(p, null, 2))
    return 0
  }
  say(`Copilot premium requests, ${new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`)
  say(`  used       ${p.used} of ${p.allowance} (${p.pct}%)${p.over ? '  OVER' : ''}`)
  say(`  left       ${Math.max(0, p.left)}`)
  say(`  pace       ~${p.per_day} a day, ~${p.projected} by month end`)
  say(`  runs out   ${p.runs_out === 'now' ? 'already' : p.runs_out ? `~${p.runs_out} at this pace` : 'not this month at this pace'}`)
  say(`  next ${p.steps} prompts use ${p.next} (multiplier ${u?.last ?? a.multiplier}${u?.last != null ? ', the latest prompt\'s model' : ''})`)
  const r = statusline.copilotRoute()
  if (r) say(`  routing    ${statusline.fusionLabel(r.router)} → ${r.model} (the latest routed prompt, counted at that model's multiplier)`)
  if (p.runs_out && p.runs_out !== 'now') say('  Tip: a model with a lower multiplier (or 0x, included) stretches it; diet and groundhog stop the wasted turns.')
  return 0
}

/** VS Code's hook file with this install's path in it (forward slashes: sh and PowerShell both take them). */
export function vscodeHooks(root = dirname(HERE)): string {   // root: where the hooks should point
  const path = JSON.stringify(root.replaceAll('\\', '/')).slice(1, -1)
  return readFileSync(join(dirname(HERE), 'vscode-hooks.json'), 'utf8').replaceAll('${AGENTARIUM_ROOT}', path)
}

// ---- VS Code's status bar: a tiny extension (vscode/), packed here as a .vsix --------------------

const EXTENSION_ID = 'agentarium.agentarium-status'
const CODE_CLIS = ['code', 'code-insiders']

/** A zip of `files` (path -> contents), stored without compression: a .vsix is a zip, and this
 *  keeps the packer to Node.js built-ins (zlib.crc32, 22.2+). */
export function zip(files: Record<string, string | Buffer>): Buffer {
  const { crc32 } = process.getBuiltinModule('node:zlib') as typeof import('node:zlib')
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const fname = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)                       // version needed
    head.writeUInt16LE(0x0800, 6)                   // names are UTF-8
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(fname.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(fname.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(head, fname, data)
    central.push(dir, fname)
    offset += head.length + fname.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

const xml = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The VS Code extension as a .vsix, pointing at `root` and at the plugin's version. */
export function statusVsix(root = dirname(HERE)): Buffer {
  const src = join(dirname(HERE), 'vscode')
  const version = VERSION
  const pkg = { ...JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')), version }
  const path = JSON.stringify(root.replaceAll('\\', '/')).slice(1, -1).replaceAll("'", "\\'")
  const code = readFileSync(join(src, 'extension.js'), 'utf8').replace("'${AGENTARIUM_ROOT}'", `'${path}'`)
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
  const types = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" />' +
    '<Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>\n'
  return zip({ '[Content_Types].xml': types, 'extension.vsixmanifest': manifest,
    'extension/package.json': JSON.stringify(pkg, null, 2) + '\n', 'extension/extension.js': code })
}

/** The status bar item, packed for this version at ~/.agentarium/vscode/agentarium-status.vsix. */
function writeVsix(): string {
  const vsix = join(TK_HOME, 'vscode', 'agentarium-status.vsix')
  mkdirSync(dirname(vsix), { recursive: true })
  writeFileSync(vsix, statusVsix())
  return vsix
}

/** `agentarium vscode --status-bar [--remove]`: Copilot's premium requests in VS Code's status bar. */
function vscodeStatusBar(args: string[]): number {
  const cli = CODE_CLIS.filter(has)
  if (args.includes('--remove')) {
    const done = cli.filter((c) => run([c, '--uninstall-extension', EXTENSION_ID]))
    say(done.length ? `Removed the status bar item from ${done.join(' and ')}. Reload the window to see it go.`
      : `It isn't installed (or VS Code's \`code\` command isn't on your PATH: remove "agentarium: Copilot premium requests" in the Extensions view).`)
    return 0
  }
  const vsix = writeVsix()
  if (args.includes('--print')) {
    say(vsix)
    return 0
  }
  const done = cli.filter((c) => run([c, '--install-extension', vsix, '--force']))
  if (done.length) {
    say(`Added Copilot's premium requests to the right of ${done.join(' and ')}'s status bar.`)
    say('Reload the window (or restart VS Code) to see it. Set AGENTARIUM_COPILOT_ALLOWANCE for what is left and when it runs out.')
    return 0
  }
  say(`Built ${vsix}, but VS Code's \`code\` command isn't on your PATH.`)
  say('In VS Code, run "Extensions: Install from VSIX..." from the Command Palette and pick that file.')
  return 0
}

/** `agentarium vscode [folder]`: VS Code runs agent hooks from the workspace's .github/hooks/*.json. */
function vscodeCmd(args: string[]): number {
  if (args.includes('--status-bar')) return vscodeStatusBar(args)
  const text = vscodeHooks()
  if (args.includes('--print')) {
    process.stdout.write(text)
    return 0
  }
  const folder = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())
  const file = join(folder, '.github', 'hooks', 'agentarium.json')
  if (args.includes('--remove')) {
    if (!isFile(file)) say(`No agentarium hooks in ${folder}.`)
    else {
      unlinkSync(file)
      say(`Removed ${file}.`)
    }
    return 0
  }
  if (isFile(file) && readFileSync(file, 'utf8') === text) {
    say(`Already set up: ${file}`)
    return 0
  }
  if (isFile(file) && !args.includes('--force')) {
    say(`${file} exists and differs. Run again with --force to replace it, or --print to see what would go there.`)
    return 1
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  say(`Added ${file}.`)
  say('VS Code picks it up in its next agent session. Agent hooks are a preview: if nothing is recorded, check they are on in VS Code\'s settings.')
  say('Commit the file to share it with your team, or add it to .git/info/exclude to keep it to yourself.')
  say('For the premium requests in the status bar too: agentarium vscode --status-bar')
  return 0
}

function doc(): string {
  const text = readFileSync(SELF, 'utf8')
  const m = /\/\*\*\n([\s\S]*?)\*\//.exec(text)
  return m ? m[1].split('\n').map((l) => l.replace(/^ \* ?/, '').replace(/^ \*$/, '')).join('\n').trimEnd() : ''
}

function overview(): number {
  say(doc().split('\n\n')[0])
  say('')
  say(`  version      ${VERSION}`)
  for (const [cli, name] of [['claude', 'Claude Code'], ['copilot', 'Copilot CLI']]) say(`  ${name.padEnd(12)} ${has(cli) ? 'found' : 'not found'}`)
  const status = spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, 'statusline.ts'), '--status'], { encoding: 'utf8' })
  for (const line of String(status.stdout ?? '').split('\n')) if (line.trim()) say(`  ${line}`)   // in line with the rows around it
  const db = defaultDbPath()
  say(`  data         ${existsSync(db) ? db : 'nothing recorded yet'}`)
  if (statusline.tokenomicsPluginOn()) say('  tokenomics   still installed, so every prompt is checked twice: claude plugin uninstall tokenomics@tokenomics')
  else if (importer.found() && !importer.imported()) say(`  tokenomics   its history is in ${importer.tokenomicsHome()}: agentarium import brings it over`)
  for (const line of controller.latencyLines(controller.latency(db))) say(line)
  say('')
  say('Commands: dashboard [--demo] · report · bang-for-buck · waistline · sherlock · taste-test · haggle · spring-clean · groundhog')
  say('          split-the-bill · bazaar · blinkers · crystal-ball · deadwood · pack-light · ballast · waffle')
  say('          cold-snap · parrot · all-you-can-eat · fishingrod · cache-buster · too-many-cooks · diet sizes · colander')
  say('          receipt · dry-run · rate-my-prompt (judge)')
  say('          statusline · router (on · off · status · learn · eval) · profile · audit · doggybag · vscode')
  say('          update · uninstall · setup · import')
  return 0
}

/** name -> [script, its subcommands, what to run when none is given]. */
const TOOLS: Record<string, [string, string[], string[]]> = {
  'bang-for-buck': ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  value: ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  waistline: ['waistline.ts', [], []],
  sherlock: ['sherlock.ts', [], []],
  'taste-test': ['tastetest.ts', ['history'], []],
  haggle: ['haggle.ts', ['quote', 'status'], ['status']],
  'spring-clean': ['springclean.ts', [], []],
  groundhog: ['groundhog.ts', ['check'], ['check']],
  'split-the-bill': ['splitthebill.ts', [], []],
  bazaar: ['bazaar.ts', ['quote', 'list'], []],
  blinkers: ['blinkers.ts', ['check', 'diff'], ['check']],
  'crystal-ball': ['crystalball.ts', [], []],
  deadwood: ['deadwood.ts', ['report', 'session', 'mark'], ['report']],
  'pack-light': ['packlight.ts', [], []],
  ballast: ['ballast.ts', ['check'], ['check']],
  waffle: ['waffle.ts', [], []],
  'cold-snap': ['coldsnap.ts', [], []],
  parrot: ['parrot.ts', ['report'], ['report']],
  'all-you-can-eat': ['allyoucaneat.ts', [], []],
  fishingrod: ['fishingrod.ts', [], []],
  'cache-buster': ['cachebuster.ts', ['check'], ['check']],
  'too-many-cooks': ['toomanycooks.ts', ['report'], ['report']],
  diet: ['diet.ts', ['sizes'], ['sizes']],
  colander: ['colander.ts', ['report', 'strain'], ['report']],
  receipt: ['receipt.ts', [], []],
  'dry-run': ['dryrun.ts', [], []],
  'rate-my-prompt': ['ratemyprompt.ts', [], []],
  judge: ['ratemyprompt.ts', [], []],
  // the signature features, by what they do
  'value-meter': ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  'agent-forensics': ['sherlock.ts', [], []],
  forensics: ['sherlock.ts', [], []],
  'quality-gate': ['tastetest.ts', ['history'], []],
  // and the rest, by what they do
  'cost-attribution': ['splitthebill.ts', [], []],
  'provider-arbitrage': ['bazaar.ts', ['quote', 'list'], []],
  'scope-guard': ['blinkers.ts', ['check', 'diff'], ['check']],
  'spend-simulator': ['crystalball.ts', [], []],
  'dead-work': ['deadwood.ts', ['report', 'session', 'mark'], ['report']],
  'fixed-overhead': ['packlight.ts', [], []],
  'context-carry': ['ballast.ts', ['check'], ['check']],
  'output-audit': ['waffle.ts', [], []],
  'cache-misses': ['coldsnap.ts', [], []],
  'repeated-instructions': ['parrot.ts', ['report'], ['report']],
  'plan-fit': ['allyoucaneat.ts', [], []],
  lessons: ['fishingrod.ts', [], []],
  'leak-check': ['audit.ts', [], []],
}
// A hyphenated helper also answers to its name as one word, the way its script and setting spell
// it (bang-for-buck: bangforbuck.ts, AGENTARIUM_BANGFORBUCK). The descriptive names don't.
for (const [name, tool] of Object.entries(TOOLS)) {
  const one = name.replaceAll('-', '')
  if (one !== name && tool[0] === `${one}.ts`) TOOLS[one] ??= tool
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = '', ...rest] = argv
  if (cmd === '' || cmd === 'status' || cmd === 'doctor') return overview()
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    say(doc())
    return 0
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    say(`agentarium ${VERSION}`)
    return 0
  }
  if (cmd === 'setup') return setup(rest)
  if (cmd === 'update') return update(rest)
  if (cmd === 'uninstall') return uninstall(rest)
  if (cmd === 'dashboard') {
    const fg = rest.includes('--foreground')
    let args = rest.filter((a) => a !== '--foreground')
    if (!fg && !args.some((a) => ['--stop', '-h', '--help'].includes(a))) args = ['--background', ...args]
    return script('dashboard.ts', ...args)
  }
  if (cmd === 'report') return script('report.ts', ...rest)
  if (cmd === 'statusline') return script('statusline.ts', ...(rest.length ? rest : ['--status']))
  if (cmd === 'router' || cmd === 'sommelier') {
    if (!rest.length || !['serve', 'explain', 'env', 'on', 'off', 'status', 'learn', 'eval'].includes(rest[0])) {
      say('Usage: agentarium router on|off [--project] | status | learn [--dry-run] [--apply-tiers] | eval [--misses]\n' +
        '                         serve [--port N] | explain "prompt" | env [--port N]')
      return 2
    }
    return script('sommelier.ts', ...rest)
  }
  if (cmd === 'doggybag') return script('doggybag.ts', 'write', ...rest)
  if (cmd === 'import') return script('import.ts', ...rest)
  if (cmd === 'audit') return script('audit.ts', ...rest)
  if (cmd === 'copilot') return copilotCmd(rest)
  if (cmd === 'vscode') return vscodeCmd(rest)
  if (cmd === 'profile') return profileCmd(rest)
  if (cmd === 'colander' && rest[0] === 'strain') return piped('colander.ts', ...rest)
  const tool = Object.hasOwn(TOOLS, cmd) ? TOOLS[cmd] : undefined
  if (tool) {
    const [file, subs, fallback] = tool
    return script(file, ...(rest.length && subs.includes(rest[0]) ? rest : [...fallback, ...rest]))
  }
  say(`Unknown command: ${cmd}. Run 'agentarium help'.`)
  return 2
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2))
