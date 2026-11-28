/**
 * Capability registry: which adapters exist and what each can do.
 *
 * Each adapter is built on first use, independently, so a broken adapter only affects its own
 * platform. The engine then falls back to GenericAdapter for that source.
 */
import { ClaudeCodeAdapter } from '../adapters/claude_code.ts'
import { CopilotAdapter } from '../adapters/copilot.ts'
import { VSCodeAdapter } from '../adapters/vscode.ts'
import { GenericAdapter, type PlatformAdapter } from './adapter.ts'
import { BILLING_COPILOT_PREMIUM_REQUESTS } from './capabilities.ts'

export const ADAPTERS: Record<string, () => PlatformAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  copilot: () => new CopilotAdapter(),
  vscode: () => new VSCodeAdapter(),
}
export const ALIASES: Record<string, string> = {
  claude: 'claude-code', claudecode: 'claude-code', 'github-copilot': 'copilot',
  'copilot-cli': 'copilot', 'vscode-copilot': 'vscode', 'vs-code': 'vscode',
  // The Copilot app is built on Copilot CLI and runs the same plugin hooks (copilot-hooks.json
  // passes `copilot`), so it shares the CLI's adapter until the app documents a payload of its own.
  'copilot-app': 'copilot', 'copilot-desktop': 'copilot',
}

export const cache = new Map<string, PlatformAdapter>()
export const loadErrors = new Map<string, string>()

export function canonical(name: string | null | undefined): string {
  const n = (name || 'claude-code').trim().toLowerCase()
  return ALIASES[n] ?? n
}

export function getAdapter(name: string | null | undefined): PlatformAdapter {
  const key = canonical(name)
  const hit = cache.get(key)
  if (hit) return hit
  const make = ADAPTERS[key]
  let adapter: PlatformAdapter
  if (!make) {
    adapter = new GenericAdapter(key)
  } else {
    try {
      adapter = make()
    } catch (e) {                                   // isolate: never break the other platform
      loadErrors.set(key, e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      adapter = new GenericAdapter(key)
    }
  }
  cache.set(key, adapter)
  return adapter
}

/** Billed in Copilot premium requests (Copilot CLI, VS Code): no token prices and no transcript agentarium can read. */
export const premiumBilled = (source: string | null | undefined): boolean =>
  getAdapter(source).billingModel === BILLING_COPILOT_PREMIUM_REQUESTS

export function report(): Record<string, object> {
  const out: Record<string, object> = {}
  for (const key of Object.keys(ADAPTERS)) {
    const a = getAdapter(key)
    out[key] = { adapter: a.constructor.name, billing_model: a.billingModel,
      load_error: loadErrors.get(key) ?? null, capabilities: a.capabilityReport() }
  }
  return out
}
