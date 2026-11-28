<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# Configuration

agentarium works out of the box. Everything here is optional.

Settings are environment variables. Set them in your shell profile, or in Claude Code's `settings.json` under `"env"`:

```json
{
  "env": {
    "AGENTARIUM_CURRENCY": "USD",
    "AGENTARIUM_BUDGET_DAILY": "20",
    "AGENTARIUM_PENNYWISE": "warn"
  }
}
```

---

## Profiles and the config file

Most people don't need to touch individual settings. Pick a profile:

| Profile | What it changes |
|---|---|
| `frugal` | pennywise routes down harder (`SIMPLE=haiku,MEDIUM=haiku,COMPLEX=sonnet,REASONING=opus`) and never up; diet, groundhog and ballast pause rather than warn (ballast from 40,000 tokens); hold-up pauses pastes from 5,000 tokens; too-many-cooks refuses needless subagents; cache-buster asks before an instruction-file edit; budgets warn at 70% |
| `balanced` | nothing: the defaults |
| `quality` | never below Sonnet, Fable for reasoning (`SIMPLE=sonnet,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable`); no budget squeeze (the budget's pause still applies); diet, groundhog, ballast and hold-up warn instead of pausing |

```bash
agentarium profile frugal     # writes "profile" to ~/.agentarium/config.json
agentarium profile            # shows every setting in effect and where it came from (env, config or profile)
agentarium profile off        # back to the defaults
```

Or set `AGENTARIUM_PROFILE=frugal` for one shell or one project.

**Your own defaults in one file.** `~/.agentarium/config.json` also takes any setting below under `"settings"`, so you don't have to spread them across shell profiles and `settings.json` files:

```json
{
  "profile": "frugal",
  "settings": {
    "budget_daily": 20,
    "currency": "USD",
    "copilot_allowance": 300,
    "AGENTARIUM_DIET_MAX_KB": 128
  }
}
```

A lower-case key is the setting's name without `AGENTARIUM_` (`budget_daily` = `AGENTARIUM_BUDGET_DAILY`). **Order: an environment variable always wins, then config.json, then the profile.**

**A profile per project.** `"projects"` picks a profile by folder: the longest path prefix of the folder the assistant runs in wins (`~` works), so a subfolder can differ from its parent. A key without a slash matches `AGENTARIUM_PROJECT` instead.

```json
{
  "profile": "balanced",
  "projects": { "~/work/payments": "quality", "~/scratch": "frugal" }
}
```

**A profile for a tight day.** Set `"budget_profile": "frugal"` under `"settings"` (or `AGENTARIUM_BUDGET_PROFILE=frugal`). Once today's budget (`AGENTARIUM_BUDGET_DAILY`, or the monthly allowance's share for today) passes its warning share, the budget hook marks the day in `~/.agentarium/budget_phase.json`. From the next prompt to the end of the day, that profile applies everywhere, over `"projects"` and `"profile"`. It's off until you set it. A session budget doesn't trigger it: a profile applies to every session at once.

**Which profile wins:** `AGENTARIUM_PROFILE`, then the budget phase, then `"projects"`, then `"profile"`. `agentarium profile` says which one is in effect and why. Every helper reads its settings the same way, including the standalone statusline (which reads `"settings"` but has no profile-dependent settings).

---

## All settings

