---
name: too-many-cooks
description: Subagent cost guard: what subagents have cost (measured from their own transcripts, by type), how many were caught before they ran (overlapping briefs, single lookups, too many in one turn), and how the too-many-cooks hook works. Use when asked "what do subagents cost", "are my agents doing the same work", "too many subagents", "should I use a subagent for this" or "too-many-cooks".
---

# too-many-cooks: subagents worth sending

A subagent starts cold: it loads its own system prompt and tools and re-reads the files it needs. You report what subagents cost and which ones were not worth it, from the script's numbers only.

## 1. Measure

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" toomanycooks.ts report --days 30 --json
```

- `agents`: count, total and average cost per subagent type, measured at SubagentStop.
- `caught`: findings by rule (`overlap`, `lookup`, `fan_out`) and their estimated cost.
- For waste inside one finished session, `sherlock` has the overlapping and needless subagents, costed.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name toomanycooks.ts -path "*agentarium*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `subagents` and `total_usd` for the period, and the dearest type by average.
2. **Caught**: the rules that fired and how often.
3. **Habits**: one subagent per separate job; a Read or Grep in the main conversation for a single lookup; reuse an earlier subagent's result rather than sending another.

## 3. The hook (explain if asked)

Before a Task or Agent call it checks the brief against the subagents already sent in this session (half the words in common: `overlap`), whether it is a single lookup (`lookup`) and how many went out since the last prompt (`fan_out`, more than `AGENTARIUM_TOOMANYCOOKS_FANOUT`, default 5). Each rule speaks once per session. `AGENTARIUM_TOOMANYCOOKS=warn` (default), `ask`, `block` (the agent does the work itself) or `off`. Briefs are compared in memory and never stored.
