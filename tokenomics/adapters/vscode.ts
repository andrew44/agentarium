/**
 * VS Code adapter: GitHub Copilot's agent mode in VS Code (agent hooks, preview).
 *
 * Translation only. Scoring, labelling and storage live in tokenomics/engine.
 *
 * VS Code runs hooks from `.github/hooks/*.json` in the workspace, with Claude Code's event names
 * and payload shape rather than Copilot CLI's:
 *   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop
 *   every payload: timestamp, cwd, sessionId, hookEventName, transcript_path
 *   UserPromptSubmit: prompt   PreToolUse: tool_name, tool_input   PostToolUse: + tool_response
 * Output is Claude Code's too: hookSpecificOutput.permissionDecision (allow, deny, ask),
 * additionalContext, and {"continue": false, "stopReason"} to stop.
 *
 * The tools are Copilot's (read_file, replace_string_in_file, run_in_terminal ...) and so is the
 * bill: premium requests against the same monthly allowance as Copilot CLI. No payload carries
 * tokens, and transcript_path points at VS Code's own chat log, which is undocumented, so it is
 * not parsed: sessions are rebuilt from the prompt and tool events, as for Copilot CLI.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TOOL_CODE_EDIT, toolCall, type ToolCall } from '../engine/evidence.ts'
import type { LifecycleEvent, ToolOutput } from '../platform/adapter.ts'
import { Capability, NATIVE, NONE, PARTIAL, support } from '../platform/capabilities.ts'
import { asDict, first, isObj, type Obj } from '../util.ts'
import { CopilotAdapter, isFusion } from './copilot.ts'

// VS Code's own edit tools the Copilot CLI list doesn't have
const NOTEBOOK_TOOLS = new Set(['edit_notebook_file', 'editnotebook'])
const MODEL_KEYS = ['model', 'modelId', 'model_id']

export class VSCodeAdapter extends CopilotAdapter {
  override name = 'vscode'
  override capabilities = {
    [Capability.HOOKS]: support(NATIVE, 'SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop (preview)'),
    [Capability.SESSION_INFO]: support(NATIVE, 'sessionId in every hook payload'),
    [Capability.TOOL_EVENTS]: support(NATIVE, 'PreToolUse / PostToolUse: tool_name + tool_input'),
    [Capability.SKILL_TRACKING]: support(PARTIAL, 'only if skill use surfaces as a tool call'),
    [Capability.TRANSCRIPT]: support(NONE, "transcript_path is VS Code's own chat log; format undocumented, not parsed"),
    [Capability.TOKEN_USAGE]: support(NONE, 'not exposed to hooks'),
    [Capability.CACHE_INFO]: support(NONE, 'not exposed to hooks'),
    [Capability.BILLING_INFO]: support(NONE, 'premium requests; not exposed to hooks'),
    [Capability.MODEL_SELECTION]: support(PARTIAL, 'only when a payload carries a model; otherwise the default multiplier'),
    [Capability.CONTEXT_INFO]: support(NONE, ''),
    [Capability.CONTEXT_INJECTION]: support(PARTIAL, 'hookSpecificOutput.additionalContext (preview)'),
    [Capability.PROMPT_DECISION]: support(PARTIAL, '{"continue": false} on UserPromptSubmit stops the prompt (preview)'),
    [Capability.TOOL_OUTPUT_INTERCEPTION]: support(PARTIAL, 'PostToolUse sees results, cannot rewrite them; PreToolUse can deny or ask'),
    [Capability.AVAILABLE_MODELS]: support(NONE, ''),
  }

  override lifecycle(payload: Obj, mode: string): LifecycleEvent {
    const name = String(first(payload, ['hookEventName', 'hook_event_name'], ''))
    const map: Record<string, LifecycleEvent> = { UserPromptSubmit: 'prompt', PreToolUse: 'tool_call', PostToolUse: 'tool_result',
      Stop: 'turn_end', SubagentStop: 'turn_end', SessionStart: 'session_start' }
    return map[name] ?? super.lifecycle(payload, mode)
  }

  override event(payload: Obj, mode: string): string {
    if (mode === 'prompt' || mode === 'tool') return mode
    return first(payload, ['hookEventName', 'hook_event_name'], '') === 'Stop' ? 'turn_end' : 'session_end'
  }

  override toolCall(payload: Obj): ToolCall | null {
    const name = String(first(payload, ['tool_name', 'toolName'], '') || '')
    const key = name.trim().toLowerCase()
    if (NOTEBOOK_TOOLS.has(key)) {
      const args = asDict(first(payload, ['tool_input', 'toolInput', 'toolArgs'], {}))
      return toolCall(name, TOOL_CODE_EDIT, { path: String(first(args, ['filePath', 'file_path', 'path'], '') || '') })
    }
    return super.toolCall(payload)
  }

  /** PostToolUse: Copilot's resultType when present, else Claude Code's success / is_error. */
  override toolOk(payload: Obj): boolean | null {
    const copilot = super.toolOk(payload)
    if (copilot !== null) return copilot
    const r = first(payload, ['tool_response', 'toolResponse'])
    if (isObj(r) && typeof r.success === 'boolean') return r.success
    if (isObj(r) && (r.is_error === true || r.isError === true)) return false
    return null
  }

  /** Only what the payload says: VS Code keeps no session state where a hook could read the model. */
  override sessionModel(payload: Obj): string | null {
    for (const k of MODEL_KEYS) {
      const v = payload[k]
      if (typeof v === 'string' && v.trim() && v.length < 100) return v.trim()
      if (isObj(v) && typeof v.id === 'string') return v.id
    }
    return null
  }

  /** Fusion named in the payload is all VS Code shows: the routed model isn't there to read. */
  override sessionRoute(payload: Obj): { model: string | null, router: string | null } {
    const model = this.sessionModel(payload)
    return { model, router: isFusion(model) ? model : null }
  }

  // ---- hook output: Claude Code's shapes -------------------------------------------------
  override denyTool(reason: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }

  override askTool(reason: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
  }

  override blockPrompt(reason: string): Obj {
    return { continue: false, stopReason: reason, systemMessage: reason }
  }

  override notify(message: string): Obj {
    return { systemMessage: message }
  }

  override interrupt(reason: string): Obj {
    return { continue: false, stopReason: reason, systemMessage: reason }
  }

  override addContext(text: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
  }

  /** VS Code's hooks page documents only additionalContext for PostToolUse, not Copilot CLI's modifiedResult. */
  override replaceOutput(_payload: Obj, _out: ToolOutput): Obj | null {
    return null
  }

  override skillRoots(cwd: string | null): string[] {
    return [...(cwd ? [join(cwd, '.github'), join(cwd, '.claude')] : []), join(homedir(), '.copilot'), join(homedir(), '.claude')]
  }
}