### Guards

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_PENNYWISE` | `route` | `route` (hand each prompt to a subagent on the model its tier needs), `block` (pause and suggest `/model`), `warn` (notice only), `proxy` (leave routing to `agentarium router serve`) or `off`. |
| `AGENTARIUM_PENNYWISE_UP` | `on` | `off` stops the hook routing prompts *up* to a stronger model; it then only routes down. |
| `AGENTARIUM_PENNYWISE_BUDGET` | `on` | Once a budget passes its warning share, pennywise routes down harder and never up. `off` ignores the budget. |
| `AGENTARIUM_PENNYWISE_OVERHEAD` | `on` | pennywise only routes down when the saving beats the cost of the hand-off. `off` routes anyway. |
| `AGENTARIUM_PENNYWISE_EVAL` | `hash` | What pennywise keeps of each miss for `router eval --mine`: `hash` (the prompt's hash and score), `text` (the wording too, opt-in) or `off`. |
| `AGENTARIUM_PENNYWISE_LEARN` | `on` | Use the threshold offsets (and applied tier swaps) that `agentarium router learn` wrote to `~/.agentarium/pennywise_learned.json`. `off` ignores them. |
| `AGENTARIUM_CONTROLLER_TIMING` | `on` | The controller times each prompt-time helper and keeps the last 20,000 step times in `controller_events`, for `agentarium doctor`. `off` records nothing. |
| `AGENTARIUM_CONTROLLER_SLOW_MS` | `150` | `agentarium doctor` flags a prompt-time helper whose median time is at least this many milliseconds. |
| `AGENTARIUM_CONTROLLER_SKIP` | none | Prompt-time helpers the controller leaves out entirely, e.g. `parrot,blinkers`. Each helper's own switch is usually what you want instead. |
| `AGENTARIUM_PROFILE` | none | `frugal`, `balanced` or `quality` (see [Profiles](#profiles-and-the-config-file)). Wins over the budget phase, `"projects"` and `"profile"` in config.json. |
| `AGENTARIUM_BUDGET_PROFILE` | none | Opt in to a profile for a tight day, e.g. `frugal`: once today's budget passes `AGENTARIUM_BUDGET_WARN`, it applies for the rest of the day, from the next prompt. |
| `AGENTARIUM_DIET` | `block` | `block`, `warn` (notice only, never stops a call) or `off` for diet. |
| `AGENTARIUM_DIET_MAX_KB` | `64` | diet never blocks a file smaller than this. |
| `AGENTARIUM_DIET_LEARN` | `on` | Record how much each `Read` and `Bash` call printed (by program name or file extension only) and ask for a filter once a program typically floods the context. `off` records nothing. |
| `AGENTARIUM_COLANDER` | `on` | Strain the output of a test run, build, lint or install that succeeded before the model reads it, keeping the full output in `~/.agentarium/colander/` for a day. `off` passes every output through untouched. |
| `AGENTARIUM_COLANDER_MAX_LINES` | `60` | colander shows at most this many lines of a strained output (10 to 2,000), plus every failure and the 20 lines after it. |
| `AGENTARIUM_COLANDER_COMMANDS` | none | More programs for colander to strain, by name, comma separated, e.g. `ci.sh,just`. |
| `AGENTARIUM_HOLDUP` | `block` | A prompt that pastes in a huge log, data dump, diff, source file or document: `block` (pause it once; send it again to go ahead), `warn` (a notice; the paste still goes in) or `off`. |
| `AGENTARIUM_HOLDUP_MIN_TOKENS` | `10000` | hold-up stays quiet for prompts smaller than this (10,000 tokens is about 40 KB). |
| `AGENTARIUM_HOLDUP_BROAD` | as `AGENTARIUM_HOLDUP` | A short prompt that is blatantly too broad ("refactor the whole codebase", "fix all the bugs") with no file, function or error named: `block`, `warn` or `off`. |
| `AGENTARIUM_CACHEBUSTER` | `warn` | Before an edit to an instruction file, settings, the MCP server list or a skill mid-session: `warn`, `ask` (confirm first), `block` (the agent leaves it as a note) or `off`. |
| `AGENTARIUM_CACHEBUSTER_MIN_TOKENS` | `10000` | cache-buster stays quiet in sessions with less context than this. |
| `AGENTARIUM_TOOMANYCOOKS` | `warn` | Before a subagent that overlaps one already sent, does a single lookup or is one too many: `warn`, `ask`, `block` (the agent does the work itself) or `off`. |
| `AGENTARIUM_TOOMANYCOOKS_FANOUT` | `5` | Subagents since your last prompt before too-many-cooks speaks up. |
| `AGENTARIUM_KETTLE` | `on` | When Claude Code waits for you: `on` (a terminal notification with the time until the cache goes cold), `desktop` (a system notification too, macOS and Linux) or `off`. |
| `AGENTARIUM_KETTLE_MIN_TOKENS` | `20000` | kettle stays quiet in sessions with less context than this. |
| `AGENTARIUM_BUDGET_DAILY` | none | Daily spending limit in your currency, e.g. `20`. No limit = budget does nothing. |
| `AGENTARIUM_BUDGET_SESSION` | none | Per-session spending limit in your currency. |
| `AGENTARIUM_BUDGET_MONTHLY` | none | A monthly allowance in your currency, e.g. `500`. Each day's limit is what's left of it (spend before today) divided by the working days left until it resets, today included. With `AGENTARIUM_BUDGET_DAILY` also set, the lower of the two applies. |
| `AGENTARIUM_BUDGET_RESET_DAY` | `1` | Day of the month the allowance resets (`1` to `31`; a day past the end of a short month means its last day). |
| `AGENTARIUM_BUDGET_WORKDAYS` | `mon-fri` | The days you work, e.g. `mon-sat`, `sun-thu`, `mon,wed,fri` or `all`. |
| `AGENTARIUM_BUDGET_DAYS_OFF` | none | Holidays that don't count as working days: dates or ranges, e.g. `2026-12-24..2026-12-31,2027-01-04`. |
| `AGENTARIUM_BUDGET_WARN` | `80` | Percent of a limit at which budget shows a notice. |
| `AGENTARIUM_BUDGET_MODE` | `block` | `block`, `warn` (notices only) or `off`. |

### Value, waste and quality

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_BANGFORBUCK` | `on` | `off` stops bang-for-buck writing the ledger at the end of each turn (waistline and haggle then have no history to learn from). |
| `AGENTARIUM_HAGGLE` | `quote` | `quote` (quote substantial tasks, warn past the estimate and cap, enforce only prices you set with `haggle £X:`), `strict` (enforce every quote's cap) or `off`. |
| `AGENTARIUM_HAGGLE_MIN` | `0.50` | Smallest estimate, in your currency, that gets a contract (complex prompts always do). |
| `AGENTARIUM_HAGGLE_CAP_X` | `2` | An automatic contract's cap is this many times the estimate. |
| `AGENTARIUM_GROUNDHOG` | `block` | `block` (refuse a looping call, at most twice, then let it through and tell you), `interrupt` (refuse once, then end the turn), `warn` or `off`. |
| `AGENTARIUM_GROUNDHOG_REPEAT` | `3` | groundhog catches the Nth identical call with nothing changed in between. |
| `AGENTARIUM_GROUNDHOG_FAILS` | `3` | groundhog catches a command that has failed this many times in a row. |
| `AGENTARIUM_SHERLOCK` | `on` | `off` stops sherlock logging each session's waste at session end (the `sherlock` skill and tool still work). |
| `AGENTARIUM_WAISTLINE` | `on` | `off` silences waistline's once-a-day cost-creep notice at session start. |
| `AGENTARIUM_WAISTLINE_THRESHOLD` | `15` | Percent rise that counts as a cost regression. |
| `AGENTARIUM_SPRINGCLEAN_MAX` | `1500` | Tokens one instruction file should stay under. |
| `AGENTARIUM_TASTETEST_TIMEOUT` | `600` | Seconds each taste-test check may run. |
| `AGENTARIUM_BALLAST` | `warn` | Context carried between tasks: `warn` (a notice), `block` (pause the prompt once; send it again to go ahead) or `off`. |
| `AGENTARIUM_BALLAST_MIN_TOKENS` | `60000` | ballast stays quiet below this context size, and speaks again at each multiple of it. |
| `AGENTARIUM_WAFFLE_LONG` | `500` | Reply length, in tokens, above which waffle counts the excess as avoidable. |
| `AGENTARIUM_PARROT` | `warn` | Repeated instructions: `warn` (a notice once a rule, correction or prompt reaches a few sessions) or `off`. |
| `AGENTARIUM_PARROT_MIN` | `3` | Different sessions a phrase must appear in before parrot mentions it (2 to 50). |
| `AGENTARIUM_FISHINGROD` | `on` | Lessons in the notices (hold-up, ballast, parrot, haggle, pennywise, doggybag, budget): `on` (the why and what to do next time, then a one-line pointer), `always` (the full lesson every time) or `off`. |
| `AGENTARIUM_FISHINGROD_TIMES` | `3` | How many times each lesson is shown in full before it shrinks to a pointer (at most once per session; 0 to 100). |
| `AGENTARIUM_PLAN` | (none) | Your Claude plan for all-you-can-eat: `api` (pay-as-you-go), `pro`, `max5`, `max20`, or an id you added in `~/.agentarium/plans.json`. |

### Intelligence engine

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_BLINKERS` | `ask` | Scope guard: `ask` (hold the first out-of-scope edit to each file until you confirm: a confirm prompt in Claude Code, a refusal that makes the agent ask in Copilot), `block` (refuse; the agent must ask in chat), `warn` (tell you, never stop anything) or `off`. |
| `AGENTARIUM_BLINKERS_FILES` | 3 per named file, at least 6 | Most files one task may change before blinkers asks. |
| `AGENTARIUM_TELEMETRY` | `on` | `off` stops till storing each hook event in the shared format (`telemetry_events`). Copilot sessions then get no status in split-the-bill and deadwood. |
| `AGENTARIUM_DEVELOPER` | your user name | Who the work is attributed to in split-the-bill. Set a team handle to share reports; an email address is never used. |
| `AGENTARIUM_PROJECT` | the repository's name | Attribute every session to this project instead. pennywise also learns its thresholds per project under this name. |

Provider prices, benchmark scores, latency and availability for bazaar and crystal-ball go in `~/.agentarium/providers.json` (see [bazaar](reference.md#bazaar)). Plan prices for all-you-can-eat go in `~/.agentarium/plans.json` (see [all-you-can-eat](reference.md#all-you-can-eat)).

### pennywise router

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_ROUTER_TIERS` | `SIMPLE=haiku,MEDIUM=sonnet,COMPLEX=opus,REASONING=opus` | Which model each tier goes to. Aliases or full model ids. Also `"tiers"` in `~/.agentarium/router.json`. |
| `AGENTARIUM_ROUTER_PORT` | `8787` | Port for `agentarium router on` / `serve`. |
| `AGENTARIUM_ROUTER_UPSTREAM` | `https://api.anthropic.com` | Where the proxy forwards requests. |
| `AGENTARIUM_ROUTER_MODELS` | `pennywise,auto` | Request model names the proxy routes; `*` routes every main-model request. |
| `AGENTARIUM_ROUTER_FALLBACK` | the `COMPLEX` model | Model a failed routed request is retried on. |
| `AGENTARIUM_ROUTER_STICKY_TOKENS` | `20000` | Above this context, the proxy won't move down to a cheaper model while the cache is warm. |

Score thresholds go in `~/.agentarium/router.json` as `"thresholds": {"MEDIUM": 0.15, "COMPLEX": 0.5, "REASONING": 0.95}`. What `learn` finds is applied on top of the defaults first, so `router.json` and `AGENTARIUM_ROUTER_TIERS` still win.

### doggybag

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_DOGGYBAG` | `on` | `off` stops doggybag from packing or watching. |
| `AGENTARIUM_DOGGYBAG_LEAD` | `60` | Seconds before the cache expires to pack the doggybag. |
| `AGENTARIUM_DOGGYBAG_DIR` | `.doggybag` | Folder inside the project. An absolute path keeps every project's doggybags there instead. The newest 10 are kept (`AGENTARIUM_DOGGYBAG_KEEP`). |
| `AGENTARIUM_DOGGYBAG_MAX_AGE_H` | `24` | Hours a doggybag is offered to a new session for. |
| `AGENTARIUM_DOGGYBAG_INJECT` | `1` | A new session or `/clear` loads the folder's latest doggybag, and compaction loads back the one packed just before it. `0` only tells you it exists. |
| `AGENTARIUM_DOGGYBAG_COLD` | `warn` | On the first prompt after the cache went cold: `warn`, `block` (pause once) or `off`. |
| `AGENTARIUM_DOGGYBAG_COLD_MIN_TOKENS` | `20000` | Stay quiet about cold prompts in sessions smaller than this. |

The older `AGENTARIUM_HANDOFF_*` names still work.

### till and data

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_DB` | `~/.agentarium/till.db` | Where the database file lives. Point it at a shared location to collect several machines' data. |
| `AGENTARIUM_STORE_PROMPT` | off | Set to `1` to keep a 200-character excerpt of each prompt. Off by default for privacy. |
| `AGENTARIUM_SKILL_MAP` | none | Path to a JSON file that tells till which side a skill belongs to, e.g. `{"our-grafana-skill": "opex", "pdf": "capex"}`. This always wins over the built-in guessing. |

### AI classifier (optional)

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_LLM` | off | Set to `1` to have an AI model decide OPEX or CAPEX at session end (see [the reference](reference.md#optional-let-an-ai-model-decide)). Sends redacted prompt text to the endpoint. |
| `AGENTARIUM_LLM_URL` | `https://api.openai.com/v1/chat/completions` | Any OpenAI-compatible chat endpoint. A non-default URL needs no key, so local models work. |
| `AGENTARIUM_LLM_KEY` | `OPENAI_API_KEY` | API key for that endpoint. |
| `AGENTARIUM_LLM_MODEL` | `gpt-4o-mini` | Which model to ask. |
| `AGENTARIUM_LLM_TIMEOUT` | `12` | Seconds to wait before falling back to keywords (capped at 15 to fit the 20-second hook limit). |

### Display, currency and prices

| Setting | Default | What it does |
|---|---|---|
| `AGENTARIUM_STATUSLINE` | `auto` | The CLI statusline (terminal): what the plugin does at session start when no status line is set. `auto` (or unset) installs the statusline, `ask` shows a one-time tip instead, `off` stays quiet. Someone else's status line is never replaced, and an installed statusline is always kept up to date. `AGENTARIUM_STATUSBAR`, its old name, still works. |
| `AGENTARIUM_BAND` | on | The band: `off` hides the line above the prompt box in the desktop app, the VS Code line and after-reply message that stand in for it, the pane's numbers, and Copilot's numbers (VS Code's status bar item and the `agentarium copilot --window` window); `on` shows them. Overrides `--band-off` / `--band-on`. |
| `AGENTARIUM_OUTLOOK` | on | The forecast row under the terminal statusline: `off` keeps the statusline to one line; `on` shows the row. Overrides `--outlook-off` / `--outlook-on`. |
| `AGENTARIUM_THEME` | `system` | Statusline colours in the terminal: `light`, `dark` or `system`. |
| `AGENTARIUM_CURRENCY` | `GBP` | Currency for every cost shown, to two decimal places up to 25 and in whole units above it: `GBP` (£), `USD` ($) or `EUR` (€). Also saved by `statusline.ts --set-currency`. |
| `AGENTARIUM_USD_EUR` | `0.86` | Euros per dollar, when the currency is EUR. |
| `AGENTARIUM_USD_GBP` | `0.76` | Pounds per dollar, when the currency is GBP. |
| `AGENTARIUM_CACHE_TTL` | auto | Cache lifetime in seconds for the statusline's countdown, and for pennywise's warm or cold cache when it prices a hand-off. |
| `AGENTARIUM_ASCII` | off | `1` draws the statusline in plain characters (as `--ascii` does). `NO_COLOR=1` (or `--no-color`) drops the colours. |
| `AGENTARIUM_TIMER_ICONS` | the pie clock | Three icons for the cache countdown, full to empty, e.g. `🟢,🟡,🔴`. |
| `AGENTARIUM_COPILOT_ALLOWANCE` | not set | Your monthly Copilot premium requests (e.g. 300). Turns on the Copilot statusline's forecast row, `agentarium copilot` and the premium guard. |
| `AGENTARIUM_PREMIUM` | `block` | The Copilot premium guard: `block` pauses the next prompt once the allowance is used up (send it again to carry on), `warn` shows a notice, `off`. Copilot ignores prompt-hook output today, so until it honours it the guard only records `would-pause` in `premium_events`. |
| `AGENTARIUM_COPILOT_MULTIPLIER` | `1` | Premium requests one prompt costs on a Copilot model that `AGENTARIUM_COPILOT_MULTIPLIERS` doesn't name, or when the model isn't known. |
| `AGENTARIUM_COPILOT_MULTIPLIERS` | none | Per-model multipliers, e.g. `claude-haiku-4.5=0.33,gpt-4.1=0,claude-opus=10`. A key matches any model id that contains it; the longest wins. Take the figures from GitHub's page for your plan. Under Copilot Fusion the key for the model it routed to applies. |
| `AGENTARIUM_COPILOT_HOME` | `COPILOT_HOME`, else `~/.copilot` | Where Copilot CLI keeps `session-state/` and `config.json`, read for the session's model. |
| `AGENTARIUM_HOME` | `~/.agentarium` | Where the statusline, router, plan, provider and profile settings (`config.json`) live. |

---

## Currency

Costs show in pounds (£) by default. To use US dollars ($) or euros (€) instead, run one of:

```bash
node ~/.agentarium/statusline.mts --set-currency USD     # or EUR, or GBP
export AGENTARIUM_CURRENCY=EUR                            # or set it per shell / in Claude Code's "env"
```

The choice is saved as `"currency"` in `~/.agentarium/statusline.json`, and the statusline, budget, spend report and doggybags all use it (`$`, `€` and `£` work too, e.g. `--set-currency €`). `AGENTARIUM_CURRENCY` wins over the saved choice, and `--currency USD` on a single statusline or report run wins over both.

Prices are in dollars, so dollars need no conversion; pounds and euros are converted at 0.76 and 0.86 per dollar unless you set the rate. Run `node ~/.agentarium/statusline.mts --update-rate` to fetch today's rates, or set `"usd_gbp"` / `"usd_eur"` in the same file (or `AGENTARIUM_USD_GBP` / `AGENTARIUM_USD_EUR`).

---

## Prices

When the assistant doesn't report a cost itself (Copilot, older Claude Code), and always for budget and the spend report, agentarium prices each request from `data/model-prices.json`: input, output, cache-write and cache-read prices for **every Claude model version**, from Haiku 3.5 to Fable 5.2.

For example, Fable 5.2 is $8/$40 per million input/output tokens, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (or $0.50/$2.50 for prompts over 100K tokens). Each model's own cache rates are used (e.g. cache reads cost $0.20 on Fable 5.2 and $0.10 on Sonnet 5.5), fast mode counts double, and a model switch mid-session is priced message by message.

- **Kept fresh automatically.** A scheduled GitHub Action (`.github/workflows/update-prices.yml`) refreshes the file from Claude's pricing page every Monday and commits any change. Retired models that drop off the page keep their last known price.
- **Refresh it yourself** with `node scripts/update_prices.ts`. The statusline's `--install` copies the current file next to the installed statusline.
- **Override a price** in `~/.agentarium/statusline.json`, by model version (input, output and optionally cache read, dollars per million tokens; the most specific key wins):

  ```json
  {"prices": {"opus-5-5": [4, 20], "sonnet-5-5": [2, 10, 0.1]}}
  ```

---

## Statusline file

`~/.agentarium/statusline.json` (or `$AGENTARIUM_HOME/statusline.json`) holds the statusline's own options, all optional:

| Key | Example | What it does |
|---|---|---|
| `theme` | `"dark"` | Force `light` or `dark` (default follows your system). |
| `currency` | `"USD"` | Saved currency choice. |
| `usd_gbp`, `usd_eur` | `0.79` | Exchange rates. |
| `prices` | see above | Per-model price overrides. |
| `cache_ttl` | `3600` | Cache lifetime in seconds for the countdown. |
| `band` | `false` | Hide the band in the desktop app (`--band-off` writes it, `--band-on` sets it back). |
| `outlook` | `false` | Hide the forecast row under the terminal statusline (`--outlook-off` writes it, `--outlook-on` sets it back). |

Before v1.4 this file was `statusbar.json`. It is still read, and the plugin renames it at the next session start (`agentarium update` does too).

---

<p align="center"><a href="reference.md">← Helper reference</a> · <a href="README.md">All docs</a> · <a href="architecture.md">Architecture →</a></p>
