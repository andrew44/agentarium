<p align="right"><a href="README.md">← Back to the docs</a></p>

# Product strategy

> **agentarium prevents future spend, it doesn't just report past spend.** Every other choice in this
> document follows from that.

Most AI cost tools are receipts: they tell you what you already paid. By the time a receipt says the
lockfile read cost £0.40, the cache rebuild cost £0.71 and the hello-world ran on Opus, the money has
gone. agentarium is built around the moment *before* the spend: the prompt you're about to send, the
tool call the agent is about to make, the cache that is about to go cold, the budget that is about to
run out. Reports still matter, but their job is to tune prevention, not to be the product.

Three decisions put that into practice, plus one asset we keep on purpose.

---

## 1. Automated prevention is the USP

**agentarium optimises the economics of the whole AI coding session**, not one request and not the
monthly bill. It steps in automatically at each point in a session where money is about to be spent,
and it says what it did and why, with a one-step override every time.

| Moment in the session | What's about to cost you | What steps in, automatically |
|---|---|---|
| Before a prompt is sent | The wrong model; a budget about to run out; a whole log pasted in; a new task dragging the last one's context; a task with no agreed price | **sommelier** (routes to the right model, harder as the budget runs down) · budget · hold-up · ballast · haggle · parrot |
| Before a tool call runs | A context flood; a loop; work nobody asked for; a task over its price | diet · groundhog · blinkers · haggle |
| Between turns | A cache about to go cold; a context filling up | **the band** (forecast, budget left, cache risk, the saving to make) · doggybag |
| After the work | Proving the prevention didn't cost quality | bang-for-buck · taste-test · waistline · sherlock |

**The test for any new feature:** *does it change what the next step costs, automatically or with one
action the user can take right now?* If it only describes what the last step cost, it belongs in a
report, and the report should end in a change to a guard-rail, a setting or a habit.

Rules that keep prevention trustworthy:

- **Never in the way.** Every guard-rail has a one-step override (`keep-model:`, `over-budget:`,
  `# diet-ok`, sending the same prompt again) and a `warn` / `off` switch. Hooks fail silently.
- **Priced, not preached.** Every intervention says what it saves, in the user's currency.
- **Quality is a gate, not an afterthought.** A saving that broke tests is not a saving (taste-test).

## 2. sommelier is the flagship

sommelier is the one helper that changes the price of *every* prompt without the user doing anything.
It sits at the most valuable decision point in a session (which model does this work?) and it already
works in both directions: down to save money, up when a prompt needs more. That makes it the clearest
demonstration of the USP, so it leads the README, the docs and the roadmap.

What sommelier does now:

- **Routes every prompt** to the tier it needs (Haiku / Sonnet / Opus / Fable), as a hook (nothing to
  set up) or as a per-request routing proxy (cache-aware, with fallback), which `agentarium router on`
  starts in the background and points Claude Code at.
- **Only routes when it pays.** Every route is priced net of the hand-off (the session's model still
  reads the conversation to pass the task on and relay the answer); a route down that the hand-off
  would eat isn't taken. What it saved, net, shows on the status line, the band and the weekly report,
  and the routed subagent's real cost is measured from the transcript beside the estimate.
- **Spends to the budget**, in the hook and the proxy. Once a daily or session budget passes its
  warning share, sommelier routes down harder (every tier threshold rises) and stops routing up, so
  the budget lasts instead of hitting budget's hard pause mid-task. Forced models (`opus:`) still win.
- **Backs off and learns.** "That didn't work" after a routed answer, or the evidence (a failing test,
  a revert, groundhog tripping), sends the next prompt back up.
  Misses and `keep-model:` overrides move each tier's threshold (bounded) at every session end, per
  project once a repository has enough routes, and
  bang-for-buck's cost per *successful* result suggests tier swaps. `router eval` scores the routing on
  a labelled set (38 of 42 on the right tier, 2 too low).
- **Decides with the others.** One controller runs sommelier, budget, haggle and the guard-rails in
  one process per prompt: one decision, one message.

Its roadmap, and the rest of the product's, is in the [roadmap](#roadmap) at the end.

## 3. The band looks forward

The band stays, and it changes job: from a meter of what has been spent to a forecast of what is
about to be spent and what to do about it. Its defining features:

| | What it shows | Why it prevents spend |
|---|---|---|
| **Cost forecast** | What the next 10 steps will cost at this context size and pace | The cost of carrying on, before you carry on |
| **Budget remaining** | What's left of the tightest of the daily and session budgets and haggle's agreed price for the task, and about how many steps it buys | "4 steps left" changes behaviour; "£4.71 spent" doesn't |
| **Cache risk** | What a cold cache adds to the next prompt, next to the countdown; once cold, what the next prompt will pay | Turns the countdown into a price |
| **Recommended saving** | The single change that saves most over the forecast, priced: reply before the cache goes cold, `/clear` a cold conversation (doggybag keeps the notes), `/compact` a full one, or a cheaper model when the budget won't last | One action, now, with its value |

