---
name: audit
description: One leak check across everything agentarium can measure - the fixed load every request carries (pack-light), output spend (waffle), cold caches (cold-snap), context carried between tasks (ballast), bloated instruction files (spring-clean), work that produced nothing (deadwood), loops (groundhog), repeated instructions (parrot) and cost per task trending up (waistline) - biggest money first. Use when asked "where am I wasting tokens", "audit my AI spend", "what should I clean up", "find the leaks", "token audit", or "audit".
---

# audit: where is it leaking?

pennywise, the band and the guard-rails stop spend as it happens. The audit finds what they can't: standing costs and habits. It runs every leak check, keeps the sections that found something, and orders them by money. Every number comes from the script.

## 1. Run it

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" audit.ts --days 30
```

- `--only pack-light,cold-snap` for some sections; `--json` for the raw results (each section's own JSON plus `money`, the biggest figure it found).
- Read-only. Sections with nothing to say are folded into one line at the end.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name audit.ts -path "*agentarium*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: the top two or three leaks, each with its money figure and the section it came from.
2. **One fix each**, the one that section recommends (remove an unused MCP server, move a repeated instruction into CLAUDE.md, reply before the cache goes cold, `/clear` between tasks, ...). Do only what the user approves.
3. **Where to dig**: name the helper for a deeper look (`agentarium pack-light`, `agentarium cold-snap` ...), or its own skill.

Never present an estimate as a bill. If every section is quiet, say there isn't enough history yet and suggest running it again after a few sessions.
