---
name: statusline
description: Installs, updates, checks or removes the agentarium status line (live context fill, tokens, cost and a prompt-cache countdown at the bottom of Claude Code or Copilot CLI in a terminal), turns its row in the band (the same line, directly above the prompt box in the Claude desktop app and VS Code) on or off, and sets their currency or theme. Use when asked to install, set up, turn on, fix, remove or change the status line (statusline), status bar or band.
argument-hint: "[install|uninstall|status|preview|band on|band off] [claude|copilot|both]"
allowed-tools: Bash(sh *run.sh statusline.ts*), Bash(node *statusline.ts*)
---

# statusline

agentarium shows one live line (model, context fill, tokens, cost, cache countdown) in two places. Keep them apart when you talk to the user:

- **The status line**: the CLI's own status line at the bottom of Claude Code or Copilot CLI **in a terminal**. It is a `statusLine` entry in the CLI's `settings.json`, so it is installed and removed per CLI.
- **The band row**: the same line as agentarium's row in the band, the strip directly above the prompt box, in the **Claude desktop app** and VS Code (VS Code also pins it as the plugin's status line entry, under the prompt box). It comes with the plugin, on by default, whether or not the status line is installed, and is turned on or off here. For Copilot, `agentarium vscode --status-bar` puts premium requests left in VS Code's status bar and `agentarium copilot --window` opens them in a small window beside the GitHub Copilot app; the same switch hides both.

The script ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.ts`. Run it with Bash and report what it printed in one or two plain sentences. Do not edit settings files by hand.

The user asked: `$ARGUMENTS` (empty means install the status line for Claude Code).

## What to run

| The user wants... | Run |
|---|---|
| Install the status line (default) | `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" statusline.ts --install claude` |
| Install it for Copilot CLI, or both | `... --install copilot` or `... --install both` |
| Check what's on | `... --status` (the status line per CLI, and the band) |
| Remove the status line | `... --uninstall claude` (or `copilot` / `both`) |
| Hide or show the band in the desktop app | `... --band-off` / `... --band-on` |
| Hide or show the forecast row under the terminal status line | `... --outlook-off` / `... --outlook-on` |
| Preview what it looks like | `... --demo` (add `--theme light` or `--theme dark`) |
| Change currency (both) | `... --set-currency GBP` (or `USD`, `EUR`) |
| Refresh exchange rates | `... --update-rate` |

The `run.sh` launcher finds a working Node.js 22.18+ on any OS (including Windows). If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins ~/.copilot -name statusline.ts -path "*agentarium*" 2>/dev/null | head -1`.

If the user says "status bar" or "statusbar", they mean the status line in a terminal and the band row in the desktop app; ask which only if it changes what you run.

## Before installing the status line

Run `--status` first. If it reports **another status line** for that CLI, tell the user which command is set and ask before replacing it (`--install` overwrites it; a backup is saved as `settings.json.agentarium.bak`). The band doesn't need this: it shows in the desktop app either way.

## After installing

Tell the user to restart Claude Code (or Copilot CLI) in the terminal to see the status line. Mention that it updates itself whenever the plugin updates, that `/agentarium:statusline uninstall` removes it, and that the desktop app has the band regardless (`/agentarium:statusline band off` hides it).
