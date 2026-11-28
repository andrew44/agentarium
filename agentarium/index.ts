/**
 * agentarium: one shared AI cost optimisation engine, two native platform adapters.
 *
 * Layout (see docs/architecture.md):
 *   agentarium/engine/     shared, platform-independent logic (classifier, LLM step, usage store)
 *   agentarium/services/   the intelligence engine: Cost, Telemetry, Outcome, Policy and Insights engines
 *   agentarium/platform/   the common platform interface and the capability registry
 *   agentarium/adapters/   Claude Code and GitHub Copilot adapters (translation only, no business logic)
 *   agentarium/config.ts   shared configuration
 *   agentarium/util.ts     shared utilities
 *
 * TypeScript, run directly by Node.js 22.18+ (no build step). Node built-ins only.
 */
export const VERSION = '2.2.0'
