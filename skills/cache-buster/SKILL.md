---
name: cache-buster
description: Prefix-edit guard - lists every edit in a session to files at the start of each request (CLAUDE.md and the files it imports, settings, MCP server lists, skills, commands and agents), priced as the cache rebuild each one causes, and explains the cache-buster hook that catches them before the edit. Use when asked "does editing CLAUDE.md cost anything", "why did my cache go cold after an edit", "is it safe to change settings mid-session", "prefix change", or "cache-buster".
---

# cache-buster: edits that make the cache start again

The prompt cache keys on the start of each request. Changing an instruction file, a setting, the MCP server list or a skill mid-session means the next request that picks it up writes the whole conversation to the cache again. You report those edits from the script's numbers only.

## 1. Check

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" cachebuster.ts check --json     # newest session in this folder
```

- `--session <id>` or `--transcript <file>` for another session. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name cachebuster.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: how many `edits` and `total_usd` ("up to about": several edits picked up by one request cost one rebuild).
2. **Each edit**: the `path`, what part of the prefix it is (`kind`) and its `usd` at the context size it had (`ctx_tokens`).
3. **Fix**: make these edits at the end of a session, or just before `/clear`. `tokenomics cold-snap` shows the rebuilds that actually happened.

## 3. The hook (explain if asked)

Before an Edit or Write to one of these files, the hook prices the rebuild from the session's context size. Each file is raised once per session, and never below `TOKENOMICS_CACHEBUSTER_MIN_TOKENS` (10,000). `TOKENOMICS_CACHEBUSTER=warn` (default) tells the user; `ask` asks them to confirm; `block` refuses, and the agent leaves the change as a note; `off`. Never change instruction files or settings for the user mid-session to "fix" this: that is itself a prefix change.
