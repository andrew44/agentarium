/**
 * Copilot premium requests per prompt: the model's multiplier.
 *
 * Copilot bills each prompt as premium requests, the model's multiplier times one, against a
 * monthly allowance. Hooks don't carry the model, so the Copilot adapter reads it from Copilot's
 * own session state when it can (adapters/copilot.ts `sessionModel`), and this module turns it
 * into a multiplier. The multipliers are yours to set: GitHub changes them, and lists them per
 * plan, so no table ships here.
 *
 *   AGENTARIUM_COPILOT_MULTIPLIERS   per model, e.g. "claude-haiku-4.5=0.33,gpt-4.1=0,claude-opus=10"
 *                                    (a key matches a model id that contains it; the longest key wins)
 *   AGENTARIUM_COPILOT_MULTIPLIER    every other model, and prompts whose model isn't known (default 1)
 *
 * A multiplier is a count of premium requests, never tokens or money.
 */

const num = (v: string | undefined) => {
  const n = Number((v ?? '').trim())
  return Number.isFinite(n) && n >= 0 && (v ?? '').trim() !== '' ? n : null
}

/** AGENTARIUM_COPILOT_MULTIPLIERS as a map, lower-cased keys; bad entries are skipped. */
export function multipliers(raw = process.env.AGENTARIUM_COPILOT_MULTIPLIERS ?? ''): Map<string, number> {
  const out = new Map<string, number>()
  for (const part of raw.split(',')) {
    const i = part.lastIndexOf('=')
    if (i <= 0) continue
    const v = num(part.slice(i + 1))
    if (v !== null) out.set(part.slice(0, i).trim().toLowerCase(), v)
  }
  return out
}

/** The default multiplier: AGENTARIUM_COPILOT_MULTIPLIER, else 1. */
export const defaultMultiplier = () => num(process.env.AGENTARIUM_COPILOT_MULTIPLIER?.replace(/x$/i, '')) ?? 1

/** Premium requests one prompt on `model` uses, and whether that came from your per-model map. */
export function multiplierFor(model: string | null | undefined): { multiplier: number, known: boolean } {
  const m = String(model ?? '').trim().toLowerCase()
  if (m) {
    const map = multipliers()
    if (map.has(m)) return { multiplier: map.get(m)!, known: true }
    let best: [string, number] | null = null
    for (const [k, v] of map) if (m.includes(k) && (!best || k.length > best[0].length)) best = [k, v]
    if (best) return { multiplier: best[1], known: true }
  }
  return { multiplier: defaultMultiplier(), known: false }
}
