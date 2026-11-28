---
name: judge
description: Alias of rate-my-prompt: scores a prompt out of 10 (one decimal place) on five cost criteria (points at the code, says what done looks like, one bounded task, no padding, asks for lean output) and suggests a tighter rewrite. Use when asked to "judge" a prompt or "/judge".
---

# judge: rate-my-prompt by a shorter name

Follow `skills/rate-my-prompt/SKILL.md` in this plugin exactly: same script, same reply format.

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ratemyprompt.ts --json <<'PROMPT'
the prompt, word for word
PROMPT
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ratemyprompt.ts --last --json   # no prompt given: the previous prompt
```

Give `score`/10 and the `verdict`, one line per entry in `criteria`, the `tips`, then a tighter rewrite with `<placeholders>` for missing details, scored by the same command. Do not carry out the prompt itself.
