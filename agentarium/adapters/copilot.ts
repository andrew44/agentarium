/**
 * GitHub Copilot adapter (Copilot CLI / cloud agent hooks; VS Code-compatible payloads too).
 * The GitHub Copilot app (desktop, technical preview) is built on Copilot CLI and installs the
 * same plugin, so its hooks arrive here too, under the `copilot` source.
 *
 * Translation only. Scoring, labelling and storage live in agentarium/engine.
 *
 * What Copilot gives hooks (docs.github.com, CLI hooks reference):
 *   userPromptSubmitted  sessionId, timestamp, cwd, prompt
 *   postToolUse          sessionId, timestamp, cwd, toolName, toolArgs, toolResult
 *   sessionEnd           sessionId, timestamp, cwd, reason
 *   (PascalCase event names deliver snake_case: session_id, tool_name, tool_input ...)
 * No hook payload carries token usage, model or premium-request counts, and the transcript
 * format is undocumented, so the engine classifies Copilot sessions from prompt and tool
 * events and records usage as unavailable. The model is read, best effort, from Copilot's own
 * session state (sessionModel) so each prompt can be counted at its model's multiplier. Copilot bills premium requests, not tokens:
 * no money or token figure is invented for it.
 *
 * Copilot Fusion is a router, not a model: picked in the model picker, it sends each task to a
 * model of its choosing and bills that model at its own rate. When the selection is Fusion,
 * sessionRoute reports the model it routed to most recently (the newest model id written after the
 * selection) as the model, and the Fusion selection as the router.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TOOL_CODE_EDIT, TOOL_OTHER, TOOL_READ, TOOL_SHELL, TOOL_SKILL, toolCall, type ToolCall } from '../engine/evidence.ts'
import { PlatformAdapter, type LifecycleEvent, type ToolOutput } from '../platform/adapter.ts'
import { BILLING_COPILOT_PREMIUM_REQUESTS, Capability, NATIVE, NONE, PARTIAL, support } from '../platform/capabilities.ts'
import { asDict, first, frontmatterDescription, isObj, type Obj } from '../util.ts'
import { isFile } from './fsutil.ts'

const EDIT_TOOLS = new Set(['edit', 'create', 'write', 'str_replace', 'apply_patch', 'multi_edit',
  'edit_file', 'create_file', 'replace_string_in_file', 'insert_edit_into_file',
  'multi_replace_string_in_file', 'editfiles', 'createfile'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'run_in_terminal', 'runinterminal', 'terminal'])
const SKILL_TOOLS = new Set(['skill', 'use_skill'])
const READ_TOOLS = new Set(['view', 'read', 'read_file', 'readfile'])
const RANGE_KEYS = ['view_range', 'startLine', 'start_line', 'offset', 'limit', 'endLine', 'end_line']
// Copilot's events.jsonl is undocumented: these are the keys a model id has been seen under.
// The first three are what the user picked; a bare `model` is what a request actually ran on.
const PICK_KEYS = ['newModel', 'selectedModel', 'currentModel']
const MODEL_KEYS = [...PICK_KEYS, 'model']
const STATE_TAIL = 256 * 1024

/** Copilot CLI's home: AGENTARIUM_COPILOT_HOME, COPILOT_HOME, else ~/.copilot. */
const copilotHome = () => process.env.AGENTARIUM_COPILOT_HOME || process.env.COPILOT_HOME || join(homedir(), '.copilot')

/** Copilot Fusion's selection (e.g. "copilot-fusion", "fusion-high"): a router, not a model. */
export const isFusion = (id: string | null | undefined) => /fusion/i.test(String(id ?? ''))

/** A model id in one parsed event: at the top level or under `data`. */
function modelIn(ev: unknown, keys = MODEL_KEYS): string | null {
  for (const o of [ev, isObj(ev) ? ev.data : null]) {
    if (!isObj(o)) continue
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim() && v.length < 100) return v.trim()
      if (isObj(v) && typeof v.id === 'string') return v.id
    }
  }
  return null
}

