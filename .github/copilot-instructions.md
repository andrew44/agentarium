# agentarium: instructions for AI assistants

These rules apply to every change: code, comments, docs, commit messages and pull requests. Claude Code reads them through `CLAUDE.md`; Copilot reads this file directly.

## Writing

- **UK English** everywhere you write: optimise, behaviour, colour, analyse, licence (noun), catalogue, organisation. Leave external names as they are (`color` in CSS, API fields, package names).
- **No Oxford comma.** Write "tests, lint and build", not "tests, lint, and build".
- **No em-dashes or en-dashes as punctuation.** Use a colon, comma, brackets or a full stop. Hyphens in compound words are fine.
- **Helper and skill names:** lowercase. Hyphenate a name made of separate words (bang-for-buck, split-the-bill, crystal-ball, cold-snap); keep a single word as one (groundhog, deadwood, pennywise). Script files, settings and tables drop the hyphens (`bangforbuck.ts`, `AGENTARIUM_BANGFORBUCK`, `tastetest_runs`).
- **No AI slop.** Say what the thing does, plainly, with numbers where there are any. Match the voice already in the README and docs: short sentences, concrete examples, light humour in helper names only. Avoid:
  - filler words: delve, seamless, robust, leverage, comprehensive, cutting-edge, powerful, unlock, elevate, empower, streamline, game-changer
  - padding: "It's worth noting", "In today's fast-paced world", "Let's dive in", closing recaps that repeat the section
  - forced patterns: "not just X, but Y", lists of three for rhythm, rhetorical questions as headings
  - emoji beyond the ones the README already uses for its section headings and helper tables
- Comments say why, not what. No comment that restates the code.

## Keep the README current

Every change that someone using or contributing to agentarium could notice updates `README.md` in the same commit. That covers a helper, skill, hook, setting, command, profile, data file, dependency, supported Node.js version or the install steps. Check these too:

- `docs/reference.md` and `docs/skills-tools-and-hooks.md` for a helper or skill
- `docs/configuration.md` for a setting (`AGENTARIUM_*`)
- `docs/installation.md` for install or upgrade steps
- `docs/architecture.md` for the repo tree and how the parts fit
- `docs/strategy.md` when a roadmap item ships

If nothing needs changing, say so in the pull request rather than skipping the check.

## The code

- TypeScript run directly by Node.js 22.18+ (type stripping). No build step, no bundler and no runtime dependencies: Node built-ins only, SQLite from `node:sqlite`. Do not add an npm package to `dependencies`.
- `tsconfig.json` sets `erasableSyntaxOnly` and `verbatimModuleSyntax`: no enums, namespaces or constructor parameter properties; import local files with the `.ts` extension; mark type-only imports with `type`.
- Style: two-space indent, single quotes, no semicolons, `const` arrow helpers for one-liners. Follow the file you are editing.
- Each script starts with a doc comment giving its purpose, its usage lines and its `AGENTARIUM_*` settings. Keep it accurate when you change behaviour.

## Architecture rules

- Shared logic lives in `agentarium/engine/` or the matching service in `agentarium/services/` (cost, telemetry, outcome, policy, insights). Never write a Claude Code copy and a Copilot copy of the same feature.
- Adapters (`agentarium/adapters/`) only translate a platform's hook messages. No scoring or policy in them. Ask the capability registry before relying on a feature.
- Copilot premium requests are never converted to tokens or money.
- Hooks are registered in `hooks/hooks.json` and, where Copilot can support them, `copilot-hooks.json`. Always call them through `scripts/run.sh`, never `node` directly.
- A hook never blocks the user by crashing: it exits 0 and logs errors. Every guard has a `AGENTARIUM_<NAME>=off` switch and records what it did in a `<name>_events` table.
- Privacy: everything stays in `~/.agentarium/`. Never store prompt text, file contents or command text unless the user has opted in.
- `scripts/statusline.ts` must stay a single self-contained file: `--install` copies it on its own.
- Do not bump versions for a patch: the version workflow commits the bump to each pull request, and merging to `main` releases it. For a minor or major release, raise `version` in both `.claude-plugin/plugin.json` and `plugin.json`.

## Before you finish

```bash
npm test             # node:test, nothing to install
npm run typecheck    # needs npm install first
```

Add or update tests in `tests/*.test.ts` for any behaviour change; `tests/helpers.ts` has `useTemp`, `withEnv` and `runScript`.

Keep this file short. It is sent with every request, and `spring-clean` flags instruction files over 1,500 tokens.
