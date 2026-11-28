# agentarium

The shared rules for every AI assistant live in one file, so Claude and Copilot never drift apart:

@.github/copilot-instructions.md

## Claude Code only

- Edit the shared file above, not this one, for any rule that applies to Copilot as well.
- This repo is also a Claude Code plugin (`.claude-plugin/`). Test the band and the pane with `claude plugin test .`: every test in `tests/*.test.tsx` should pass. It also tries the node:test files and lists them as not loading; that's expected, `npm test` runs those.
- Changing this file or the shared one changes the prompt prefix, so the next request rebuilds the cache. Make instruction edits at the end of a session.
