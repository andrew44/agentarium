// agentarium in VS Code's status bar: Copilot's premium requests (left this month,
// and the day they run out at this pace), with today's prompts and the forecast in the tooltip.
//
// Plain JavaScript, unlike the rest of agentarium: VS Code loads extensions in its own Electron
// build of Node.js, which can't be relied on to strip types. It only draws. The numbers come from
// scripts/statusline.ts --copilot --json, run with agentarium's own Node.js, so the status bar, the
// Copilot CLI status line and `agentarium copilot` always agree.
//
// Installed by `agentarium vscode --status-bar`, which writes the install's path in place of the
// placeholder below; `agentarium vscode --status-bar --remove` takes it out.
// Off with `agentarium statusline --band-off` or AGENTARIUM_BAND=off (statusline.ts decides).
'use strict'
const { execFile, spawn } = require('node:child_process')
const { readFileSync, statSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const vscode = require('vscode')

const ROOT = '${AGENTARIUM_ROOT}'
const TK = process.env.AGENTARIUM_HOME || join(homedir(), '.agentarium')
const DB = process.env.AGENTARIUM_DB || join(TK, 'till.db')
const CHECK_MS = 5000          // a stat of the database: a new prompt shows within 5s
const STALE_MS = 5 * 60_000    // re-read anyway, so the day and the pace roll over
const FLAGS = ['--disable-warning=ExperimentalWarning']

/** The Node.js the installer found (~/.agentarium/node), else `node` on PATH. */
function nodeBin() {
  try {
    const n = readFileSync(join(TK, 'node'), 'utf8').split(/\r?\n/)[0].trim()
    if (n) return n
  } catch {
    // not cached yet
  }
  return 'node'
}

function mtime() {
  try {
    return statSync(DB).mtimeMs
  } catch {
    return 0
  }
}

/** statusline.ts --copilot --json -> (error, numbers). Never throws. */
function read(done) {
  execFile(nodeBin(), [...FLAGS, join(ROOT, 'scripts', 'statusline.ts'), '--copilot', '--json'],
    { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return done(err.message || String(err), null)
      try {
        done(null, JSON.parse(String(stdout) || '{}'))
      } catch {
        done('statusline.ts gave no numbers', null)
      }
    })
}

/** Draw `status` (or the error) on the status bar item. */
function draw(item, err, status) {
  if (status && status.show === false) return item.hide()
  const md = new vscode.MarkdownString('', true)
  if (err || !status || !status.show) {
    item.text = '$(pulse) agentarium'
    item.backgroundColor = undefined
    md.appendMarkdown(`**agentarium** couldn't read the numbers: ${err || 'nothing returned'}\n\n` +
      'Check `agentarium statusline --status` in a terminal, or run `agentarium vscode --status-bar` again.')
  } else {
    item.text = `$(pulse) ${status.short}`
    item.backgroundColor = status.level === 'red' ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : status.level === 'yellow' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    md.appendMarkdown(`**agentarium** · Copilot\n\n${status.text}\n\n`)
    md.appendMarkdown(`Today: ${status.today.prompts} prompts, ${status.today.requests} premium requests\n\n`)
    if (status.hint) md.appendMarkdown(`${status.hint}\n\n`)
    md.appendMarkdown('Click for the dashboard.')
  }
  item.tooltip = md
  item.show()
}

function activate(context) {
  const item = vscode.window.createStatusBarItem('agentarium.status', vscode.StatusBarAlignment.Right, 100)
  item.name = 'agentarium: Copilot premium requests'
  item.command = 'agentarium.status.dashboard'
  let seen = -1
  let at = 0
  let busy = false
  const refresh = (force) => {
    const m = mtime()
    if (busy || (!force && m === seen && Date.now() - at < STALE_MS)) return
    busy = true
    seen = m
    at = Date.now()
    read((err, status) => {
      busy = false
      draw(item, err, status)
    })
  }
  const timer = setInterval(() => refresh(false), CHECK_MS)
  context.subscriptions.push(item, { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('agentarium.status.refresh', () => refresh(true)),
    vscode.commands.registerCommand('agentarium.status.dashboard', () => {
      try {
        spawn(nodeBin(), [...FLAGS, join(ROOT, 'scripts', 'cli.ts'), 'dashboard'], { detached: true, stdio: 'ignore', windowsHide: true })
          .on('error', () => {}).unref()
      } catch {
        // the tooltip still has the numbers
      }
    }))
  refresh(true)
}

function deactivate() {}

module.exports = { activate, deactivate, draw }
