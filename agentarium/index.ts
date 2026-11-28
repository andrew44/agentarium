/**
 * agentarium: one shared engine for AI coding assistants, with an adapter per platform.
 *
 * Layout (see docs/architecture.md):
 *   agentarium/engine/     shared, platform-independent logic (classifier, LLM step, usage store)
 *   agentarium/services/   the intelligence engine: Cost, Telemetry, Outcome, Policy and Insights engines
 *   agentarium/platform/   the common platform interface and the capability registry
 *   agentarium/adapters/   Claude Code, Copilot CLI and VS Code adapters (translation only, no business logic)
 *   agentarium/config.ts   shared configuration
 *   agentarium/util.ts     shared utilities
 *
 * TypeScript, run directly by Node.js 22.18+ (no build step). Node built-ins only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The plugin's version. Read from its manifest, which the version workflow bumps, so it can't drift. */
export const VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8')).version)
  } catch {
    return 'unknown'
  }
})()
