---
name: sommelier
description: The sommelier model router: explains why a prompt was routed (down to Haiku, up to Opus), what routing saved net of the hand-off, how well it routes (eval), what it has learned from routes that missed, and switches the per-request routing proxy on or off. Use when asked "why did this go to Haiku", "what has sommelier saved", "is the router any good", "turn on the router/proxy", "route more aggressively", "stop routing" or "sommelier".
---

# sommelier: the right model for every prompt

sommelier scores every prompt and sends it to the tier it needs. You explain its decisions and change its settings when asked. Every number comes from the script.

## Commands

```bash
R="${CLAUDE_PLUGIN_ROOT}/scripts/run.sh"
sh "$R" sommelier.ts status                 # proxy up?, hook or proxy, 30 days of savings (net of hand-offs)
sh "$R" sommelier.ts explain "the prompt"   # score, signals, tier, model
sh "$R" sommelier.ts eval --misses          # accuracy on the labelled prompts (data/sommelier-eval.json)
sh "$R" sommelier.ts learn --dry-run        # what the routes that held and missed would change
sh "$R" sommelier.ts on                     # the proxy: per-request routing, no hand-off (asks nothing; edits ~/.claude/settings.json)
sh "$R" sommelier.ts off                    # undo it
```

## How to answer

- **Why this model?** Run `explain` on the prompt and name the signals that decided it. Mention `keep-model:` (stay) and `haiku:` / `sonnet:` / `opus:` (force) for next time.
- **What did it save?** `status`. Savings are net of what the hand-off costs, and routes up are counted separately as what quality cost extra. They are estimates from list prices, not a bill.
- **Is it any good?** `eval`. "Routed too low" is the costly mistake; say how many.
- **Turn on the proxy** only when the user asks: it changes their Claude Code settings and needs a new session. Say `off` undoes it.
- **More or less aggressive:** suggest a profile (`agentarium profile frugal | balanced | quality`) rather than editing thresholds by hand.
