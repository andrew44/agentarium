---
name: rate-my-prompt
description: Prompt score - rates a prompt out of 10 (one decimal place) on five cost criteria, 2 points each - points at the code, says what done looks like, one bounded task, no padding, asks for lean output - with the fix for each weak one and a tighter rewrite. Use when asked "rate my prompt", "score this prompt", "is this a good prompt", "how efficient is my prompt", "will this prompt be expensive", "judge", or "rate-my-prompt".
---

# rate-my-prompt: what will this prompt cost to carry out?

A vague prompt costs more than its own tokens: the agent searches for the code, guesses what done means, wanders into extra work and writes long replies. You score the prompt from the script's numbers only, then show a tighter version.

## 1. Score it

The prompt to rate is the text the user gave with the request. Pass it on stdin so quotes and backticks survive:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ratemyprompt.ts --json <<'PROMPT'
the prompt, word for word
PROMPT
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ratemyprompt.ts --last --json   # no prompt given: the user's previous prompt in this session
```

- Read-only. The prompt is scored in memory and never stored.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name ratemyprompt.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `score`/10 and the `verdict`. Never change the score: it comes from the script.
2. **Breakdown**: one line per entry in `criteria`: `label`, `score`/2 and what was `found`.
3. **Fixes**: the `tips`, weakest first.
4. **Rewrite**: a tighter version of the prompt that keeps the user's intent. Invent no file names or facts: where a detail is missing, leave a `<placeholder>` (`<file>`, `<expected result>`). Score the rewrite with the same command and give its score next to the original.

Keep it short. Do not carry out the prompt itself.