The original line (model, context, tokens, spent, cache countdown) stays above it. VS Code's status
line and the after-reply message (where mods can't run) carry the same outlook. All of it is
arithmetic on the session's own figures: no model call, nothing stored.

Since then: the outlook is the terminal status line's second row, and both show what sommelier saved
this session, net of its hand-offs. Next for the band is in the [roadmap](#roadmap).

## Copilot compatibility is a strategic asset

agentarium already runs on Claude Code and GitHub Copilot CLI, through one engine and one event
format with a small adapter per assistant. We keep it that way on purpose: teams rarely use one
assistant, and prevention that only works in one of them is a policy with a hole in it.

We're honest about the differences rather than pretending they don't exist:

- **What prevents spend on Copilot today:** diet, groundhog, blinkers, doggybag, till and the
  status line, with a premium-request forecast: requests left this month, the pace, the day they run
  out, and what the next prompts use (`AGENTARIUM_COPILOT_ALLOWANCE`, `agentarium copilot`), each
  prompt counted at its own model's multiplier when Copilot's session state names the model.
- **What can't yet:** Copilot ignores hook output on prompt submit, so sommelier's hook routing,
  budget's pause and haggle's quote are Claude Code only. Its prompt hook already runs through the
  controller, and the premium-request guard is ready to pause the day Copilot honours the output.
  Copilot's hook reference (read 23 November 2026) still says `modifiedPrompt` is honoured only by SDK
  programmatic hooks and that command and HTTP hooks have their output dropped. Its new
  `userPromptTransformed` event can rewrite what the model reads but can't block, so a pause is still
  out of reach: see [the retest](#copilots-prompt-hooks-retested). Copilot bills premium requests, not
  tokens, so its usage is counted but never turned into money.

Every new helper is written against the shared services first, so the Copilot version is a question of
what the assistant can report, never a second implementation.

---

## Roadmap

### ✅ Done

| | What | Where it lives |
|---|---|---|
| ✅ | **The proxy spends to the budget too.** Squeezed thresholds and no routing up, as in the hook. | `sommelier.ts` `Router.decide` |
| ✅ | **The outlook on the terminal status line**, as a second row. | `statusline.ts` `renderOutlook` |
| ✅ | **sommelier's savings, net of the hand-off.** Every route is priced (stay − hand-off − routed); a route down the hand-off would eat isn't taken; savings are logged per route and shown on the status line, the band, `router status` and the weekly report. Routes up are counted as what quality cost, never as savings. | `estimateHandoff`, `estimateRequest`, `sommelier_events.saved_usd` |
| ✅ | **Cache- and context-aware hook routing** (part one). The hook reads the session's context size from the transcript, so the hand-off's price, and the decision, scale with it. | `lastTurn`, `estimateHandoff` |
| ✅ | **The proxy as the recommended way to run.** `agentarium router on / off / status`: the proxy in the background, Claude Code pointed at it, restarted by a SessionStart hook when it's down. | `startBackground`, `setProxyEnv`, `ensure` |
| ✅ | **One session controller.** The eight prompt-time helpers run in one process, in decision order; the first pause decides alone, otherwise one message. | `controller.ts` |
| ✅ | **Route by outcome.** Escalations and `keep-model:` overrides tune the tier thresholds (bounded, at every session end); bang-for-buck's cost per successful result suggests tier swaps (`--apply-tiers`). | `learn`, `sommelier_learned.json` |
| ✅ | **A labelled evaluation set**, and a better scorer from it: 69% → 90% on the right tier, "routed too low" 12 → 2. | `data/sommelier-eval.json`, `router eval` |
| ✅ | **Move back up when a routed answer didn't land** (hook: the session's model; proxy: one tier up). | `FAILED_RE`, `ESCALATE_WINDOW` |
| ✅ | **Profiles and one config file.** `frugal` / `balanced` / `quality`, and `~/.agentarium/config.json` for your own defaults; env > file > profile. | `agentarium/profile.ts`, `agentarium profile` |
| ✅ | **Fewer things to learn.** Three groups (prevent, look forward, prove and audit) and one `audit` that runs every leak check, biggest money first. | `audit.ts`, the README |
| ✅ | **Copilot: a premium-request budget and forecast** on the status line and `agentarium copilot`. | `premiumOutlook`, `renderPremium` |
| ✅ | **Measured, not just estimated, savings.** The next prompt reads what the routed subagent really used from the transcript and logs it beside the estimate; `router status` shows both; `learn` calibrates the task shape (`WORK`) from the measured routes. | `measureSidechain`, `work()`, `measuredSummary` |
| ✅ | **Cache-aware hook routing** (part two). The hook prices the hand-off with the session's cache: cold, both sides pay the context re-write (so it's priced, but it doesn't change whether a route pays: the Agent call re-writes it too); warm, a routed task that outlasts the cache costs the relay a re-write, which stops big-context routes down. | `cacheState`, `estimateHandoff(…, cache)` |
| ✅ | **Escalate on evidence, not only words.** A routed-down answer that ended on a failing check, was reverted or refused, or tripped groundhog counts as a miss in the hook; in the proxy's tool loop, two failing checks in a row, a revert or a groundhog refusal moves up one tier mid-loop. | `missEvidence`, `loopEvidence` |
| ✅ | **Learning per project.** Routes are logged with the repository's name; a project with enough routes in a tier gets its own offset (a 0 included), the rest fall back to the global ones. | `learn` (`projects`), `loadConfig(project)` |
| ✅ | **haggle's agreed price as a budget.** An open contract's cap is a budget the band's forecast counts down against ("£0.80 of £2.00 left this task, ~3 steps") when it's the tightest. | `taskContractUsd`, `budgetLeft(…, task)` |
| ✅ | **The controller on Copilot too.** One process for Copilot's prompt hook (till, premium, doggybag, blinkers), and a premium-request guard that pauses once the allowance is used up as soon as the adapter reports Copilot honours prompt-hook output; until then it records `would-pause`. | `COPILOT_STEPS`, `premium.ts`, `Capability.PROMPT_DECISION` |
| ✅ | **Profiles per project and per phase.** `"projects"` in config.json picks a profile by folder (longest prefix wins); with `budget_profile` set, the budget hook marks a day past its warning share and that profile applies for the rest of it. | `projectProfile`, `inBudgetPhase`, `budget.markPhase` |
| ✅ | **A growing evaluation set.** Each escalation and `keep-model:` is kept as a labelled case (hash and score; the text only with `AGENTARIUM_SOMMELIER_EVAL=text`); `router eval --mine` scores them; `router eval --check` fails CI on a scorer regression. | `addCase`, `sommelier_eval.json`, `tests.yml` |
| ✅ | **Copilot model multipliers.** The Copilot adapter reads the session's model from Copilot's session state (or config) when it's there; each prompt is recorded at that model's multiplier (`AGENTARIUM_COPILOT_MULTIPLIERS`, your figures: GitHub lists them per plan) and the forecast adds them up. | `sessionModel`, `engine/premium.ts`, `copilotUsage` |
| ✅ | **Copilot Fusion routing.** When the pick is Copilot Fusion, the adapter reports the model Fusion routed to and Fusion as the router; the prompt counts at the routed model's multiplier and the status line shows `Copilot Fusion → <model>`. | `sessionRoute`, `telemetry_events.router`, `copilotRoute` |
| ✅ | **Copilot in VS Code.** A `vscode` adapter for VS Code's agent hooks (preview): prompts and tool calls recorded, diet, groundhog and blinkers on tool calls, and the premium guard, which can pause there. `agentarium vscode` installs the hooks into a workspace. | `adapters/vscode.ts`, `vscode-hooks.json`, `premiumBilled` |
| ✅ | **The pane.** The band row's numbers beside the transcript in three tabs (Now, Ahead, Advice), the advice listed in full, most urgent first; a glance when minimised. | `hooks/pane.tsx`, `advise` |
| ✅ | **Controller latency in `agentarium doctor`.** The controller times each prompt-time helper (`controller_events`); `doctor` shows each one's median and p90 and flags one that slows every prompt. | `latency`, `latencyLines` |
| ✅ | **Every Claude Code hook event in use.** `PostToolUse` (diet learns what each program prints), `SubagentStop` (each subagent's real cost), `PreCompact` (doggybag before compaction) and `Notification` (kettle: time left on the cache). Two new guards catch spend before it happens: cache-buster (an instruction-file edit mid-session) and too-many-cooks (a subagent not worth sending). | `cachebuster.ts`, `toomanycooks.ts`, `kettle.ts`, `engine/prefix.ts` |
| ✅ | **A guard on pasted logs.** hold-up pauses a prompt of 10,000 tokens or more before it joins the conversation, says whether it's a log, data, an encoded blob, a diff, source code, a document or other text, prices carrying it and suggests pointing the agent at the file instead. It also pauses a short prompt that is blatantly too broad ("refactor the whole codebase") with nothing named to start from. Claude Code and VS Code. | `holdup.ts`, `engine/holdup.ts` |
| ✅ | **Cost before and after the work.** dry-run prices a skill, plugin or MCP server before it's installed; receipt puts what a branch cost into a commit trailer or a pull request. | `dryrun.ts`, `receipt.ts` |
| ✅ | **Run, then trim.** colander strains the output of a successful test run, build, lint or install before the model reads it (passing tests, progress bars and install chatter out; summaries, warnings and failures in), and saves the full output for the agent to grep. No retry, unlike a deny. The first helper to rewrite a tool's result, on Claude Code (`updatedToolOutput`) and Copilot CLI (`modifiedResult`). | `colander.ts`, `engine/colander.ts`, `replaceOutput` |
| ✅ | **A prompt judged before it is sent.** rate-my-prompt (alias judge) scores a prompt out of 10 on five cost criteria and suggests a tighter one. | `ratemyprompt.ts`, `engine/promptscore.ts` |

### Next, in order

Each item is tested against the rule at the top: does it change what the next step costs?

#### More AI environments

Goal: prevention that works in whichever editor or agent a team uses, so switching tools doesn't mean losing sight of spend. It extends the current shape (one engine, a small adapter per platform) and does not copy features per platform. Tracked in [#4](https://github.com/andrew44/agentarium/issues/4).

| | What | Notes |
|---|---|---|
| ⬜ | **A standard adapter interface**, with each adapter's supported capabilities documented and detected at run time. | Designed: see [the adapter interface](#the-adapter-interface) below. Features degrade when a platform doesn't expose them. Claude Code and Copilot CLI keep working unchanged. |
| ⬜ | **A generic provider integration.** Usage from provider APIs and telemetry, OpenAI-compatible endpoints, local usage logs, gateways or proxies, and imported usage and cost reports. | Designed: see [the generic provider layer](#the-generic-provider-layer) below. It is the way in for JetBrains AI Assistant (no hooks) and for sommelier on any tool with no prompt hook, such as Cline. It builds on the existing proxy, so it is the `proxy_endpoint` capability made real. |
| ⬜ | **Unified cost reporting** across platforms: spend by model, provider, project and session, cumulative spend, and actual and estimated savings per tool. | Designed: see [unified cost reporting](#unified-cost-reporting) below. Every figure is labelled measured, reported or estimated. No exact token counts or savings are claimed where a platform doesn't expose enough data. |
| ⬜ | **Priority 1 adapters, in this order:** Codex CLI, then Junie CLI (flagged Early Access), then Cursor at `partial`. | Re-scored against the vendors' docs on 22 November 2026: see [the candidates](#scoring-the-priority-1-candidates). Codex and Junie both use Claude-shaped command hooks, so they share a base class. Codex is designed: see [the Codex CLI adapter](#the-codex-cli-adapter). Its usage comes per request from `PostModelRequest`, and its money waits for OpenAI prices. Junie CLI is designed: see [the Junie CLI adapter](#the-junie-cli-adapter). Its hooks carry no usage, so its money comes through a custom model profile pointed at the router. Cursor is designed: see [the Cursor adapter](#the-cursor-adapter). It moves ahead of Codex for one piece: Cursor already runs agentarium's Claude Code hooks, mislabelled. |
| ⬜ | **A TypeScript plugin shim** for tools whose hooks are in-process plugins: Cline first, then Kilo Code and OpenCode. | Designed: see [the plugin shim](#the-plugin-shim) below. Cline's command hooks are gone: its hooks are now SDK plugin hooks. One small plugin forwards events to `scripts/run.sh`. It has tool decisions, context, usage and result rewrites; `beforeRun` may serve as its prompt hook, to be confirmed. |
| ⬜ | **Priority 2 adapters:** Gemini CLI (which also covers Gemini Code Assist's agent mode), Kiro CLI (which also covers Amazon Q Developer CLI), Google Antigravity, Windsurf / Devin Desktop, OpenCode (via the shim), Aider (an importer) and Zed (no adapter). | Scored on 23 November 2026: see [the Priority 2 candidates](#scoring-the-priority-2-candidates). Nine names are seven pieces of work, and only four are adapters. |
| ⬜ | **Priority 3, browser-based builders:** Replit Agent, Bolt.new, Lovable and Vercel v0. | Researched: see [the browser builders](#the-browser-builders) below. None of them gets an adapter. v0 gets a usage importer and a metered upstream, the rest get a page saying what agentarium can and can't do there. |
| ✅ | **The GitHub Copilot app** (desktop, technical preview). | Built on Copilot CLI and installs the same plugin, so it runs on the `copilot` adapter (alias `copilot-app`). A separate adapter waits until GitHub documents app-specific hook payloads ([#28](https://github.com/andrew44/agentarium/issues/28)). |
| ✅ | **Copilot's live numbers** in VS Code and the Copilot app. | Neither runs mods or draws a status line, so the band's job is done by a VS Code status bar item (`agentarium vscode --status-bar`, a small extension in `vscode/`) and a small window beside the app (`agentarium copilot --window`), both from `statusline.ts --copilot --json`: premium requests left, the pace and when they run out. |
| ⬜ | **Retest Copilot's prompt hooks.** Its docs add a `userPromptTransformed` event that can rewrite what the model receives. | Docs re-read on 23 November 2026: see [the retest](#copilots-prompt-hooks-retested). The new event can't block, so budget's pause and the premium guard stay `would-pause`, but it gives Copilot context injection, and two other events change more. Needs one real install to close. |

Where a platform allows it, each adapter aims to offer the same prevention as today: spend tracking, model recommendations and routing, context and cache warnings, a status line and session hand-offs (including across tools where practical). Prompts and source code stay out of telemetry unless the user opts in. Each integration gets its own installation, configuration and limitations page.

#### The adapter interface

*Design for the first item above, drafted from the code as it stands and revised after the vendor-docs check (22 November 2026).*

**What's already there.** Most of the interface exists. `agentarium/platform/adapter.ts` is the base class
both adapters extend: translation methods (`sessionId`, `lifecycle`, `toolCall`, `sessionEvidence`,
`sessionModel`), hook-output builders that return `null` when a platform can't express them (`denyTool`,
`blockPrompt`, `addContext` and four more), and 14 capabilities declared as `native`, `partial` or `none`
with a note. The registry loads each adapter on its own and falls back to `GenericAdapter` if one fails,
and `till.ts capabilities` prints the lot as JSON. So the work is closing five gaps, not a rewrite.

**The gaps.**

1. **Declared, not detected.** Capabilities are a fixed table per adapter. The roadmap already depends
   on detection: the premium guard waits for Copilot to honour prompt-hook output, and today that
   needs a code change to the table. A new platform's hook payloads vary by version even more.
2. **Few callers ask.** Only 5 places in `scripts/` and `agentarium/` call `supports(...)` (transcript
   twice, token usage, tool events and prompt decision). The rest rely on a builder returning `null`,
   which works but leaves no record of what was skipped and why.
3. **Capabilities a new platform needs are missing.** Nothing says whether a platform has a status line,
   can be pointed at a proxy (the route in for sommelier on tools with no prompt hook), can deny a tool
   call before it runs (today folded into `tool_output_interception`), or reports cost itself rather than
   tokens.
4. **Documented only as JSON.** There's no capability table in the docs, and no test that holds a new
   adapter to the same contract as the two we have.
5. **Trust and failure modes aren't modelled.** The vendors' docs show that "has hooks" hides three
   things. Codex skips a hook until the user has reviewed it (trusted by hash, changed hooks re-prompt).
   Cursor, Cline and Junie let a hook that crashes or times out through unless told otherwise
   (`failClosed`, `hookErrorMode`, `blockOnError`). Timeouts run from 3 seconds (Cline) to 10 (Junie
   prompt and tool hooks) to 600 (Codex). A guard that is installed but silently skipped looks the same
   as a guard that never fired.

**The design.**

- **Two layers of support: declared and observed.** The adapter keeps its static table as the floor. A
  new `observe(payload)` method on the base class raises a capability for this payload when the evidence
  is there: a `transcript_path` that exists lifts `transcript`; `usage` on a message lifts `token_usage`;
  a model id lifts `model_selection`. It never lowers a declared `native`. Observations are counted in a
  small `capability_events` table (platform, capability, level, platform version when known, first and
  last seen; no payload content), so `doctor` can say "Copilot 1.4 started sending usage on 3 Dec".
- **Prompt decision is confirmed, not assumed.** Whether a platform honours prompt-hook output can't be
  seen from the payload. The adapter declares it per platform version (Copilot's CLI version, read the way
  `sessionModel` reads session state) with `AGENTARIUM_<PLATFORM>_CAPS` as a user override, for example
  `AGENTARIUM_COPILOT_CAPS=prompt_decision:native`. The premium guard then flips on with no release.
- **Four new capabilities:** `statusline` (a command-driven status line), `proxy_endpoint` (the tool can
  use a custom base URL, so the router can sit in front of it), `tool_decision` (a pre-tool hook can deny
  or ask) and `reported_cost` (the platform states money or credits itself). `tool_output_interception`
  goes back to meaning only "can rewrite a tool's result".
- **Every guard asks first and records the skip.** A helper that needs a capability calls one shared
  `need(adapter, cap, helper)` in the controller. On `none` it returns early and records `skipped` with
  the capability in that helper's `<name>_events` table once per session. `doctor` lists the helpers each
  platform runs, partly runs and can't run, which is the honest answer to "does agentarium work in X?".
- **A provenance label on every figure.** `SessionEvidence` gains a `source` for usage and cost:
  `measured` (from a transcript or proxy), `reported` (the platform's own number) or `estimated` (from
  prompt and tool counts). The unified report in the third item depends on it, so it lands here first.
- **Hook safety facts per platform.** Each adapter declares its hook timeout, its failure mode and
  whether a hook needs trust. `doctor` shows them beside the capability list and warns when a helper's
  p90 latency is near the timeout, or when the install is waiting for review (Codex `/hooks`) or sits
  in a project file the platform ignores.
- **A contract test per adapter.** `tests/adapter_contract.test.ts` runs every registered adapter through
  the same fixtures: each lifecycle event maps to one of the six shared events, every capability is
  declared (an undeclared one fails, so a new capability can't be silently `none`), hook builders return
  `null` exactly where the table says `none`, and no evidence field holds prompt text unless
  `AGENTARIUM_STORE_PROMPT` is on. A new adapter is done when it passes this file.
- **Generated docs.** `till.ts capabilities --markdown` writes the platform-by-capability table
  into `docs/architecture.md` between markers, and a test fails if the table and the code disagree. Each
  integration's limitations page links to its column.

**Order of work**, each a pull request that keeps Claude Code and Copilot behaving exactly as now:
the four new capabilities and the contract test; `observe` and `capability_events`; `need()` and the
`doctor` coverage list with the hook safety facts; the provenance label; the generated table. The first new adapter (see below)
should be written against the contract test before any of its features.

**Picking the first new adapter.** The contract makes the Priority 1 choice a scoring exercise. For each
candidate, before writing code, fill in its column of the capability table from its published hook and
extension docs, then rank by what agentarium could *prevent* there, not just record: `prompt_decision`
and `tool_decision` first (guards can act), then `token_usage` or `proxy_endpoint` (sommelier and the
band have figures), then `transcript`. That research is below.

**New ideas from this pass.**

- `proxy_endpoint` may matter more than hooks for the long tail. Any tool that takes an OpenAI- or
  Anthropic-compatible base URL could get measured usage and routing from `agentarium router` with no
  adapter at all, which overlaps with the generic provider item and could be the same piece of work.
- Detected capabilities give a cheap compatibility signal for users: `doctor` can say "this version of
  your assistant gives agentarium 9 of 18 capabilities" and name what an upgrade would add.

#### Scoring the Priority 1 candidates

*Re-read against the vendors' own pages on 22 November 2026.* The first pass (same day) worked from search
results because the doc pages couldn't be fetched. This pass fetched the hook, plugin and provider pages
for Codex, Cline, Cursor, Junie, JetBrains AI Assistant and Copilot. Cells marked † were not re-checked:
they carry over from the first pass and need a real install. Kilo Code's docs URL returned a 404, so its
column is entirely †. Columns use the four new capabilities from the design: ✅ native, ◐ partial or
unreliable, ✗ none, ? not found in the docs.

| Capability | Codex CLI | Cline | Cursor | Junie CLI | Kilo Code | JetBrains AI Assistant |
|---|---|---|---|---|---|---|
| `hooks` | ✅ command hooks in `hooks.json` or `config.toml`, on by default (`[features].hooks`; `codex_hooks` is a deprecated alias); each hook must be reviewed and trusted by hash before it runs; `SessionEnd` times out after 1 s | ◐ SDK plugin hooks in TypeScript (`beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`), not command hooks; 3 s timeout, fail open by default | ✅ `hooks.json` (project, user, enterprise); project hooks need a trusted workspace | ◐ `hooks` in `~/.junie/config.json`, Early Access only | † ◐ in-process TypeScript plugins (OpenCode's API), not command hooks | ✗ |
| `prompt_decision` | ✅ `UserPromptSubmit` | ◐ no prompt-submit hook; `beforeRun` can stop a run or add context | † ◐ `beforeSubmitPrompt` can stop a prompt, but reports say it doesn't wait for a hook that takes over about 1 s, and the CLI skips it | ✅ `UserPromptSubmit` can add context, log or block the prompt | † ? | ✗ |
| `tool_decision` | ✅ `PreToolUse` deny, plus `PermissionRequest` | ✅ `beforeTool` returns `skip` and a reason, or a policy that requires approval | ◐ `preToolUse` and `beforeShellExecution` allow, deny or ask; fails open unless `failClosed` is set; † the CLI fires only the shell hooks | ✅ `PreToolUse` allow, ask or deny, can replace the input; `PermissionRequest`; exit code 2 blocks; `blockOnError` fails closed | † ✅ `tool.execute.before` can throw (reported to miss subagent calls) | ✗ |
| `context_injection` | ✅ `additionalContext`, with a size limit that spills to disk | ✅ `appendContext` on `beforeRun`, `beforeTool` and `afterTool` | † ◐ messages back to the agent, with regressions reported | ✅ `additionalContext` on `UserPromptSubmit` and `PreToolUse`; from async hooks it is queued for the next prompt | † ? | ✗ |
| `transcript` | ◐ `transcript_path`, but the docs say the format "isn't a stable interface" | ◐ no file needed: hook context carries the messages and usage; † the task folder is undocumented | ◐ `transcript_path` is `string \| null`; † sometimes null on tool events | ✗ not in any hook payload | † ◐ session store, undocumented | ✗ |
| `token_usage` / `cache_info` | ✅ `token_usage` on `PostModelRequest`, per attempt (subfields not documented; cache unknown) | ◐ `usage` with input and output tokens in hook context; cache fields not shown | ✗ no token fields in any hook payload; only `preCompact` has `context_tokens` and `context_usage_percent` | ✗ not in any hook payload; measured through a custom profile pointed at the router | † ◐ per message in the session store | ✗ |
| `reported_cost` | † ✗ tokens and plan limits only | ? no cost field in the plugin docs | † ◐ the usage dashboard and CSV export, not in hooks | ? | † ◐ in-session estimate from prices the user enters | ✗ |
| `model_selection` | ✅ `model` in every payload | ✅ the request in `beforeModel` | ✅ `model` in payloads († blank on some tool events) | ◐ `model` in config; `--model` and `/model` not visible to hooks | † ✅ | ◐ chosen in settings |
| `proxy_endpoint` | ✅ custom `model_providers` with a `base_url`, and `openai_base_url` | ✅ OpenAI-compatible provider with a base URL | † ◐ OpenAI base URL override, but requests go through Cursor's servers and agent features are limited | ✅ custom model profiles with a full `baseUrl` and `apiType` (`Anthropic`, `OpenAICompletion`, `OpenAIResponses`, `Google`) | † ✅ OpenAI-compatible provider | ✅ OpenAI-compatible endpoint address, plus own keys for Anthropic, Google and OpenAI, and local models through Ollama or LM Studio |
| `statusline` | ✗ `tui.status_line` lists Codex's own footer items, not a command | ✗ | ✗ | ? | ✗ | ✗ |

**What changed from the first pass**

- **Cline** lost its command hooks and its prompt hook. They moved into SDK plugins, so the adapter
  becomes a plugin shim, and sommelier reaches Cline through its base URL, not a prompt hook.
- **Cursor** has no token usage in its hook payloads, so the first pass's "usage on `stop`" was wrong.
  The one number it exposes is context size on `preCompact`.
- **Codex** renamed its feature flag, added hook trust review, and calls its transcript unstable.
  New `PreModelRequest` and `PostModelRequest` events fire per model request, retries included.
- **Junie** is confirmed as the closest to Claude Code's hook shape, but it is Early Access.
- **Copilot**'s `modifiedPrompt` is still SDK-only, as the [Copilot section](#copilot-compatibility-is-a-strategic-asset)
  says, with a new `userPromptTransformed` event to test.

**The ranking**, by what agentarium could prevent there:

1. **Codex CLI.** Both decisions, context injection, the model in every payload and a custom base URL.
   Its hook schema has the same shape as Claude Code's, so most of the adapter is translation, and
   sommelier, budget, haggle, diet, groundhog and the band's forecast could all run. Two things to settle
   first: token usage (now settled: `PostModelRequest`) and the trust step, which means `install` must
   tell the user to open `/hooks`. No money figure: costs are `estimated` from tokens.
2. **Junie CLI.** Moves up from fourth. Both decisions, context on both events, a custom endpoint and
   fail-closed options. Limits: Early Access, no documented token usage or transcript, and hooks only
   from `~/.junie/config.json` unless a file is passed explicitly. Ship it at `partial` behind its
   Early Access label.
3. **Cline, through the plugin shim.** Tool decisions, appended context, usage and the model per
   request, and a base URL for the router. It has no prompt-submit hook, so prompt-time guards cannot
   run there. A hook that exceeds 3 seconds fails open. Still the best fit for the "native IDE
   integration" rule, once we confirm that the VS Code extension runs the same plugin API as the SDK.
4. **Cursor.** The most users, and most capabilities are there on paper, but no token usage, hooks fail
   open by default and the CLI is said to drop most events. Write it after the first three as `partial`
   and lean on `observe()` to lift capabilities per version.
5. **Kilo Code.** Waits for its prompt hook to be confirmed and for its docs to be reachable. The shim
   built for Cline should cover it, and OpenCode in Priority 2.
6. **JetBrains AI Assistant.** No hooks; only a custom endpoint. Cover it with the generic provider
   layer (the proxy), not an adapter.

**Change to the milestone.** The first milestone is now Codex CLI alone. Junie CLI follows, then the
plugin shim with Cline, then Cursor at `partial`. JetBrains AI Assistant moves to the generic provider
item, which moves up the table because two of the six platforms depend on it.

**New ideas from this pass.**

- Codex CLI, Junie CLI and Copilot CLI have all adopted hook names and decision fields close to Claude
  Code's. A shared `ClaudeShapedAdapter` base, with a field map per platform, could make each of them a
  config file plus fixtures rather than a class, and the contract test would hold them to it. Cline is
  the exception: its plugin API is different enough to need its own shim.
- Hook timeouts are now known for some platforms (Cline 3 s, Junie 10 s for prompt and tool hooks, Codex
  600 s by default, Cursor set per hook). `doctor`'s p90 per helper should warn against each platform's
  figure. Cursor's reported prompt-hook cut-off of about a second is still unconfirmed (†).
- Cline's plugin docs show no cost per request, so the first-pass idea of reading its reported cost as a
  check on our price table is parked until a real install shows whether the figure exists.
- Codex's `PreModelRequest` and `PostModelRequest` give a per-request view that no other candidate has,
  retries included. sommelier's proxy logic (decide per request, learn from failed attempts) could run
  as a hook there.
- Several platforms refuse or gate hooks from repository config: Junie ignores a project's
  `.junie/config.json` unless passed explicitly, Codex runs project hooks only in trusted projects and
  only after hash review, and Cursor needs a trusted workspace. Install steps for every new adapter
  should default to user scope, and `doctor` should say when a project-only install is being ignored.

#### The generic provider layer

*Design for the second item in [More AI environments](#more-ai-environments), drafted from the code on 22 November 2026.
Usage field names marked ‡ are from the providers' API references as we know them and need checking against
a live response before code depends on them.*

**Why it moved up.** Two of the six Priority 1 candidates (JetBrains AI Assistant, and Cline for prompt-time
routing) can only be reached through a base URL. Every candidate except Cursor takes one. A provider layer
gives agentarium measured usage on any tool that can be pointed at a local endpoint, with no adapter.

**What's already there.**

- **A proxy, but for one API and one job.** `sommelier.ts serve` listens on `127.0.0.1`, rewrites `model` on
  `POST /v1/messages` and passes every other path through untouched. The upstream is one URL
  (`AGENTARIUM_ROUTER_UPSTREAM`, default `https://api.anthropic.com`).
- **It reads nothing back.** `relay` streams the response straight to the client. The proxy logs what it
  decided and the estimated saving, but never the `usage` the provider returned, so its figures are
  `estimated` even though the real ones pass through it.
- **Prices for one vendor.** `data/model-prices.json` lists 24 Claude models from Anthropic's pricing page.
  `data/providers.json` has rows for OpenAI and Google, but they are marked indicative and only bazaar and
  crystal-ball read them.
- **A provider guess from the model id.** `services/cost.ts provider()` tells Anthropic, Bedrock, Vertex,
  OpenAI and Google apart by name. Any other model is `unknown`.
- **An OpenAI-compatible client** (`engine/llm.ts`, for the opt-in LLM features), which shows the request
  shape but has nothing to do with metering.

**The design.** Four pieces, each usable on its own.

1. **A meter in the proxy.** `relay` keeps passing bytes through unchanged, and a small parser watches the
   same bytes on the side: the last `usage` in a JSON body, or the usage events in a server-sent stream. It
   writes one row per request to a new `provider_events` table (platform or client name, provider, model,
   input, cache write, cache read, output, status code, latency, `source = 'measured'`). No prompt or reply
   text is stored. A parse failure records the request with null usage and never touches the response.
   The usage fields per wire format:

   | Wire format | Path | Input | Cache | Output | In a stream |
   |---|---|---|---|---|---|
   | Anthropic Messages | `/v1/messages` | `input_tokens` | `cache_creation_input_tokens`, `cache_read_input_tokens` | `output_tokens` | `message_start` then `message_delta` |
   | OpenAI Chat Completions ‡ | `/v1/chat/completions` | `prompt_tokens` | `prompt_tokens_details.cached_tokens` (reads only) | `completion_tokens` | last chunk, only with `stream_options.include_usage` |
   | OpenAI Responses ‡ | `/v1/responses` | `input_tokens` | `input_tokens_details.cached_tokens` (reads only) | `output_tokens` | `response.completed` event |

   OpenAI-shaped streams carry usage only when the client asks for it. The proxy may add
   `stream_options.include_usage: true` to a streamed chat request, because it adds one final chunk that
   clients already ignore. That is the only change to a request body the meter makes, and
   `AGENTARIUM_PROVIDER_INCLUDE_USAGE=off` turns it off.

2. **Routes by path, upstreams by name.** One proxy, several upstreams:
   `AGENTARIUM_PROVIDER_UPSTREAMS=anthropic=https://api.anthropic.com,openai=https://api.openai.com,local=http://127.0.0.1:11434`.
   A client picks one by path prefix (`http://127.0.0.1:8787/openai/v1`), so a tool that only takes one
   base URL still works. Keys pass through in the client's own headers: agentarium never stores one.
   sommelier's routing stays on Anthropic Messages for now, since its tiers are Claude models. On other
   paths the proxy meters only, until the tiers can name another vendor's models.

3. **Importers for usage the proxy can't see.** `till.ts import <file>` reads a usage or cost export
   into the same table with `source = 'reported'`: Anthropic's and OpenAI's usage and cost exports, Cursor's
   usage CSV, and an OpenTelemetry file in the GenAI conventions (`gen_ai.usage.input_tokens`,
   `gen_ai.usage.output_tokens`, `gen_ai.request.model` ‡), which also covers Claude Code's and Codex's own
   telemetry export. Each importer is a column map plus a fixture, and a row that matches a measured request
   (same model, minute and token counts) is kept once.

4. **Prices for what it meters.** `data/model-prices.json` gains an optional `provider` per row and the
   first OpenAI and Google rows, refreshed by `update_prices.ts` from each vendor's pricing page where it
   can be fetched, and marked indicative where it can't. A model with no price is counted in tokens and
   shown as "no price", never priced at a guess. A local model (Ollama, LM Studio) is priced at zero and
   labelled local.

**What it changes for the next step's cost.** Measured usage is what the band forecasts from, so a
Cline or JetBrains session behind the proxy gets the forecast, the budget and the cache-risk price the
same way a Claude Code session does. budget's pause can't act there without a prompt hook, but the
proxy can: once a budget is used up it can answer a request with a 429 and a message in the provider's
error format. That is a guard like any other (`AGENTARIUM_PROVIDER_BUDGET=off`, logged in
`provider_events`), and it is off by default until we know how each client shows the error.

**Order of work**, each a pull request:

1. The meter for Anthropic Messages only, so Claude Code behind `agentarium router on` gets measured
   usage per request and `router status` shows measured beside estimated.
2. `provider_events` read by the ledger and the band, with the provenance label from the adapter design.
3. Named upstreams and the OpenAI Chat Completions and Responses parsers, with recorded fixtures.
4. OpenAI and Google prices, and the "no price" display.
5. The importers, starting with OpenTelemetry since it covers the most tools.
6. The budget guard in the proxy.

**Open questions.**

- Several tools send requests to their own servers, not to the base URL, for some features (Cursor's
  agent mode is reported to). The meter can only see what reaches it, so each tool's integration page
  must say which features go round it.
- A gateway such as LiteLLM or OpenRouter may report its own cost per request. If it does, that is a
  `reported` figure the meter should keep beside its own `measured` tokens, and a check on our prices.
- Is one proxy port with path prefixes enough, or do some tools insist on the base URL ending at `/v1`?
  This needs one real install per tool.

**New ideas from this pass.**

- The meter fixes a gap that exists today: sommelier's proxy already carries Claude Code's real usage
  and throws it away, then `measureSidechain` reads it back from the transcript. Step 1 is worth doing
  even if no other provider is ever added.
- Metering in the proxy gives a per-request latency and error rate for every provider, which is what
  bazaar's `latency` and `availability` columns are waiting for.
- `doctor` could test the proxy end to end with a `count_tokens` call (Anthropic) or a one-token request
  (others), so "is my tool going through agentarium?" has an answer.

#### Unified cost reporting

*Design for the third item in [More AI environments](#more-ai-environments), drafted from the code on 22 November 2026.
It depends on two pieces from the designs above: the provenance label (adapter interface) and `provider_events`
(provider layer).*

**What's already there.** More than the item suggests, spread over three reports that each count a different way.

- **`report.ts`** (the weekly report) prices spend from `cost_events` and the ledger, splits it by project and
  model, and reports what the helpers did. Only sommelier's saving is in money (`saved_usd`, net of hand-offs,
  with routes up shown as extra spend). diet's is in tokens (`est_tokens`), groundhog, budget and doggybag are
  counts, and sherlock's figure is waste found, not waste prevented.
- **`splitthebill.ts`** has eight dimensions (project, developer, agent, category, model, provider, status and
  worktype), a CSV and several databases merged into one team view. Copilot sessions sit in their own section,
  counted in premium requests and never priced. `platform` is a CSV column but not a `--by` dimension.
- **sommelier** already keeps estimated and measured side by side: `est_routed_usd` and `saved_usd` when it
  routes, `measured_usd` and `measured_saved_usd` once `measureSidechain` has read the transcript. It is the
  only helper that does.
- **Other savings are computed but not kept.** ballast logs `step_usd`; coldcache works out what the 1-hour
  cache would have saved (`ttl_1h.saved_usd`) for cold-snap's advice; the band prices each recommended saving.
  None of these reaches a report as a saving.

So the work is one shared way to count, used by every report, not a fourth report.

**The design.**

1. **One spend view, every platform.** A `spend(db, since, until)` function in `services/insights.ts` returns
   one row per session and model: platform, project, developer, provider, model, tokens (input, cache write,
   cache read, output), cost, premium requests and the source of each figure. It reads the ledger
   (`measured`, from transcripts), `provider_events` (`measured` from the proxy, `reported` from imports) and
   Copilot's telemetry (premium requests only, no cost). Where the same requests appear in two places, a
   measured figure beats a reported one, which beats an estimate, and a session is counted once.
   `report.ts`, `splitthebill.ts`, the dashboard and the band's daily total all read this view, so they
   agree to the penny.
2. **`platform` as a dimension.** `split-the-bill --by platform` and a platform column in the weekly report.
   Money columns add up only across token-billed platforms. Premium requests get their own column and are
   never added to money, as the [Copilot rules](#copilot-compatibility-is-a-strategic-asset) say.
3. **Cumulative spend.** Each report gains a running total per day and month-to-date beside the window, from
   `cost_events` and `provider_events`, with the month-end projection the band already uses for budgets.
   `split-the-bill --month` shows the same for the finance team's period.
4. **A savings ledger.** A new `savings` table, one row per intervention that has a price: helper, session,
   platform, project, `usd`, `source` (`measured` or `estimated`), `method` (a short name for how it was
   priced) and a link to the helper's own event row. Each helper writes to it through one `SavingsEngine.log`
   call, so the pricing rules live in one place:

   | Helper | What is priced | Method | Source |
   |---|---|---|---|
   | sommelier | stay cost minus hand-off minus routed cost | `route` | `measured` once the transcript is read, `estimated` until then |
   | diet | blocked result tokens at the session model's input price, carried for the turns left in the context | `tokens-avoided` | `estimated` |
   | groundhog | the median cost of one loop step, times the steps the loop had already repeated | `loop-step` | `estimated` |
   | ballast, doggybag | context dropped, priced at cache-read for the steps the forecast expected | `context-dropped` | `estimated`; `measured` when the next turn's real context is known |
   | budget, haggle | not a saving: spend that was stopped may have been spent later | none | counted, not priced |

   A guard whose effect can't be priced honestly stays a count. That is the rule from the item's notes: no
   saving is claimed where the data isn't there.
5. **Savings per tool, actual and estimated.** Reports show the two side by side ("£3.10 measured, about £1.40
   more estimated"), never summed into one figure. Routes up and anything else that cost money for quality
   show as their own line, as sommelier's do now.

**What it changes for the next step's cost.** Two things. The weekly report can end in a change with a price on it
("diet saved about £2.20 on Cline this week, groundhog nothing: it is set to `warn`, try `block`"), which is the rule
at the top for reports. And haggle, waistline and the band all forecast from history, so once a
Codex or Cline session sits in the same view, their estimates on that platform come from its own sessions.

**Order of work**, each a pull request:

1. The `spend()` view over the ledger and Copilot telemetry, with `report.ts` and `splitthebill.ts` moved onto
   it and a test that the two agree on the same database.
2. `platform` as a dimension, and cumulative and month-to-date totals.
3. The `savings` table with sommelier moved onto it (its estimated and measured columns map straight across).
4. diet and groundhog pricing, each with a fixture that shows the arithmetic.
5. `provider_events` in the view, once the provider layer's second step lands.

**Open questions.**

- diet's saving depends on how many turns the blocked result would have stayed in the context. The forecast's
  "next 10 steps" is a guess for that. A cap at the session's remaining turns, measured after it ends, would be
  more honest but means updating a row later, as sommelier does.
- Teams merge databases with `--db a.db --db b.db`. If two people use the same proxy, its rows could be
  counted twice; the view needs a host or developer key on `provider_events` to tell them apart.
- Should a saving on a platform that bills by request (Copilot) be shown in premium requests saved? diet
  blocking a flood doesn't save a request, so for now the answer is no, and Copilot shows no savings figure.

**New ideas from this pass.**

- A test that every report reads `spend()` and nothing else for money would stop the three reports drifting
  apart again. `spring-clean` could flag a new `SUM(cost_usd)` outside the view.
- The savings table gives the README a figure it can show for real installs: "saved a median £x per developer
  per week, y% of it measured". `agentarium doctor --share` could print it, with nothing personal in it.
- sherlock's waste found and the savings table together give a "could have saved" next to "did save" for each
  helper, which points at the guard-rail to switch on or tighten next.

#### The Codex CLI adapter

*Design for the first Priority 1 adapter, drafted from the code and Codex's hooks reference on 22 November 2026.
Fields marked ‡ are named in the docs without a schema and need a recorded payload before code depends on them.*

**What settled the two open questions.**

- **Token usage is in a hook, not only the rollout file.** `PostModelRequest` carries `token_usage` for each
  model request attempt, retries included, with `status` (`completed`, `failed`, `cancelled`) and `error`. It is
  the only payload with usage, and it can be `null`. The docs don't list its subfields ‡. So `token_usage` is
  `native` per request, `cache_info` is `partial` until we see whether a cached-input count is in it, and the
  transcript stays a fallback the docs call unstable.
- **The trust step is a fact of the install.** Every non-managed hook is skipped until it is reviewed in `/hooks`,
  trusted by its hash. A change to the hook file or to a bundled script needs a fresh review, so each agentarium
  upgrade that touches `codex-hooks.json` will silently switch the guards off until the user opens `/hooks`.

**Constraints the reference adds.**

| Fact | What it means for agentarium |
|---|---|
| `SessionEnd` and `Interrupt` time out after 1 s by default, 3 s at most | Our Claude Code `SessionEnd` runs six hooks with 10 to 20 s timeouts. On Codex the end-of-session work (finalize, doggybag, sherlock, haggle close, sommelier learn) moves to `Stop`, which keeps the 600 s default, or is picked up by the next `SessionStart`. `SessionEnd` only writes a marker. |
| Matching command hooks run at the same time | The Claude Code files list `Stop` hooks in an order (finalize before arm before the message). On Codex each event gets one hook: the controller, which already runs helpers in order in one process. |
| `PreToolUse` can deny or allow with `updatedInput`, never ask | `askTool` returns `null`. blinkers and haggle, which ask on Claude Code, deny with the override in the reason instead, or warn. |
| `Stop` with `decision: "block"` starts a new turn | No helper may return a block on `Stop` there: it would cost a turn, not save one. The adapter's `Stop` builders return `null`. |
| Plain stdout on `UserPromptSubmit` and `SessionStart` becomes developer context | Same as Claude Code, so `addContext` maps straight across. Context over about 2,500 tokens spills to a file, which ours never reaches. |
| `model` and `cwd` in every payload, `turn_id` on turn events | `sessionModel` is a field read. `turn_id` gives a clean key for "this turn's requests", which the band needs for its forecast. |
| Codex sets `CLAUDE_PLUGIN_ROOT` for plugin hooks | Our scripts already find their root through it, so a Codex plugin can call `scripts/run.sh` unchanged. |

**The adapter.** `agentarium/adapters/codex.ts`, built on a `ClaudeShapedAdapter` base taken out of
`ClaudeCodeAdapter` (event names, `hookSpecificOutput` builders, `tool_response` success), so Junie can reuse it next.

| Capability | Level | From |
|---|---|---|
| `hooks`, `session_info`, `tool_events` | native | `session_id`, `hook_event_name`, `PreToolUse` / `PostToolUse` with `tool_name` and `tool_input` |
| `prompt_decision`, `context_injection` | native | `UserPromptSubmit` `decision: "block"` and `additionalContext` |
| `tool_decision` | native | `PreToolUse` `permissionDecision: "deny"`; no ask |
| `token_usage` | native | `PostModelRequest.token_usage`, per attempt |
| `cache_info` | partial | only if `token_usage` has a cached-input field ‡ |
| `model_selection` | native | `model` in every payload; the hook can't change it |
| `transcript` | partial | `transcript_path` to the rollout JSONL; read only for skill names, never for money |
| `context_info` | partial | input tokens of the turn's last request; `PreCompact` says when it's full |
| `proxy_endpoint` | native | `model_providers` with a `base_url` in `config.toml` |
| `billing_info`, `reported_cost` | none | tokens and plan limits only: every cost is `estimated` from the price table |
| `statusline` | none | `tui.status_line` in `config.toml` is a list of built-in footer items, not a command |

**How the money is counted.** A `PostModelRequest` hook (`till.ts request codex`, async so it never slows a turn)
writes one row per attempt to `provider_events`, the table from [the provider layer](#the-generic-provider-layer),
with `source = 'measured'` for the tokens and the client set to `codex`. That makes the Codex adapter the provider
meter's first writer, before the proxy parsers exist, and the unified `spend()` view reads it with no special case.
Failed and cancelled attempts are kept: a retry storm is spend, and groundhog can use it as loop evidence.

The tokens are measured, the money isn't. Codex runs OpenAI models and `data/model-prices.json` has none yet,
so the provider layer's step 4 (OpenAI prices, and "no price" for a model without one) has to land first, or
every Codex figure shows as tokens only.

**What runs on Codex at launch.**

| Helper | Runs | Notes |
|---|---|---|
| diet, groundhog | yes | deny on `PreToolUse` |
| blinkers, haggle guard | yes, warn or deny | no ask: the override goes in the deny reason |
| budget | yes | pauses on `UserPromptSubmit` from measured spend once prices exist |
| ballast, parrot, doggybag | yes | context on `UserPromptSubmit` and `SessionStart` |
| the band's forecast | in the after-reply `systemMessage` | no status line to put it on |
| sommelier | records the tier it would pick, routes nothing | the hook can't change the model and the router only speaks Anthropic Messages; see the ideas below |
| bang-for-buck, taste-test, sherlock | yes, from `Stop` | not from `SessionEnd`: 1 s is too short |

**Install.** `agentarium codex` writes `~/.codex/hooks.json` (user scope, as the scoring section says, since project
hooks need a trusted project as well as review), keeps any hooks already there, and ends by saying: "open `/hooks`
in Codex and trust the agentarium hooks, or they won't run". `doctor` checks for a row from a Codex hook in the last
session and, if the hook file is newer than the last row, says the hooks are probably waiting for review. A Codex
plugin (`.codex-plugin/plugin.json` ‡: the manifest schema wasn't in the pages read) can come later, once the hooks
have been tried by hand.

**Order of work**, each a pull request:

1. `ClaudeShapedAdapter` out of `ClaudeCodeAdapter`, with no change in behaviour (the contract test from the adapter
   design proves it).
2. The Codex adapter, fixtures recorded from a real session (one per event, `token_usage` included) and the contract
   test passing.
3. `codex-hooks.json` with one controller hook per event, the `SessionEnd` work moved to `Stop`, and `agentarium codex`.
4. The `PostModelRequest` meter into `provider_events`, shown as tokens by `router status` and the weekly report.
5. Money for Codex, once OpenAI prices are in the table.
6. Docs: `docs/integrations/codex.md` with the capability column, the trust step and the helpers that can't run.

**Open questions.**

- What is in `token_usage`? The Codex protocol's own usage type has input, cached input, output and reasoning
  output counts, but the hook reference doesn't promise that shape. The first recorded payload settles it.
- Does `PostModelRequest` fire for subagents' requests with their `agent_id`? If it does, subagent spend is
  measured too, which Claude Code only gets from the transcript.
- Does an `async` hook still run when Codex is started non-interactively (`codex exec`)? CI use depends on it.

**New ideas from this pass.**

- `PostModelRequest` is the per-request meter the provider layer wanted, delivered by the platform. Any tool that
  copies Codex's hook set gets measured usage with no proxy, so the contract test should treat a per-request usage
  event as its own capability (`request_usage`) rather than folding it into `token_usage`.
- sommelier on Codex has a route that the Claude Code hook doesn't need: Codex takes a custom `model_providers`
  entry, so once the router can speak the OpenAI Responses format it can pick the model per request in front of
  Codex, as the proxy does for Claude Code now. That puts the router's OpenAI support ahead of the
  importers in the provider layer's order.
- A short `SessionEnd` is worth planning for on every platform: a session closed by a crash or a killed terminal
  may never send one. Doing the end-of-session work on the last `Stop` and treating `SessionEnd` as a marker, with
  the next `SessionStart` finishing anything left open, would make Claude Code more reliable too.
- Hook trust by hash means every upgrade is a re-review on Codex. Keeping the hook file stable (one controller line
  per event, all logic behind `run.sh`) means an agentarium upgrade changes scripts, not the hook file. The docs
  say a changed bundled script also needs review in a plugin, which is one more reason to start with user-scope
  hooks rather than a plugin.

**Additions from a second pass** (config reference, 22 November 2026).

- **Plan or API key.** Codex bills against a ChatGPT plan's limits or an API key's tokens, and no hook payload
  says which. The adapter should read the sign-in mode from `~/.codex/auth.json` where it can ‡, with
  `AGENTARIUM_CODEX_BILLING=plan|tokens` as the override. On a plan, usage is shown in tokens and never priced,
  the same rule as Copilot's premium requests. Only an API-key session is priced once OpenAI prices land.
- **No read tool.** Codex reads files through `Bash` (`cat`, `sed -n`), so diet's matcher there is `Bash` alone,
  and its shell checks do the work its `Read` check does on Claude Code.
- **cold-snap and coldcache don't apply.** OpenAI caches prompts automatically, with no write price and no TTL
  to choose, so there is no cache rebuild to price or warn about.
- **`Interrupt` is outcome evidence.** The user stopping a turn is the clearest "that wasn't what I wanted"
  signal any platform sends. It should count as a miss in `missEvidence` and feed `learn`.
- **`PermissionRequest` could carry a price.** It fires when Codex would ask the user, so haggle could add the
  step's estimated cost to the prompt without blocking anything. Check first how Codex treats exit 0 with no
  decision: on Junie it approves, which is why the Junie design bans the event.

**Additions from a third pass** (hook reference, 23 November 2026). Three points the design above doesn't cover.

- **groundhog's stop needs a fallback.** `continue: false` and `stopReason` are unsupported on `PreToolUse`: Codex
  marks the hook run as failed and lets the tool call through. So `interrupt` returns `null` as well as `askTool`.
  `policy.enforce` already falls back from `interrupt` to `denyTool`, but groundhog calls `adapter.interrupt` itself
  (`scripts/groundhog.ts`), so on Codex its stop would print nothing while logging `interrupted`. It moves onto
  `policy.enforce` before the adapter ships, with a test against an adapter whose `interrupt` is `null`.
- **Exit code 2 as well as JSON for a deny.** A `PreToolUse` error, timeout or malformed response can let the tool
  run. Codex honours exit 2 with the reason on stderr on `PreToolUse`, `UserPromptSubmit` and `PostToolUse`, so a
  deliberate deny there writes both. `run.sh` already `exec`s Node, so the exit code reaches Codex; the hook runner
  must exit 2 only after a deliberate deny and 0 on any crash, and a test holds it to that.
- **`SessionStart`'s `source: compact`** says a compaction just happened without reading a transcript. ballast and
  the band's context forecast can reset their figures on it, and doggybag should start only on `startup` and `clear`.

**Additions from a fourth pass** (hook reference and community rollout parsers, 23 November 2026). Fields marked ‡
come from third-party parsers, not OpenAI's docs.

- **A plan-limit forecast, not just tokens.** The rollout's `token_count` events are said to carry `rate_limits`
  with the share used of the 5-hour and weekly windows ‡. On a ChatGPT plan that gives Codex the counterpart of
  Copilot's premium forecast: "62% of the 5-hour window used, at this pace it runs out at 15:40". Claude Code's
  subscription has the same two windows, so one plan-limits piece in `services/` could serve both, beside
  `all-you-can-eat`.
- **Pricing rule for the token fields.** If `token_usage` matches the rollout's shape (`input_tokens`,
  `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` ‡), cached tokens sit inside input and
  reasoning tokens are billed as output. The meter takes cached out of input before pricing; summing all four
  would count the cached part twice.
- **At most eight `async` hooks run at once per session.** With one controller hook per event this is never
  reached, but a plugin that adds its own async hooks shares the limit.
- **The status line stays `none` for now.** Requests for a command-backed one (openai/codex #17827, #20140) are
  open. If one lands, `statusline.ts` is the only piece that would need a Codex payload reader.
- **If the rollout file is ever read for usage, read it one way.** Its `token_count` records ‡ hold a cumulative
  `total_token_usage` and a per-turn `last_token_usage`. Sum the per-turn figures or take the last cumulative one,
  never add up the cumulative ones: parsers that do count a session several times over.
- **Tool names don't match their matchers.** `apply_patch` also matches the matchers `Edit` and `Write`, and
  `spawn_agent` matches `Agent`, but the payload still says `apply_patch` and `spawn_agent`. Codex reports
  `exec_command` as `Bash`. So the hook file can reuse blinkers' Claude Code matcher, but `toolCall` must map
  `apply_patch` to an edit. Hosted tools such as web search fire no hooks at all, so their cost shows up only in
  `PostModelRequest`.
- **A second way to spot untrusted hooks.** Beside the hook-file timestamp check above, `doctor` can compare
  rollout files in `~/.codex/sessions` newer than the install with rows labelled `codex` in our database. Codex
  sessions with no rows mean the hooks were skipped, whatever the reason.

**Additions from a fifth pass** (hooks page, 23 November 2026). Three points the passes above leave open.

- **Per attempt or running total?** Codex's rollout file keeps both a `last_token_usage` and a
  `total_token_usage` ‡. If `PostModelRequest.token_usage` turns out to be the running total, writing it per row
  would count a session many times over. The meter should store the difference from the previous row in the
  same session when the figure only ever grows, and the first recorded payload decides which.
- **blinkers reads paths out of the patch.** File edits arrive as `tool_name: "apply_patch"` (the matcher
  accepts `Edit` and `Write` as aliases, but the payload doesn't change), so blinkers needs the paths from the
  patch's `*** Update File:` and `*** Add File:` lines, not a `file_path` field.
- **A test that the hook file is stable.** The hook-trust point above depends on `codex-hooks.json` not changing
  between releases with no hook changes. A test that compares the generated file with a checked-in copy keeps
  an upgrade from quietly sending every user back to `/hooks`.

**Additions from a sixth pass** (hook reference, 23 November 2026). Four points the passes above don't cover.

- **A rejected field is worse than a missing one.** Codex marks a hook run as failed when its output has a field
  the event doesn't support, and the tool call goes ahead. The contract test should check each builder's output
  against the fields each event accepts, not only that unsupported builders return `null`.
- **diet's warning on `PreToolUse`.** The reference lists `systemMessage` among the common fields for prompt, stop
  and session events, not for `PreToolUse` ‡. Until a recorded run shows it is accepted there, `notify` on a tool
  event goes out as `additionalContext`, which `PreToolUse` does support.
- **Check the hash, not the date.** `doctor` can hash the installed `codex-hooks.json` entries and compare them with
  the ones this release ships. A mismatch after an upgrade says "review in `/hooks`" for certain, where a file
  newer than the last row only suggests it. Managed hooks (`requirements.toml`) and
  `--dangerously-bypass-hook-trust` skip review, so `doctor` reads `requirements.toml` before warning.
- **Watch the vendor's page.** Codex's reference lists events, inputs and outputs in fixed tables. A small script
  that diffs those lists against the adapter's declarations would catch a change before a user does, and the same
  check fits Copilot's hook reference.

#### The Junie CLI adapter

*Design for the second Priority 1 adapter, drafted from the code and JetBrains' Junie CLI pages (hooks, configuration,
model selection and custom models) on 22 November 2026. Hooks are Early Access. The [Codex CLI design](#the-codex-cli-adapter) proposes the `ClaudeShapedAdapter` base this one reuses. Fields marked ‡ are not in the docs and need a recorded
payload before code depends on them.*

**What the docs settled.** Junie is the closest hook set to Claude Code's: the same event names and fields (`hook_event_name`,
`tool_name`, `tool_input`, `tool_response`), exit code 2 to block and extensions that expand `${CLAUDE_PLUGIN_ROOT}`.
But the payloads are thinner than the scoring table assumed:

- **No token usage, model or transcript in any hook.** The input tables list none of them, and the docs say only that
  "more fields may be present". So on hooks alone every Junie figure would be `estimated`.
- **`session_id` and `cwd` are only on `SessionStart` and `UserPromptSubmit`**, and only "when the session provides
  them". `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd` list neither. groundhog and diet key on the session, so
  this has to be solved before the tool guards can run (see the open questions).
- **The way in for money is a custom model profile, not a hook.** A profile in `~/.junie/models/*.json` takes a full
  `baseUrl`, used as-is with no path added, and `apiType: "Anthropic"` (Messages), as well as two OpenAI formats and
  Google. A profile pointed at `agentarium router` is plain Anthropic Messages, which the proxy already speaks: the
  provider layer's step 1 (the meter) gives measured usage, and sommelier can route per request, with no new parser.

**Constraints the reference adds.**

| Fact | What it means for agentarium |
|---|---|
| `PermissionRequest` auto-approves on exit 0 with no block decision | agentarium must never register a `PermissionRequest` hook. Our hooks exit 0 on any error, which there would mean "approve everything". The contract test should fail any Junie hook file that lists the event. |
| Non-JSON stdout on `PreToolUse` and `PostToolUse` becomes model context | A stray line from a script (a warning, a debug print) would be sent to the model and paid for. Every agentarium hook sets `strictJsonOutput: true`, and without `blockOnError` a bad line is then only a warning. |
| Timeouts: 10 s for `SessionStart`, `UserPromptSubmit` and `PreToolUse`; 600 s for `Stop` and `PostToolUse`; 2 s for `SessionEnd`, 10 s in total | The controller has 10 s on the prompt, a third of what Claude Code gives it. `doctor`'s latency check warns at a p90 over 5 s. End-of-session work moves to `Stop`, as on Codex. |
| `Stop` fires only before a task is submitted successfully, never for chat-type tasks, and `decision: "block"` makes the agent retry | No helper blocks on `Stop`. Because a chat or failed task never sends `Stop`, the next `SessionStart` (and `StopFailure`) finishes any session left open. |
| `PostToolUse` doesn't fire when a tool fails, but does on a non-zero shell exit, with `exit_code` | Failing checks are still visible to `missEvidence` through `exit_code`. A tool that errors outright is seen only by its `PreToolUse`. |
| `PostToolUse` can replace the output the agent sees (`hookSpecificOutput.updatedToolOutput`) | `tool_output_interception` is `native` for every tool. Claude Code's `PostToolUse` now does the same for built-in tools (its docs, read on 26 November 2026), which colander uses. See the ideas below. |
| `PreToolUse` takes a top-level `decision` (`allow`, `ask`, `block`, `deny`) and `reason`, not `hookSpecificOutput.permissionDecision` | The shared base needs a field map for decisions, not only for event names. `askTool` works here, so blinkers and haggle can ask as they do on Claude Code. |
| Hooks in one entry run in order; files are concatenated, config before extensions | Order is safe, but one controller hook per event is still the plan, to keep the hook file stable. |
| Batch mode (`-p`) has no `UserPromptSubmit`; ACP (Junie run by an editor over the Agent Client Protocol ‡) has only `SessionStart`, `PreToolUse` and `SessionEnd` | Prompt-time guards run only in the TUI. Run from an editor over ACP, only the tool guards run, and the proxy profile carries the rest. |
| Hooks in a project's `.junie/config.json` are ignored | Install to `~/.junie/config.json`, merged into the existing file, which also holds `model`, `byok` and other keys. |

**The adapter.** `agentarium/adapters/junie.ts`, on `ClaudeShapedAdapter` with Junie's field map.

| Capability | Level | From |
|---|---|---|
| `hooks`, `tool_events` | partial | eight events, Early Access; `PostToolUse` misses failed tools |
| `session_info` | partial | `session_id` on `SessionStart` and `UserPromptSubmit` only ‡ |
| `prompt_decision`, `context_injection` | native (TUI) | `UserPromptSubmit` `decision: "block"`, context prepended to the prompt; none in batch or ACP |
| `tool_decision` | native | `PreToolUse` allow, ask, block or deny, with `updatedInput` |
| `tool_output_interception` | native | `PostToolUse` `updatedToolOutput` |
| `model_selection` | partial | `model` in `~/.junie/config.json`; `--model` and `/model` aren't visible to hooks; the proxy sees the real one |
| `token_usage`, `cache_info` | none in hooks; native through the proxy profile | the meter's `provider_events` rows |
| `context_info` | partial | `maxContextLength` in a custom profile, and the last request's input tokens through the proxy |
| `transcript` | none | no transcript path documented |
| `proxy_endpoint` | native | custom profile `baseUrl` with `apiType: "Anthropic"`; also `proxies` in `config.json` |
| `billing_info`, `reported_cost` | none | the Junie provider bills a JetBrains AI subscription and exposes nothing; BYOK is billed by the provider |
| `statusline` | none | not in the docs |

**Two billing cases.** With the Junie provider the user pays a JetBrains AI subscription in credits we can't see, so,
as with Copilot's premium requests, usage is counted and never turned into money. With BYOK or a custom profile, the
user pays the provider per token, so the session is priced from the price table like Claude Code's. The adapter sets
`billingModel` per session from the provider (`provider` in config, or `custom:` in the model id), and reports show
which case a session was in.

**What runs on Junie at launch.**

| Helper | Runs | Notes |
|---|---|---|
| diet, groundhog | once the session key is solved | deny on `PreToolUse` |
| blinkers, haggle guard | yes, with ask | as on Claude Code |
| budget | TUI, BYOK or proxy only | pauses on `UserPromptSubmit` once spend is measured or priced |
| ballast, parrot, doggybag | TUI | context prepended on `UserPromptSubmit`; `SessionStart` ignores `additionalContext`, so doggybag's notes go in on the first prompt instead |
| the band's forecast | in a `systemMessage` on `UserPromptSubmit` | `Stop`'s `systemMessage` isn't shown yet, so the outlook comes before the next prompt, not after the reply |
| sommelier | routes, through the proxy profile | the hook can't change the model, but the router can, per request; Junie's hidden helper calls on the smaller model go through it too when `fasterModel` points at the proxy |
| bang-for-buck, taste-test, sherlock | from `Stop`, or the next `SessionStart` | not from `SessionEnd`: 2 s is too short |

**Install.** `agentarium junie` merges a `hooks` object into `~/.junie/config.json` (one controller line per event,
`strictJsonOutput: true`, no `PermissionRequest`), keeping every other key, and with `--proxy` writes
`~/.junie/models/agentarium.json` (`apiType: "Anthropic"`, `baseUrl` the router's `/v1/messages`, `apiKey:
"${ANTHROPIC_API_KEY}"` and both `primaryModel` and `fasterModel` pointed at it), then says to pick it with
`junie --model custom:agentarium`. It ends by saying that hooks need the Early Access build. `doctor` reports whether
the Junie build is Early Access ‡, whether hooks fired in the last session and whether the proxy profile is in use.

**Order of work**, each a pull request, after Codex's first two (the base class and the contract test):

1. The Junie field map and fixtures, the first one recorded from a real Early Access session to settle the session key.
2. The proxy profile in `agentarium junie --proxy`, so a BYOK Anthropic user gets measured usage and routing first.
   This needs only the provider layer's step 1.
3. The hooks: `junie-hooks.json`, the install merge and the contract test rule against `PermissionRequest`.
4. `billingModel` per session, and the "subscription, not priced" line in reports.
5. Docs: `docs/integrations/junie.md`, with the TUI, batch and ACP differences as three columns.

**Open questions.**

- How do tool events find their session? Either `session_id` is there and undocumented (the first recorded payload
  says), or `SessionStart` writes the id against the Junie process found up the parent chain from the hook, and tool
  hooks look it up. A fallback on `anonSessionId(cwd)` is wrong here: tool payloads have no `cwd` either.
- Does a custom profile with `apiType: "Anthropic"` send prompt caching headers and `cache_control`? If not, routing a
  Junie session through the proxy is cheaper to measure but dearer to run than the Junie provider, and sommelier
  should say so.
- Does the Junie provider's own traffic honour `proxies` in `config.json` (the `kind` field suggests named proxy
  types)? If it does, subscription users get measured tokens too, still without money.

**New ideas from this pass.**

- `PostToolUse` `updatedToolOutput` lets diet trim a flood after it happens instead of refusing the call: keep the
  head and tail of a 40,000-line log and tell the model where the rest is. The agent loses no turn, which a deny costs.
  Claude Code's `PostToolUse` now replaces built-in tools' output too (`updatedToolOutput`, successful calls only),
  and colander does this for test, build and install output on Claude Code and Copilot CLI through the adapters'
  `replaceOutput`. A diet trim mode for floods is still open, and can reuse it.
- A platform where hooks see no usage but the proxy does is the common case, not the exception: Junie, Cline and
  JetBrains AI Assistant all look like this. The band's forecast should read `provider_events` by client, not only the
  transcript, so the proxy alone is enough for a forecast.
- "Exit 0 approves" on `PermissionRequest` shows that the fail-open rule ("a hook exits 0 on error") is not safe on
  every event. The adapter should declare, per event, what exit 0 means, and the contract test should fail a hook file
  that registers agentarium on an event where it means "allow".
- Junie reads extensions' `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}`, so this repo would load as a Junie
  extension as it stands, running Claude Code's hook file under the `claude-code` platform name. The `junie` adapter
  should spot a Junie payload (`project_path` is Junie's alone) and `doctor` should warn, until the extension
  manifest (‡, not in the pages read) can point Junie at its own hook file.

#### The Cursor adapter

*Design for the last Priority 1 adapter, drafted from the code and Cursor's hook reference and third-party hooks
page on 23 November 2026. Cells marked † come from Cursor's forum (bug reports and staff replies), not the docs,
and need a real install.*

**What changed since the scoring.** Two findings move part of this work to the front of the queue.

- **Cursor already runs agentarium.** Cursor loads Claude Code hooks from `~/.claude/settings.json` and the project's
  `.claude/settings.json` and `.claude/settings.local.json`, with "Include Third-Party Plugins, Skills, and Other
  Configs" on by default. cursor-agent also imports installed Claude Code plugins from
  `~/.claude/plugins/installed_plugins.json` †. Our `hooks/hooks.json` passes `claude-code` as the source on every
  command, so a Cursor session is recorded as a Claude Code one. The payload is Cursor's, so the session id falls back
  to an anonymous one (Cursor sends `conversation_id`, not `session_id`), the Claude Code transcript parser may read a
  file in another format, and the prompt hook's routing advice is dropped (`beforeSubmitPrompt` honours only `continue`
  and `user_message`).
- **The hook set is bigger than the first pass found.** The reference now lists 20 events, among them
  `postToolUseFailure`, `subagentStart`, `subagentStop`, `afterAgentResponse` and `afterAgentThought`. Cursor staff
  say `afterAgentResponse` carries input, output and cache token counts in interactive sessions †, so `token_usage`
  goes from ✗ to ◐. The field names are not in the docs yet.

**What Cursor gives hooks.**

| | What the docs say | What it means for agentarium |
|---|---|---|
| Every payload | `conversation_id`, `generation_id`, `model`, `model_id`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` | `conversation_id` is the session key (staff say `generation_id` is unreliable outside the IDE †); `cursor_version` is what `observe()` keys on; `user_email` is never stored |
| `beforeSubmitPrompt` | `prompt`, `attachments`; output `continue`, `user_message` | `prompt_decision` ◐: budget and haggle can stop a prompt. No `additional_context`, so sommelier can't hand off and ballast and parrot can't add a note |
| `preToolUse` | `tool_name`, `tool_input`; output `permission` `allow` or `deny` (`ask` isn't enforced), `agent_message`, `updated_input` | `tool_decision` ✅ for diet, groundhog, blinkers and haggle's guard. `askTool` returns `null`, since an ask would pass |
| `postToolUse`, `postToolUseFailure` | `tool_output`, `duration`, `error_message`, `failure_type`; output `additional_context` | `toolOk` is free (a failure has its own event), which feeds sommelier's `missEvidence` |
| `afterAgentResponse` | `text`; † token counts | the usage row per turn; the reply text is never stored |
| `stop` | `status` (`completed`, `aborted`, `error`), `loop_count`; output `followup_message` | `turn_end`; `followup_message` is how doggybag or the band could speak after a reply |
| `preCompact` | `context_tokens`, `context_window_size`, `context_usage_percent` | `context_info` ◐, only when a compaction is near |
| `sessionStart` / `sessionEnd` | `session_id`, `reason`, `duration_ms`, `final_status`; `sessionStart` output `env`, `additional_context` | doggybag's hand-off note can go in at session start |
| Config | enterprise, team, project `.cursor/hooks.json`, user `~/.cursor/hooks.json`; per hook `timeout`, `failClosed` (default `false`), `matcher`; exit 2 blocks, other failures pass | install at user scope; agentarium never sets `failClosed`, since a hook must not block by crashing |

**Where it is weaker than the table suggests** †. In `cursor-agent -p`, `beforeSubmitPrompt`, `afterAgentResponse` and
`stop` don't fire, so there are no prompt guards and no usage; staff call it a known gap with no date. One report says
the CLI on 2026.11.05 never loads `~/.cursor/hooks.json` at all (project files work). The AskQuestion and web search
tools skip `preToolUse`. Cloud agents don't run `sessionStart`, `sessionEnd` or user-level hooks. That is why the
adapter ships at `partial` and leans on `observe()`.

**The design.**

1. **Detect Cursor before trusting the source argument.** `getAdapter` gains a payload check: a `cursor_version` key
   or a `conversation_id` with `workspace_roots` means Cursor, whatever the command line says. Claude Code never sends
   either, so a real Claude Code session is unaffected. The same check stops the Claude Code transcript parser from
   opening a Cursor `transcript_path`. This is one small pull request, worth landing before the adapter itself,
   because it fixes data that is being written wrongly today.
2. **`CursorAdapter` on the Claude-shaped base.** Cursor's events map cleanly onto the six shared ones
   (`beforeSubmitPrompt` to `prompt`, `preToolUse` to `tool_call`, `postToolUse` and `postToolUseFailure` to
   `tool_result`, `stop` to `turn_end`, `sessionStart` and `sessionEnd`). The tool map is the third-party page's in
   reverse: `Shell` is `Bash`, `Write` is an edit, `Read`, `Grep` and `Task` keep their names, `MCP:<name>` is other.
   When `cwd` is empty, as it is for Shell calls †, the workspace is `workspace_roots[0]`. The output builders write
   Cursor's native fields (`permission`, `agent_message`, `continue`, `user_message`) and return `null` for `askTool`
   and for `addContext` on the prompt hook.
3. **One prompt hook does less on Cursor.** The controller runs the steps whose output Cursor honours: budget,
   haggle's quote as a pause, till recording. sommelier records the tier it would have picked and the saving it
   would have made as `would-route`, so `router status` can show what Cursor is leaving on the table. Routing proper
   waits for the generic provider layer, and Cursor's base URL override goes through Cursor's servers †, so it may never
   arrive. That is stated on the limitations page.
4. **Usage from `afterAgentResponse`, labelled.** When the event carries token counts, they go to the ledger as
   `reported` (Cursor's own figure), priced from `data/model-prices.json` where the model is a Claude one. Cursor's
   own models (`composer-*`) have no public price, so they show as tokens with "no price". Without the event (CLI
   print mode, cloud agents), the session is `estimated` from prompt and tool counts, as for Copilot.
5. **No double hooks.** A user who has both the Claude Code plugin imported and `agentarium cursor` installed would run
   every guard twice. `agentarium cursor` writes `~/.cursor/hooks.json` and checks whether third-party imports are on;
   when they are, it says so and installs nothing, because detection (1) already does the job. `doctor` warns when
   both are active.
6. **Fixtures before features.** Cursor payloads recorded from the IDE and from `cursor-agent` (interactive and
   `-p`) go into `tests/fixtures/cursor/`, and the adapter must pass the contract test from the
   [adapter interface](#the-adapter-interface) with them before any helper relies on it.

**Capabilities it would declare.** `hooks` native; `session_info` native (`conversation_id`); `tool_events` native;
`tool_decision` native in the IDE, partial in the CLI; `prompt_decision` partial (IDE interactive only);
`context_injection` partial (tool results and session start, not prompts); `model_selection` native (`model` in every
payload); `token_usage` and `cache_info` partial until the field names are confirmed; `context_info` partial
(`preCompact`); `transcript` none until the file is documented; `reported_cost` none in hooks (the usage dashboard and
Admin API are outside them); `proxy_endpoint` partial; `statusline` none.

**What it changes for the next step's cost.** diet, groundhog and blinkers work in Cursor from the first pull request,
since Cursor already calls them. budget's pause and haggle's quote follow with the adapter. Measured usage from
`afterAgentResponse` gives the band's arithmetic something to forecast from, even though Cursor has no status line to
show it: the forecast goes into `stop`'s `followup_message` only when it carries advice, the way the after-reply
message works on Claude Code.

**Order of work**, each a pull request:

1. Payload detection in the registry and a test that a Cursor payload with `claude-code` on the command line is
   recorded as `cursor`.
2. The adapter, its fixtures and the contract test, with tool guards and lifecycle only.
3. Prompt-hook steps that Cursor honours, and sommelier's `would-route` record.
4. Usage from `afterAgentResponse` once a fixture shows the field names.
5. `agentarium cursor` and an integration page with the CLI's gaps listed.

**Open questions.**

- Does `${CLAUDE_PLUGIN_ROOT}` resolve when Cursor runs an imported plugin's hooks? If not, every imported command
  fails and, being fail-open, does nothing. Detection (1) then has nothing to detect, and `agentarium cursor` must
  install after all.
- Does `afterAgentResponse` give per-turn or cumulative counts, and does it split cache writes from cache reads?
- Is `beforeSubmitPrompt`'s reported cut-off of about a second still there? The controller's p90 from `doctor` would
  need to sit under it, which is tighter than on any other platform.

**New ideas from this pass.**

- Third-party loading is a pattern, not a Cursor quirk: any assistant that imports Claude Code hooks runs our
  scripts with the wrong source label. Payload detection in the registry is the general fix, and `doctor` could list
  "sessions seen from platforms you didn't install for".
- Cursor merges hook answers across enterprise, team, project and user (`deny` beats `ask` beats `allow`). A team that
  ships diet through Cursor's team dashboard would get it on every machine without anyone installing agentarium,
  though the database would then be on each machine. Worth a line on the integration page.
- `subagentStop` reports `message_count`, `tool_call_count` and `modified_files` per subagent. That is enough for
  bang-for-buck to score a Cursor subagent's result the way it scores a routed one on Claude Code.

#### The plugin shim

*Design for the fifth item in [More AI environments](#more-ai-environments), drafted from the code and Cline's SDK
plugin and hook pages on 22 November 2026. Fields marked ‡ are not named in the docs and need a live capture before
code depends on them.*

**The problem.** Every hook agentarium has today is a command: the platform runs `scripts/run.sh` with JSON on
stdin and reads JSON from stdout. Cline, Kilo Code and OpenCode run hooks inside their own process instead, as
functions on a TypeScript plugin object. Nothing there runs a command for us, so the shim is a small plugin that
turns each in-process hook call into the command call the rest of agentarium already understands.

**What the Cline docs settled.**

- **The hooks and what they can return.** A plugin is an `AgentPlugin` with `name`, a `manifest` listing its
  `capabilities` and a `hooks` object. Each hook gets a `snapshot` (agent id, conversation id, iteration, messages
  and usage) plus its own fields:

  | Hook | Extra input | Can return | agentarium lifecycle |
  |---|---|---|---|
  | `beforeRun` | none | `stop` and `reason`, `appendContext` | `prompt`, if a run starts per user message ‡ |
  | `beforeModel` | `request` | `messages`, `tools`, `options`, `stop` and `reason` | none (one model request) |
  | `afterModel` | `assistantMessage`, `finishReason` | `stop` and `reason` | none (usage, see below) |
  | `beforeTool` | `tool`, `toolCall`, `input` | `skip` and `reason`, `input`, `policy`, `appendContext`, `stop` | `tool_call` |
  | `afterTool` | `result`, timing | `result`, `appendContext`, `stop` and `reason` | `tool_result` |
  | `afterRun` | `result` (with `usage.inputTokens`, `usage.outputTokens`) | nothing | `turn_end` |
  | `onEvent` | a runtime event | nothing | `session_end`, if a session event exists ‡ |

- **Timeouts and failure.** Each hook call has 3 seconds. A hook that throws or times out is ignored by default
  (`hookErrorMode: "ignore"`), and five failures in a row mark the plugin `failed` for the session. Import and
  `setup()` get 4 seconds each.
- **Loading.** The CLI installs a plugin with `cline plugin install` from a file, a URL, git, npm or a local
  path; the SDK takes absolute paths in `pluginPaths`. Each plugin runs in its own worker thread per session.
- **The VS Code extension is not settled.** Cline 4.0.0 moved the extension onto the SDK, then 4.0.1 rolled the
  stable extension back to the old core after regressions. Until a release says otherwise, the shim targets the
  Cline CLI and SDK hosts, and the extension is listed as "not yet".

**Two things change from the scoring pass.**

1. **Cline may have a prompt hook after all.** `beforeRun` can stop a run and add context the model sees on its
   first request. If a run starts once per user message, and `snapshot.messages` ends with that message ‡, then
   `beforeRun` is `UserPromptSubmit` by another name, and the controller (budget, haggle, ballast, parrot and
   sommelier's advice) can run there. That is the first thing to test.
2. **`afterTool` can rewrite a result.** No other platform lets agentarium change what a tool returned. diet
   today can only refuse a flooding call before it runs; on Cline it could let the call run and cut the result
   to its head and tail with a note, which costs the model one turn less. That is a new mode for diet
   (`AGENTARIUM_DIET_MODE=trim`), off by default, and `tool_output_interception` is `native` here.

**The design.**

- **One self-contained file per host.** `plugins/cline/agentarium.ts` exports the plugin and imports nothing but
  Node built-ins, the same rule as `statusline.ts`, because `cline plugin install` may copy the file somewhere
  else. The path to `scripts/run.sh` is written into it at install time. Kilo Code and OpenCode each get their
  own small entry file later, sharing the same transport code by copy, checked by a test that the shared block is
  identical in each.
- **The shim forwards; the adapter translates.** The shim knows nothing about scoring. Each hook call becomes one
  JSON payload in Cline's own field names (`hook`, the conversation id, `cwd`, the model when the request shows
  it, `usage`, and `tool` and `input` for tool hooks) passed to `run.sh till.ts <mode> cline`. A new
  `ClineAdapter` in `agentarium/adapters/cline.ts` maps it to the shared lifecycle and builds output in Cline's
  shape: `denyTool` returns `{ skip: true, reason }`, `askTool` returns `{ policy: { autoApprove: false } }`,
  `addContext` returns `{ appendContext }`, `blockPrompt` and `interrupt` return `{ stop: true, reason }`. The shim
  passes back only those keys and drops anything else, so a bug in agentarium can't rewrite a request.
- **Less in the payload than Cline offers.** `snapshot.messages` is the whole conversation. The shim never sends
  it: only the message count, the last user message (for sommelier's and haggle's scoring, the same text Claude
  Code's prompt hook already gets) and the usage totals. Tool inputs go through as Claude Code's do. Storage rules
  don't change: no prompt or file text is kept unless `AGENTARIUM_STORE_PROMPT` is on.
- **A deadline under Cline's.** The shim kills its child process after 2.5 seconds and returns nothing, so Cline
  never sees a timeout and never counts the plugin towards `failed`. Every hook call is wrapped so that nothing
  throws out of the shim. A killed call is recorded as `timeout` in `controller_events`, so `doctor` shows it next
  to the p90 and warns against Cline's 3-second figure.
- **One process per session, not per call.** Starting Node.js and opening SQLite for every tool call costs
  around 100 ms twice per call (before and after). The first version does exactly that, because it is simple and
  `controller_events` will measure it. If the p90 is over a second, the second version keeps one child per
  session alive (`run.sh till.ts serve-hooks cline`, one JSON line in, one out), started by the plugin's
  `setup()` and stopped by `ctx.onDispose`. It still goes through `run.sh`, as the architecture rules require.
- **Usage from `afterModel`.** `snapshot.usage` is cumulative ‡, so the adapter records the difference between
  two calls as one request's measured usage, with the model from `beforeModel`'s `request`. `afterRun`'s
  `result.usage` checks the sum. Cache fields aren't documented: until a capture shows them, `cache_info` is
  `none` and cold-snap and coldcache don't run on Cline.

**Cline's capabilities**, for the contract test and the generated table:

| Capability | Level | Note |
|---|---|---|
| `hooks` | ◐ | SDK plugin hooks through the shim; CLI and SDK hosts only |
| `prompt_decision` | ◐ | `beforeRun` stop, if it fires per user message ‡ |
| `tool_decision` | ✅ | `beforeTool` skip or approval policy |
| `context_injection` | ✅ | `appendContext` on `beforeRun`, `beforeTool` and `afterTool` |
| `tool_output_interception` | ✅ | `afterTool` returns a new `result` |
| `transcript` | ✗ | not needed: usage and messages come in the hook context |
| `token_usage` | ✅ | `usage` in the snapshot and in `afterRun` |
| `cache_info` | ✗ | not in the docs ‡ |
| `reported_cost` | ✗ | not in the docs |
| `model_selection` | ◐ | from `beforeModel`'s request ‡ |
| `proxy_endpoint` | ✅ | OpenAI-compatible provider with a base URL |
| `statusline` | ✗ | |

**What runs on Cline.**

| Helper | On Cline | Why |
|---|---|---|
| diet, groundhog, blinkers, haggle's guard | ✅ | `beforeTool` skip |
| diet's trim mode | ✅ new | `afterTool` result rewrite |
| budget, haggle, ballast, parrot | ◐ | only if `beforeRun` is per user message |
| the band's forecast | ◐ | in `appendContext`, not on a status line |
| till, report, split-the-bill | ✅ tokens, ◐ money | priced when the model has a row in the price table |
| sommelier | ◐ | through `agentarium router` as Cline's base URL; in the plugin, only if `beforeModel`'s `options` can set the model ‡ |
| cold-snap, coldcache | ✗ for now | no cache figures |

If `beforeModel` can change the model, sommelier on Cline would route per request inside the plugin, the way the
proxy does, with no subagent hand-off to pay for. That would make Cline the cheapest place to route of any
platform, so it is the second thing to test.

**Install.** `agentarium cline` writes the plugin with the absolute `run.sh` path, runs `cline plugin install` on
it at user scope and prints how to check it with `cline hub plugins`. `doctor` reads the plugin's status
(`ready`, `degraded`, `failed`) where the host reports it, and says when the plugin is installed but has never
sent an event.

**Order of work**, each a pull request:

1. Capture: a throwaway plugin that writes every hook's context keys (no values) to a file, run on one real task,
   to settle the ‡ fields, whether `beforeRun` is per message and whether `options` can set the model.
2. `ClineAdapter` with fixtures from the capture, passing the adapter contract test.
3. The shim, with a fake host in `tests/cline_shim.test.ts` that calls each hook, checks the 2.5-second deadline
   and checks that nothing but the allowed keys come back.
4. `agentarium cline` and the integration page in `docs/`.
5. diet's trim mode.
6. The per-session process, if the measured p90 asks for it.
7. Kilo Code and OpenCode entry files.

**Open questions.**

- Windows: `run.sh` needs `sh`. Claude Code always has bash there, but a Cline CLI user may not. The shim could
  look for Git Bash, or the rules could allow one Node.js entry point for in-process hosts. This needs a decision
  before step 3.
- Plugins can also register tools. An `agentarium_budget` tool the model can call to see what's left would put
  the forecast in front of the model when it plans, not only at prompt time. Worth it only if the model uses it
  unprompted; a test task would show that.
- OpenCode's docs list plugin locations and config but the hook reference page couldn't be read, and third-party
  write-ups disagree on `chat.message`. Its column in the scoring table stays † until the official types are read.

**New ideas from this pass.**

- The shim's payload rules (send counts, not the conversation; accept only known output keys) suit any future
  in-process host, and could be the definition of "an adapter for a plugin host" in the contract test.
- Cline reports plugin health itself (`degraded`, `failed`, `pluginIssues`). That is the first platform that
  tells us when our hook is failing, which is the check `doctor` can't make anywhere else.
- `afterTool` rewrites open other guards to "run, then trim" rather than "refuse": sherlock's lockfile and
  generated-file checks could cut a result in place on Cline instead of only reporting the waste afterwards.

#### Copilot's prompt hooks, retested

*Work on the last item in [More AI environments](#more-ai-environments), from Copilot's hooks reference, its CLI
hooks guide and the SDK page for `userPromptTransformed`, read on 23 November 2026. This is a docs pass: the
item stays open until one real Copilot CLI install confirms the three findings marked ‡.*

**The question.** Can a command hook in `copilot-hooks.json` now change what a Copilot prompt costs? Today the
answer is no: `userPromptSubmitted` output is dropped, so the premium guard, budget's pause and haggle's quote
only record what they would have done.

**What the docs say now.**

| Event | Output honoured | What it means for agentarium |
|---|---|---|
| `userPromptSubmitted` | `modifiedPrompt`, SDK hooks only; "command and HTTP config-file … hooks have their output dropped" | No change. Still nothing to pause with. |
| `userPromptTransformed` (new) | `modifiedTransformedPrompt`, which replaces what the model reads and what is stored in session history. "Mutation-only: it can rewrite the content the model receives, but not block or handle the turn." | Context injection, not a decision. ‡ The reference says command hooks "are supported on all hook types" and names no exception for this event, but every example is SDK code. |
| `postToolUse` | `modifiedResult` and `additionalContext`, "honored by both SDK programmatic hooks and command/HTTP config-file … hooks" | New for us. diet can trim a flooded result instead of only denying the call. |
| `postToolUseFailure` (new) | `additionalContext` | A failing check as its own event: evidence for groundhog and the outcome engine without parsing `toolResult`. |
| `agentStop`, `subagentStart`, `subagentStop`, `preCompact` | `agentStop` and `subagentStop` can block (force another turn); `subagentStart` can prepend context | ‡ Each payload has a `transcriptPath`. The docs don't name the file or its format. |

Two failure rules matter more than any of the above. Timeouts fail open for every event. A crash does not:
"`preToolUse` is fail-closed: a non-zero exit (other than exit 2) denies the tool call." The default timeout is
30 seconds; ours are 10 to 20.

**What changes, and what doesn't.**

- **The premium guard and budget's pause stay `would-pause`.** `userPromptTransformed` can't block, and
  rewriting the prompt into "please stop" would still spend the premium request it was meant to save.
  `PROMPT_DECISION` stays `none` on Copilot CLI. VS Code, whose prompt hook can stop a prompt, is unaffected.
- **Context injection moves from `none` to `partial`** ‡, through `userPromptTransformed`: append the note to
  `transformedPrompt` and return it. That lets haggle's quote, doggybag's hand-off note and blinkers' scope
  reach the model on Copilot. It must append, never rewrite, and must return the prompt unchanged on any
  error, because the replacement is what session history keeps. It is also where a prompt would be stored by
  mistake, so the hook writes nothing to disk.
- **Tool-output interception moves from `partial` to `native`.** diet on `postToolUse` can return a trimmed
  result and a note of what was cut. On Copilot the note gives tokens ("cut 38,000 tokens of lockfile"), never
  money or premium requests, since trimming a result doesn't save a request.
- **sommelier still can't route on Copilot.** A note in the prompt can't change Copilot's model, and the
  multiplier is set by the model, not by the prompt. The way in remains the generic provider layer where a
  Copilot client takes a base URL.
- **A crash now costs the user.** Before, every Copilot hook failed open. A `preToolUse` script that throws
  before its own `try` (a bad import, a syntax error on an old Node.js) exits 1 and denies the tool call.
  `run.sh` already exits 0 when Node.js is missing, but `exec` passes Node's own exit code through. diet,
  groundhog and blinkers need a launcher-level guarantee of exit 0 on `preToolUse`, with a test that a script
  which fails to load still lets the call through.

**Order of work**, each a pull request:

1. The fail-closed fix: `run.sh` gains a mode that runs the script and maps any exit code but 0 and 2 to 0,
   used by every `preToolUse` entry in `copilot-hooks.json`, with a test for a script that fails to load.
2. `postToolUse` output in the Copilot adapter (`replaceResult(text)` on the base class, `null` where a
   platform can't), and diet trimming on Copilot behind `AGENTARIUM_DIET_TRIM=off`, logged in `diet_events`.
   *Half done:* the base class has `toolOutput` and `replaceOutput` (Copilot's is `modifiedResult`), and colander
   uses them on `postToolUse`. diet's trim mode is still to come.
3. One real install to settle the three ‡ marks: does a command hook on `userPromptTransformed` run and is its
   output honoured; what `transcriptPath` points at; and whether it has usage or a model id.
4. If step 3 says yes: `userPromptTransformed` in `copilot-hooks.json`, `addContext` for Copilot built on it,
   and the controller's Copilot steps passing their notes through it. `CONTEXT_INJECTION` becomes `partial`,
   with the CLI version it was confirmed on in the note.
5. `postToolUseFailure` mapped to a failed `tool_result`, so `missEvidence` and the outcome engine see it.

**New ideas from this pass.**

- If `transcriptPath` on `agentStop` is the session's `events.jsonl`, `sessionModel` can read it directly
  instead of guessing the session-state folder, and the transcript capability could become `partial`.
- `agentStop` can force another turn, and Copilot caps that at 8 in a row. Nothing in agentarium should ever
  use it: a forced turn is a premium request the user didn't ask for. The adapter should declare it and the
  contract test should fail any helper that returns `decision: "block"` on a stop event for a premium-billed
  platform.
- `userPromptTransformed` runs "for every preceding message in a batched submission". A note appended to each
  would repeat, so the hook should only append on the last message of a batch, once the real payload shows how
  to tell them apart.
- `preToolUse` treats `ask` as `deny` in the cloud agent, where no one can answer. `askTool` on Copilot should
  return `null` when the payload says it is a cloud run, so a guard that meant "check with the user" doesn't
  silently become a refusal.

#### Scoring the Priority 2 candidates

*Scored against the vendors' own pages on 23 November 2026, the same way as [Priority 1](#scoring-the-priority-1-candidates).*
Pages read: Gemini CLI's hooks reference, Antigravity's hooks page, Kiro's hook types and v3 migration pages,
Devin CLI's hooks overview, Zed's API access and external agents pages, and Gemini Code Assist's agent mode page.
Windsurf's hooks page now redirects to Devin's docs and the English page didn't list its payload, so the
Windsurf column comes from translated copies and a third-party connector's docs (†). Aider has no hooks;
its column is from community write-ups (†). Fields marked ‡ are from API references as we know them and
need checking against a live response.

**Nine names, seven pieces of work.** Two of the nine are the same product as another:

- **Gemini Code Assist's agent mode runs on Gemini CLI**, by Google's own description, and is read from the
  same settings. One adapter covers both. Agent mode is VS Code only: JetBrains has no agent mode, so Code
  Assist in JetBrains is reached through the provider layer or not at all.
- **Kiro CLI is what Amazon Q Developer CLI became.** Q's old context hooks are deprecated in favour of agent
  hooks, and Kiro's `kiro-cli agent migrate` converts them. One adapter, written for Kiro CLI v3, with Q's
  2.x event names (`agentSpawn`, `userPromptSubmit`, `preToolUse`) as aliases.

And two aren't adapters at all:

- **Zed has no hooks of its own.** Its external agents (Claude Code, Codex, Gemini CLI, Copilot CLI,
  OpenCode) run over the Agent Client Protocol, so each brings its own hooks and our adapter for it. Zed's
  own agent takes an `openai_compatible` provider with an `api_url`, which is the provider layer.
- **Aider has no hooks.** It takes an OpenAI-compatible base URL (it calls models through LiteLLM), and its
  chat history file has a line per message with tokens sent and received and the cost (†). That is an
  importer for the provider layer, with the cost as `reported`.

**The capability table**, same legend as Priority 1 (✅ native, ◐ partial, ✗ none, ? not documented):

| Capability | Gemini CLI (+ Code Assist agent mode) | Kiro CLI v3 (+ Q Developer CLI) | Antigravity | Windsurf / Devin Desktop † |
|---|---|---|---|---|
| `hooks` | ✅ command hooks in `settings.json` (system, user, project, extensions) | ✅ `.kiro/hooks/*.json`, `~/.kiro/hooks/` or an agent profile | ✅ `hooks.json` (workspace `.agents/`, global `~/.gemini/config/`, plugins) | ✅ shell hooks, system, user and workspace merged |
| `prompt_decision` | ✅ `BeforeAgent` can deny the prompt or stop the turn | ◐ `UserPromptSubmit` can't block in the CLI (the IDE's prompt trigger can) | ◐ no prompt hook; `PreInvocation` can end the run before each model call and sees `lastUserInput` | ✅ `pre_user_prompt` blocks with exit 2 |
| `tool_decision` | ✅ `BeforeTool` deny or exit 2, can rewrite arguments | ✅ `PreToolUse` exit 2; `PermissionRequest` deny (3.4.0+); a call Kiro already approved can't be stopped | ✅ `PreToolUse` deny, ask or force-ask, can rewrite arguments | ✅ `pre_run_command`, `pre_write_code`, `pre_read_code`, `pre_mcp_tool_use` block with exit 2 |
| `context_injection` | ✅ `additionalContext` on `BeforeAgent`, `AfterTool` and `SessionStart` | ◐ stdout into context on `SessionStart` and `PreCompact` (3,000 characters) | ✅ `injectSteps` on `SessionStart`, `PreInvocation` and `PostInvocation` | ? |
| `model_selection` | ✅ `BeforeModel` sees `llm_request.model` and can change it | ? | ✅ `modelName` in every payload; read only | ? |
| `token_usage` | ? `usageMetadata` is in the response type, not listed in `AfterModel`'s input | ? | ? | ? |
| `transcript` | ✅ `transcript_path` in every payload | ✗ (a compaction summary only) | ✅ `transcriptPath` (`transcript.jsonl`) | ? |
| `proxy_endpoint` | ◐ `GOOGLE_GEMINI_BASE_URL`, with an API key only: Google sign-in bypasses it (†) | ? | ✗ an OpenAI-compatible endpoint in settings is reported not to work | ? |
| `statusline` | ✗ | ✗ | ✗ | ✗ |
| Timeout, failure | 60 s; fails open (any exit but 2 is a warning) | per hook, no default stated; † fails closed on `PreToolUse` | 30 s; failure not documented | ? |

**The ranking**, by what agentarium could prevent there:

1. **Gemini CLI.** The best fit after Codex, and better than Codex in one way: `BeforeModel` can change the
   model per request, so sommelier can route inside the hook with no proxy and no subagent hand-off. That is
   the cheapest kind of route there is, since the context isn't re-sent. Both decisions, context on the prompt,
   a transcript and fail-open hooks mean budget, haggle, diet, groundhog and the band's forecast all run. One
   thing to settle first: whether `AfterModel`'s input carries `usageMetadata`. If not, usage comes from the
   transcript, or from the proxy where the user signs in with an API key. Its payload is snake_case with
   Claude-like names but different events, so it gets a field map, not the Claude-shaped base as is.
2. **Kiro CLI.** The closest to Claude Code's event names of any candidate (`SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`), so it is the third user of the `ClaudeShapedAdapter`
   base after Codex and Junie. Tool guards run; prompt-time guards can only add context, not pause, until the
   CLI's prompt hook can block. No model, usage or transcript, so its figures are counts and `estimated`
   costs, and it ships at `partial`.
3. **Google Antigravity.** Strong guards: tool deny with an ask option, and `PreInvocation`, which fires
   before every model call and can end the run. That is a better place for budget than a prompt hook, since it
   catches the tenth call of a long turn too. `modelName` and `transcriptPath` in every payload give the
   forecast something to work from. Missing: a prompt hook (sommelier can't route) and a working base URL. Its
   payload is camelCase with its own events, so it needs its own adapter, and its output format (`injectSteps`,
   `terminationBehavior`) its own builders.
4. **Windsurf / Devin Desktop.** Prompt and tool blocking on paper, but nothing confirmed about context,
   model or usage. Wait for the English payload reference, then score it again. The Devin CLI is a separate
   product with Claude-shaped hooks (below).
5. **OpenCode**, through [the plugin shim](#the-plugin-shim), which already plans an OpenCode entry file.
6. **Aider**, as an importer: `till.ts import` learns its history file's cost lines, and the user can point
   it at `agentarium router` for measured usage. No guards.
7. **Zed**, no work beyond the provider layer and a page saying which ACP agents bring their own hooks.

**Change to the milestone.** Priority 2 starts with Gemini CLI, and it could move ahead of Cursor in Priority 1:
it has more of what agentarium needs, and Cursor has no usage at all. Kiro CLI follows, as a config file on the
Claude-shaped base. Windsurf waits for its docs.

**What it adds to the provider layer.** A third wire format, Gemini's `generateContent`, with usage in
`usageMetadata`: `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount` and `thoughtsTokenCount` ‡,
streamed on the last chunk ‡. Gemini CLI, Code Assist and Antigravity all speak it, so the meter's parser for
it should come in step 3 of the provider layer with the two OpenAI ones.

**Open questions.**

- Do Claude Code's, Codex's and Gemini CLI's own hooks fire when they run inside Zed over ACP? If they do,
  Zed users get agentarium with no work; if not, the ACP adapters are the place to ask for it. One install
  each answers it.
- Gemini CLI's `BeforeModel` can swap the model, but does a mid-turn swap keep the cache? On Gemini the
  cached prefix is per model, so a route down could pay a cold cache, as a Claude subagent does. sommelier's
  hand-off pricing should apply to it unchanged.
- Antigravity's CLI doesn't load hooks from its own `settings.json`, only from `hooks.json`. The installer must
  write the right file, and `doctor` should say when hooks sit in the ignored one.

**New ideas from this pass.**

- **The Devin CLI reads Claude Code's hooks by default** (`.claude/settings.json` and `~/.claude/settings.json`,
  through `read_config_from.claude`), with a Claude-shaped payload but no `transcript_path` documented. So
  agentarium's Claude Code hooks may already run under Devin and record its sessions as Claude Code ones. The
  registry should tell the two apart (by an environment variable or a missing field) and pick a `devin`
  field map, or the reports will mix them. It is the same problem [the Cursor adapter](#the-cursor-adapter) found, so
  one detection step in the registry should cover both.
- Per-model-call hooks (`BeforeModel` in Gemini CLI, `PreInvocation` in Antigravity, `PreModelRequest` in
  Codex) are now in three tools. A `model_call` capability, separate from `prompt_decision`, would let budget,
  haggle and the band act per request on any of them, which is what the proxy does today. That makes the
  proxy optional wherever the hook exists.
- Several hook systems can rewrite tool arguments (`tool_input`, `overwrite`, `updatedInput`). diet could use
  that to cap a command's output (append `| head -n 200` to a flood-prone command) instead of blocking it,
  which saves the tokens without costing the agent a retry. It needs care and an opt-in, since it changes what
  the user's agent runs.

#### The browser builders

*Research for the Priority 3 item in [More AI environments](#more-ai-environments), from the vendors' own help and
API pages on 23 November 2026. Cells marked ‡ come from search results because the page could not be fetched,
and need checking before code depends on them.*

**The short answer.** All four run the agent on the vendor's servers, in the vendor's browser tab. There is no
hook, no transcript and no base URL to point at a proxy, so nothing agentarium does before a prompt or a tool
call can run there. What is left is the receipt, and only v0 hands it over through an API. That decides the
plan: no adapters, one importer, one metered upstream and an honest page.

| | Replit Agent | Bolt.new | Lovable | Vercel v0 |
|---|---|---|---|---|
| Billed in | credits, effort-based: one checkpoint per request, priced by the work done (it was a flat $0.25 per checkpoint) | Bolt's own tokens: 1M a month free (300K a day), 10M on Pro | build credits per message (Plan mode 1 credit), run credits for hosting, Cloud and AI calls | credits; the usage report gives a cost per message |
| Where a user sees cost | hover over the usage icon per checkpoint; usage dashboard, up to 30 minutes behind | the balance under Billing & usage; no per-message figure | per message in the history (the three-dots menu); run credits by project, category and day | the dashboard, and the same data from the API |
| Usage API or export | ✗ none documented | ✗ none documented; support answers account questions | ✗ none documented | ✅ `GET /v1/reports/usage`: `totalCost`, `promptCost`, `completionCost`, `chatId`, `messageId`, user and type; no model or token counts; 60 requests a minute |
| Hooks, transcript, base URL | ✗ | ✗ (bolt.diy, the open-source fork, takes an OpenAI-compatible base URL ‡) | ✗ | ✗ for the app; the v0 Model API is itself an OpenAI Chat Completions endpoint at `https://api.v0.dev/v1` ‡ |
| The vendor's own guard | usage alerts and hard budget caps in Settings → Billing | a daily cap on Free only | a monthly spend limit on auto top-up and per-member limits on build credits | ? not found |
| What drives the cost | how much the agent does per request; context sent to the model | reading and syncing project files, so the cost per message grows with project size | request complexity in build mode; the model and tokens behind AI calls in the deployed app | the model and message length |

**What agentarium can do there.**

1. **Import v0's usage report.** A `v0` importer for the provider layer's step 5 (`till.ts import --v0`, with
   a key from `V0_API_KEY` that is never stored) reads `/v1/reports/usage` into `provider_events` with
   `source = 'reported'`, one row per message, keyed by `chatId` so unified reporting counts a chat as a session.
   It is the only one of the four where a report can be filled in without the user typing anything.
2. **Meter the v0 Model API like any other provider.** A tool that calls `v0-1.5-md` through its base URL
   (Cline, Codex, Cursor) goes through the named upstreams already designed (`v0=https://api.v0.dev/v1`) and
   the OpenAI Chat Completions parser. That is measured usage and the band's forecast, with no v0-specific code.
3. **Credits are their own unit.** A new billing model, `vendor_credits`, sits beside Copilot's premium requests.
   Replit's, Lovable's and v0's credits are counted, never converted to money and never added to a money
   column, unless the user gives a rate (`AGENTARIUM_CREDIT_RATES=lovable=0.10`, their figure, as with Copilot's
   multipliers). Bolt's "tokens" are a plan unit too, not model tokens, so they are credits here and are never
   priced from `model-prices.json`.
4. **One page, no adapter.** `docs/integrations/browser-builders.md` says, per builder, what agentarium sees
   (nothing, a manual CSV or an API) and which of the vendor's own guards to switch on: Replit's hard cap,
   Lovable's monthly spend limit. Pointing people at a cap that already exists prevents more spend than
   anything we could build around these tools.
5. **Check the synced repository.** Bolt and Lovable can sync a project to GitHub. Bolt says most of its
   per-message cost is reading project files, so a lean repository is cheaper to build on. pack-light and
   spring-clean already measure that kind of load on a repository; run in CI on the synced repo, they could name
   the large and unused files Bolt re-reads on every message. This is the one piece that changes the next
   step's cost, and it needs a check that the sizes they report track Bolt's token use.

**What we won't do.** A browser extension that reads costs off the page would see prompt text and project code
in the user's tab, break with every redesign and still prevent nothing. It fails the privacy rule and the test at
the top of the roadmap, so it is out.

**Order of work**, after the provider layer's importer step:

1. The `vendor_credits` billing model and `AGENTARIUM_CREDIT_RATES`, with unified reporting showing credits in
   their own column.
2. The v0 importer, with a recorded fixture of the usage report.
3. `v0` as a named upstream, with a fixture from a real Model API response that confirms the `usage` fields ‡.
4. The integrations page for the four builders.
5. pack-light and spring-clean on a Bolt-synced repository, once one real project shows whether file size
   tracks Bolt's token use.

**Open questions.**

- Is v0's `totalCost` in US dollars or in credits? The reference doesn't say. Until a live response settles it,
  the importer records it as credits.
- Replit and Lovable show a per-request cost in the app. If either adds an export or an API, it takes one column
  map to import, so the integrations page should invite a pull request for it.
- Replit's "intelligent model routing" on Core and Pro is a sommelier of its own. Nothing about it is exposed,
  so we can't measure or tune it, only say that it exists.

**New ideas from this pass.**

- `vendor_credits` generalises a rule we already keep for Copilot: never turn a unit the vendor didn't price into
  money. Kiro, Windsurf and Cursor also sell credits or requests, so the same billing model may cover several
  Priority 2 platforms.
- The vendors' hard caps (Replit, Lovable) are prevention we don't have to build. `doctor` could ask once which
  builders a team uses and list the cap to set in each, matched to the user's `AGENTARIUM_BUDGET_MONTHLY`.
- v0's usage report gives a per-chat cost with a user on every row, which is the shape split-the-bill already
  reads. A team on v0 could get the same "who spent it" view as a Claude Code team from one API key.
