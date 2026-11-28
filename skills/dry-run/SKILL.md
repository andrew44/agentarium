---
name: dry-run
description: Install cost check - prices a skill, plugin or MCP server before it is installed: the tokens it adds to every request (skill listing lines, MCP tool definitions) and what that costs a month at the user's own pace, plus what each use of a skill loads. Use when asked "should I install this MCP server", "what will this plugin cost", "how heavy is this skill", "is this MCP server worth it", or "dry-run".
---

# dry-run: price it before you install it

Every installed skill adds a line to each request, and every MCP server its tool definitions. You price an addition before it goes in, from the script's numbers only.

## 1. Price it

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" dryrun.ts skill path/to/skill --json          # a SKILL.md or its folder
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" dryrun.ts plugin path/to/plugin --json        # every skill, command and agent
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" dryrun.ts mcp --tools tools.json --json       # a saved tools/list result
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" dryrun.ts mcp --json -- npx -y some-mcp-server # start it, list its tools, stop it
```

- `mcp --` runs the given command for at most 20 seconds. Ask the user before running a server they haven't run before, as you would before installing it.
- `--days N` (default 30) sets how much history the monthly figure is based on.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name dryrun.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `every_request_tokens` and `per_month_usd`, with the `basis` (requests and sessions it was priced against).
2. **The biggest items** for a plugin, and `per_use` for a skill (what loads each time it is used).
3. **Advice**: install it between sessions, not mid-session (the cache starts again). For an MCP server used rarely, suggest enabling it per project. `tokenomics pack-light` later shows whether it earned its place.
