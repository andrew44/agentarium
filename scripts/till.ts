#!/usr/bin/env node
/**
 * agentarium / till: tag each AI coding session OPEX (run) or CAPEX (build), logged by session id.
 *
 * Thin hook runner. The logic lives in the shared engine (agentarium/engine); the platform
 * named by [source] picks its adapter (agentarium/adapters). Same engine for every platform.
 *
 * Usage (hook command):
 *   till.ts prompt   [source]   # every user prompt   (Claude: UserPromptSubmit, Copilot: userPromptSubmitted)
 *   till.ts tool     [source]   # every tool call     (Copilot: postToolUse; Claude reads its transcript instead)
 *   till.ts finalize [source]   # turn / session end  (Claude: Stop, SessionEnd; Copilot: sessionEnd)
 *   till.ts capabilities        # print what each platform adapter supports (JSON)
 *
 * [source] is claude-code (default) or copilot. Reads the hook JSON on stdin, prints NOTHING
 * on hook runs (UserPromptSubmit stdout is injected into the model context), and always exits 0
 * so it can never block a session. Errors go to <db>.err. Node.js 22.18+, built-ins only.
 *
 * Every run also hands the hook's lifecycle event to the TelemetryEngine (agentarium/services/telemetry.ts),
 * which stores it in the shared event format (AGENTARIUM_TELEMETRY=off to stop).
 *
 * Settings (env): AGENTARIUM_DB, AGENTARIUM_STORE_PROMPT, AGENTARIUM_SKILL_MAP,
 * AGENTARIUM_LLM, AGENTARIUM_LLM_URL, AGENTARIUM_LLM_KEY, AGENTARIUM_LLM_MODEL, AGENTARIUM_LLM_TIMEOUT.
 * See docs/configuration.md.
 */
import { defaultDbPath, loadSettings } from '../agentarium/config.ts'
import * as session from '../agentarium/engine/session.ts'
import { getAdapter, report } from '../agentarium/platform/registry.ts'
import { TelemetryEngine } from '../agentarium/services/index.ts'
import { errText, isMain, logErr, readPayload } from '../agentarium/util.ts'

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const mode = argv[0] ?? 'prompt'
  const source = argv[1] ?? 'claude-code'
  try {
    if (mode === 'capabilities') {
      process.stdout.write(JSON.stringify(report(), null, 2) + '\n')
      return
    }
    const payload = readPayload()
    const settings = loadSettings()
    const adapter = getAdapter(source)
    if (mode === 'finalize') await session.finalize(adapter, payload, settings)
    else if (mode === 'tool') session.recordTool(adapter, payload, settings)
    else session.recordPrompt(adapter, payload, settings)
    TelemetryEngine.ingest(adapter, payload, mode, settings.dbPath)     // the shared event, for every platform
  } catch (e) {
    logErr(defaultDbPath(), `till\n${errText(e)}`)
  }
}

if (isMain(import.meta.url)) {
  await main()
  process.exitCode = 0
}
