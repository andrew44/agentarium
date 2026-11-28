---
name: dashboard
description: Opens the agentarium dashboard, a local web page showing where tokens and money went (OPEX vs CAPEX, by project, by day, recent sessions) and what agentarium saved (what sommelier and each guard stopped, priced). Use when asked to open, show, start or stop the dashboard, for charts of token usage or spend, or to see what agentarium has saved.
argument-hint: "[demo|stop]"
allowed-tools: Bash(sh *run.sh dashboard.ts*), Bash(node *dashboard.ts*)
---

# dashboard

The script ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.ts`. It starts a small read-only web server on 127.0.0.1 in the background, opens the browser and returns straight away.

The user asked: `$ARGUMENTS` (empty means open the dashboard with their real data).

| The user wants... | Run |
|---|---|
| Open it (default) | `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" dashboard.ts --background` |
| A preview with sample data | `... --background --demo` |
| Stop it | `... --stop` |

The `run.sh` launcher finds a working Node.js 22.18+ on any OS (including Windows). If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins -name dashboard.ts -path "*agentarium*" 2>/dev/null | head -1`.

Reply in one sentence with the URL it printed. If it says there's no data yet, suggest `demo` for a preview: till fills it in as they work.
