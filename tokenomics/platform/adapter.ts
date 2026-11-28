/**
 * The common platform interface every adapter implements.
 *
 * Adapters translate. They turn a platform's hook payloads, transcripts and file layout into
 * the engine's platform-neutral evidence (tokenomics/engine/evidence.ts) and declare what the
 * platform can do. They must not score, classify or price anything themselves.
 */
import { prompt, sessionEvidence, type SessionEvidence, type ToolCall } from '../engine/evidence.ts'
import { anonSessionId, first, isObj, type Obj } from '../util.ts'
import { ALL_CAPABILITIES, available, BILLING_UNKNOWN, Capability, Level, NONE, support, type Support } from './capabilities.ts'

/** The shared lifecycle every platform's hook events are translated into (TelemetryEngine's event types). */
export const LIFECYCLE = ['session_start', 'prompt', 'tool_call', 'tool_result', 'turn_end', 'session_end'] as const
export type LifecycleEvent = typeof LIFECYCLE[number]

/** What a finished tool call put in front of the model, by stream. A platform with one stream puts it all in stdout. */
export type ToolOutput = { stdout: string, stderr: string }

export class PlatformAdapter {
  name = 'generic'
  billingModel: string = BILLING_UNKNOWN
  capabilities: Partial<Record<Capability, Support>> = {}

  // ---- capability queries (used by the engine) --------------------------------------
  support(cap: Capability): Support {
    return this.capabilities[cap] ?? support(NONE, 'not declared')
  }

  supports(cap: Capability): boolean {
    return available(this.support(cap))
  }

  capabilityReport(): Record<string, { level: string, note: string }> {
    return Object.fromEntries(ALL_CAPABILITIES.map((c) => [c, { level: this.support(c).level, note: this.support(c).note }]))
  }

  // ---- translation (overridden per platform) ----------------------------------------
  sessionId(payload: Obj): string {
    let sid = first(payload, ['session_id', 'sessionId'])
    if (!sid && isObj(payload.session)) sid = payload.session.id
    return sid ? String(sid) : anonSessionId(payload.cwd)
  }

  /** Normalised event: 'prompt', 'tool', 'turn_end' or 'session_end'. */
  event(_payload: Obj, mode: string): string {
    return mode === 'prompt' || mode === 'tool' ? mode : 'session_end'
  }

  /** Which shared lifecycle event this hook payload is. Platforms override this with their own event names;
   *  the default goes by the hook runner's mode. */
  lifecycle(_payload: Obj, mode: string): LifecycleEvent {
    if (mode === 'prompt') return 'prompt'
    if (mode === 'tool') return 'tool_result'
    if (mode === 'pre-tool' || mode === 'guard') return 'tool_call'
    if (mode === 'start') return 'session_start'
    return 'session_end'
  }

  /** The model this session is on, when the platform lets a hook find out; null when it doesn't. */
  sessionModel(_payload: Obj): string | null {
    return null
  }

  /** The model a request ran on and, when a router picked it for the user (Copilot Fusion), that
   *  router's id; router is null when the user picked the model. */
  sessionRoute(payload: Obj): { model: string | null, router: string | null } {
    return { model: this.sessionModel(payload), router: null }
  }

  /** Did a finished tool call succeed? null when the platform doesn't say. */
  toolOk(payload: Obj): boolean | null {
    const r = payload.tool_response ?? payload.toolResponse
    if (isObj(r) && typeof r.success === 'boolean') return r.success
    if (isObj(r) && (r.is_error === true || r.isError === true)) return false
    return null
  }

  /** Characters of output a finished tool call put into the context (null when the payload has none). */
  toolResultChars(payload: Obj): number | null {
    const r = first(payload, ['tool_response', 'toolResponse', 'toolResult', 'tool_result'])
    if (r === undefined || r === null) return null
    if (typeof r === 'string') return r.length
    if (!isObj(r)) return JSON.stringify(r).length
    if (typeof r.textResultForLlm === 'string') return r.textResultForLlm.length          // Copilot
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return String(r.stdout ?? '').length + String(r.stderr ?? '').length
    if (isObj(r.file) && typeof r.file.content === 'string') return r.file.content.length  // Claude Code Read
    if (typeof r.content === 'string') return r.content.length
    return JSON.stringify(r).length
  }

  /** The text a successful tool call returned to the model, or null (no text, an image, or a failed call). */
  toolOutput(_payload: Obj): ToolOutput | null {
    return null
  }

  /** The most characters of a shell result the platform passes to the model (it cuts the rest), or null if it
   *  doesn't say. A saving is only counted up to what the model would have read. */
  shellResultLimit(): number | null {
    return null
  }

  baseEvidence(payload: Obj, mode: string): SessionEvidence {
    return sessionEvidence({ sessionId: this.sessionId(payload), platform: this.name, cwd: payload.cwd ?? null,
      event: this.event(payload, mode), billingModel: this.billingModel })
  }

  promptEvidence(payload: Obj): SessionEvidence {
    const ev = this.baseEvidence(payload, 'prompt')
    const text = first(payload, ['prompt', 'userPrompt'], '')
    if (text) ev.prompts.push(prompt(String(text)))
    return ev
  }

  /** One tool-call event -> a normalised ToolCall (null if not applicable). */
  toolCall(_payload: Obj): ToolCall | null {
    return null
  }

  /** Full replay of the session (from a transcript), or null when the platform has none. */
  sessionEvidence(_payload: Obj): SessionEvidence | null {
    return null
  }

  skillDescription(_name: string, _cwd: string | null): string | null {
    return null
  }

  // ---- hook output (each platform has its own JSON shape; null = cannot express it) -----
  /** Pre-tool hook output that refuses the call and tells the model why. */
  denyTool(_reason: string): Obj | null {
    return null
  }

  /** Pre-tool hook output that asks the user to confirm the call first (null: the platform can't ask). */
  askTool(_reason: string): Obj | null {
    return null
  }

  /** Prompt hook output that stops the prompt and shows the user why. */
  blockPrompt(_reason: string): Obj | null {
    return null
  }

  /** Hook output that shows the user a notice without blocking anything. */
  notify(_message: string): Obj | null {
    return null
  }

  /** Hook output that ends the agent's turn now (it stops working and waits for the user). */
  interrupt(_reason: string): Obj | null {
    return null
  }

  /** Prompt hook output that adds a note for the model to read alongside the user's prompt. */
  addContext(_text: string): Obj | null {
    return null
  }

  /** Post-tool hook output that shows the model `out` in place of what the call returned (null: the platform
   *  can't replace a result). The call has already run: only what the model reads changes. */
  replaceOutput(_payload: Obj, _out: ToolOutput): Obj | null {
    return null
  }

  skillRoots(_cwd: string | null): string[] {
    return []
  }
}

/**
 * Used for an unknown source, or when a platform adapter fails to load.
 * Declares nothing, so the engine records prompts by session id and nothing else.
 */
export class GenericAdapter extends PlatformAdapter {
  constructor(name = 'generic') {
    super()
    this.name = name
    this.capabilities = { [Capability.HOOKS]: support(Level.PARTIAL, 'unknown platform') }
  }
}
