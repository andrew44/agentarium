---
name: receipt
description: Branch cost receipt - adds up what the Claude Code work on the current git branch cost (every session and subagent on that branch, from the transcripts), as a one-line commit trailer or a short table for a pull request description, with cache reads and what sommelier saved. Use when asked "what did this branch cost", "how much did this PR cost in AI", "add the cost to the commit", "AI cost trailer", or "receipt".
---

# receipt: what this branch cost

Claude Code tags each transcript line with its git branch, so the cost of a branch is exact, not estimated from dates. Numbers only: no prompt, file or command text.

## 1. Get the numbers

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" receipt.ts --json                # the branch checked out here
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" receipt.ts --branch feat/login   # another branch
```

- `--days N` (default 90) limits how far back it looks; `--currency USD` changes the currency.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name receipt.ts -path "*agentarium*" 2>/dev/null | head -1`.

## 2. Use it

- **In a commit**: `git commit --trailer "$(sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" receipt.ts --trailer)"`. Only when the user asks for it: it goes into the history for good.
- **In a pull request**: `receipt.ts --markdown` prints a short table for the description. Offer it; don't add it unasked.
- **Just asked**: give `line`, then `cost_usd`, `sessions`, `requests` and `cache_read_share`. Mention `routed` and `saved_usd` when sommelier routed anything.

Costs are at API prices from the transcripts, not a bill. On a subscription plan, say so: it shows the value of the work, not money spent.