function tail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export class CopilotAdapter extends PlatformAdapter {
  override name = 'copilot'
  override billingModel = BILLING_COPILOT_PREMIUM_REQUESTS
  override capabilities = {
    [Capability.HOOKS]: support(NATIVE, 'userPromptSubmitted, preToolUse, postToolUse, sessionStart, sessionEnd'),
    [Capability.SESSION_INFO]: support(NATIVE, 'sessionId / session_id in every hook payload'),
    [Capability.TOOL_EVENTS]: support(NATIVE, 'postToolUse: toolName + toolArgs'),
    [Capability.SKILL_TRACKING]: support(PARTIAL, 'only if skill use surfaces as a tool call'),
    [Capability.TRANSCRIPT]: support(NONE, 'sessionEnd has no transcript; format undocumented'),
    [Capability.TOKEN_USAGE]: support(NONE, 'not exposed to hooks'),
    [Capability.CACHE_INFO]: support(NONE, 'not exposed to hooks'),
    [Capability.BILLING_INFO]: support(NONE, 'premium requests; not exposed to hooks'),
    [Capability.MODEL_SELECTION]: support(PARTIAL, 'no model in hook payloads; read best effort from session-state events.jsonl or config.json'),
    [Capability.CONTEXT_INFO]: support(NONE, ''),
    [Capability.CONTEXT_INJECTION]: support(NONE, 'userPromptSubmitted output is ignored'),
    [Capability.PROMPT_DECISION]: support(NONE, 'userPromptSubmitted output is ignored, so a prompt cannot be paused'),
    [Capability.TOOL_OUTPUT_INTERCEPTION]: support(PARTIAL, 'postToolUse modifiedResult replaces a successful result ' +
      '(documented for command hooks, not yet confirmed on a real install); preToolUse can deny a call'),
    [Capability.AVAILABLE_MODELS]: support(NONE, ''),
  }

  override toolCall(payload: Obj): ToolCall | null {
    const name = String(first(payload, ['toolName', 'tool_name'], '') || '')
    if (!name) return null
    const args = asDict(first(payload, ['toolArgs', 'tool_input', 'toolInput'], {}))
    const key = name.trim().toLowerCase().split('.').at(-1)!.split('/').at(-1)!
    if (SKILL_TOOLS.has(key)) return toolCall(name, TOOL_SKILL, { skill: String(args.skill || args.name || '') })
    if (key === 'str_replace_editor') {
      const sub = String(args.command || '').toLowerCase()
      return sub === 'view' ? CopilotAdapter.read(name, args) : CopilotAdapter.edit(name, args)
    }
    if (READ_TOOLS.has(key)) return CopilotAdapter.read(name, args)
    if (EDIT_TOOLS.has(key)) return CopilotAdapter.edit(name, args)
    if (SHELL_TOOLS.has(key)) return toolCall(name, TOOL_SHELL, { command: String(args.command || args.cmd || '') })
    return toolCall(name, TOOL_OTHER)
  }

  static edit(name: string, args: Obj): ToolCall {
    return toolCall(name, TOOL_CODE_EDIT, { path: String(first(args, ['path', 'file_path', 'filePath'], '') || '') })
  }

  override lifecycle(payload: Obj, mode: string): LifecycleEvent {
    const name = String(first(payload, ['hookEventName', 'hook_event_name'], '')).toLowerCase()
    const map: Record<string, LifecycleEvent> = { userpromptsubmitted: 'prompt', userpromptsubmit: 'prompt', pretooluse: 'tool_call',
      posttooluse: 'tool_result', sessionstart: 'session_start', sessionend: 'session_end', stop: 'turn_end' }
    if (map[name]) return map[name]
    if (mode === 'tool') return 'tool_result'                 // till tool runs on postToolUse
    return super.lifecycle(payload, mode)
  }

  /** postToolUse: did the call succeed? (toolResult.resultType 'success'); null when not reported. */
  override toolOk(payload: Obj): boolean | null {
    const r = first(payload, ['toolResult', 'tool_result', 'tool_response'])
    const t = isObj(r) ? String(r.resultType ?? r.result_type ?? '') : ''
    return t ? t.toLowerCase() === 'success' : null
  }

  static read(name: string, args: Obj): ToolCall {
    const path = String(first(args, ['path', 'file_path', 'filePath'], '') || '')
    const ranged = RANGE_KEYS.some((k) => args[k] !== undefined && args[k] !== null)
    return toolCall(name, TOOL_READ, { path, ranged })
  }

  override denyTool(reason: string): Obj {
    return { permissionDecision: 'deny', permissionDecisionReason: reason }   // preToolUse
  }

  /** postToolUse: toolResult.textResultForLlm, one stream. Only a successful result can be replaced. */
  override toolOutput(payload: Obj): ToolOutput | null {
    const r = first(payload, ['toolResult', 'tool_result'])
    if (!isObj(r)) return null
    const type = String(r.resultType ?? r.result_type ?? 'success').toLowerCase()
    const text = r.textResultForLlm ?? r.text_result_for_llm
    return type === 'success' && typeof text === 'string' ? { stdout: text, stderr: '' } : null
  }

  /** postToolUse `modifiedResult`: it must say `resultType: "success"`, or Copilot treats it as a failure. */
  override replaceOutput(payload: Obj, out: ToolOutput): Obj | null {
    const r = isObj(payload.toolResult) ? payload.toolResult : {}
    const text = out.stderr ? `${out.stdout}\n${out.stderr}` : out.stdout
    return { modifiedResult: { ...r, resultType: 'success', textResultForLlm: text } }
  }

  /** The session's model: what sessionRoute says it ran on. */
  override sessionModel(payload: Obj): string | null {
    return this.sessionRoute(payload).model
  }

  /** The model and, under Copilot Fusion, the router that chose it. Read from a model field in the
   *  payload, else the newest ones in ~/.copilot/session-state/<sessionId>/events.jsonl, else
   *  "model" in ~/.copilot/config.json. Newest first: a model a request ran on is kept until the
   *  user's pick that came before it is found; if that pick is Fusion, Fusion is the router. With
   *  Fusion picked and nothing routed yet, the model is the Fusion id itself. Only model ids are
   *  read. Never throws. */
  override sessionRoute(payload: Obj): { model: string | null, router: string | null } {
    let ran: string | null = null
    const settle = (pick: string) => isFusion(pick) ? { model: ran ?? pick, router: pick } : { model: ran ?? pick, router: null }
    const direct = modelIn(payload)
    if (direct && !isFusion(direct)) return { model: direct, router: null }
    if (direct) return this.routed(payload, direct)
    const sid = String(first(payload, ['sessionId', 'session_id'], '') || '')
    if (/^[\w.-]+$/.test(sid)) {
      try {
        for (const line of tail(join(copilotHome(), 'session-state', sid, 'events.jsonl'), STATE_TAIL).split(/\r?\n/).reverse()) {
          if (!/model/i.test(line)) continue
          let ev: unknown
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          const pick = modelIn(ev, PICK_KEYS)
          if (pick) return settle(pick)
          const m = modelIn(ev)
          if (m && isFusion(m)) return settle(m)
          if (m && !ran) ran = m
        }
      } catch {
        // no session state for this session
      }
    }
    try {
      const cfg = modelIn(JSON.parse(readFileSync(join(copilotHome(), 'config.json'), 'utf8')))
      if (cfg) return settle(cfg)
    } catch {
      // no config
    }
    return { model: ran, router: null }
  }

  /** The payload names Fusion: the model is the newest one the session state says ran. */
  private routed(payload: Obj, fusion: string): { model: string | null, router: string | null } {
    const { model } = this.sessionRoute({ ...payload, ...Object.fromEntries(MODEL_KEYS.map((k) => [k, undefined])) })
    return { model: model && !isFusion(model) ? model : fusion, router: fusion }
  }

  override skillRoots(cwd: string | null): string[] {
    return [...(cwd ? [join(cwd, '.github'), join(cwd, '.claude')] : []), join(homedir(), '.copilot')]
  }

  override skillDescription(name: string, cwd: string | null): string | null {
    const leaf = name.trim().replace(/^\/+/, '').split(':').at(-1)!
    for (const r of this.skillRoots(cwd)) {
      for (const p of [join(r, 'skills', leaf, 'SKILL.md'), join(r, 'prompts', `${leaf}.prompt.md`)]) {
        if (isFile(p)) {
          const d = frontmatterDescription(p)
          if (d) return d
        }
      }
    }
    return null
  }
}
