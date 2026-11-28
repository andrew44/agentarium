#!/usr/bin/env node
/**
 * tokenomics / too-many-cooks: catch a subagent before it is sent to do work already being done.
 *
 * Every subagent starts cold: it loads its own system prompt and tool definitions and re-reads the
 * files it needs. sherlock finds the waste afterwards; this hook catches it as the agent is sent:
 *
 *   overlap   the brief shares at least half its words with a subagent already sent in this session
 *   lookup    a short brief for a one-step lookup that a single Read or Grep would do
 *   fan_out   more subagents in one turn than TOKENOMICS_TOOMANYCOOKS_FANOUT (default 5)
 *
 * Rules shared with sherlock: tokenomics/engine/forensics.ts. Each finding is priced at what a
 * subagent has cost you on average (measured at SubagentStop), or an estimate until there are some.
 * Briefs are compared in memory and never stored.
 *
 *   toomanycooks.ts guard [source]   PreToolUse on Task|Agent (Claude Code)
 *   toomanycooks.ts record [source]  SubagentStop: what the subagent really cost, from its transcript
 *   toomanycooks.ts report [--days 30] [--json]   what subagents cost, by type
 *
 * Env: TOKENOMICS_TOOMANYCOOKS          warn (default: tell you) | ask (confirm first) |
 *                                      block (refuse; the agent does the work itself or uses the earlier result) | off
 *      TOKENOMICS_TOOMANYCOOKS_FANOUT   subagents allowed in one turn before it speaks up (default 5)
 * Each rule speaks once per session. Always exits 0; a crash never blocks a call.
 */
import { existsSync } from 'node:fs'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { brief, briefOverlap, lookupBrief, OVERLAP, subagentOverheadUsd } from '../tokenomics/engine/forensics.ts'
import * as lessons from '../tokenomics/engine/lessons.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { errText, first, isMain, isObj, logErr, readPayload, type Obj } from '../tokenomics/util.ts'
import { money2, period, write } from './common.ts'

const TAIL_BYTES = 3 * 1024 * 1024
const MIN_MEASURED = 3              // measured subagents needed before their average replaces the estimate

export type Finding = { rule: 'overlap' | 'lookup' | 'fan_out', detail: string }

const fanOut = () => PolicyEngine.threshold('TOKENOMICS_TOOMANYCOOKS_FANOUT', 5, { min: 1 })

/** Judge a Task/Agent call about to be made, against what the session already sent. */
export function judge(t: trace.Trace, input: Obj, limit = fanOut()): Finding | null {
  const sent = t.steps.filter((s) => trace.AGENT_TOOLS.has(s.name) && !s.sidechain)
  for (const s of [...sent].reverse()) {
    const share = briefOverlap(s.input, input)
    if (share >= OVERLAP) {
      return { rule: 'overlap', detail: `its brief shares ${Math.round(share * 100)}% of its words with ` +
        `"${String(s.input.description ?? brief(s.input)).trim().slice(0, 60)}", sent earlier in this session` }
    }
  }
  if (lookupBrief(String(input.prompt ?? ''))) return { rule: 'lookup', detail: 'its brief is a single lookup' }
  const since = t.prompts.at(-1)?.turn ?? 0
  const thisTurn = sent.filter((s) => s.turn >= since).length
  if (thisTurn >= limit) return { rule: 'fan_out', detail: `it would be subagent number ${thisTurn + 1} since your last prompt` }
  return null
}

/** What a subagent costs: the average of the last measured ones, or the start-up estimate. */
export function typicalCostUsd(dbPath: string, model: string): { usd: number, measured: boolean } {
  try {
    const r = withDb(dbPath, (db) => db.tables().has('toomanycooks_agents')
      ? db.get('SELECT COUNT(*) AS n, AVG(usd) AS avg FROM (SELECT usd FROM toomanycooks_agents ORDER BY id DESC LIMIT 50)') : null)
    if (r && Number(r.n) >= MIN_MEASURED) return { usd: Number(r.avg), measured: true }
  } catch {
    // fall back to the estimate
  }
  return { usd: subagentOverheadUsd(model), measured: false }
}

const FIX: Record<Finding['rule'], string> = {
  overlap: 'Use what the earlier subagent found, or send this one only the part that is new.',
  lookup: 'A Read, Grep or Glob in the main conversation gives the same answer without the start-up cost.',
  fan_out: 'Check whether the work splits this many ways, or give fewer subagents a bigger share each.',
}

function said(dbPath: string, sid: string, rule: string): boolean {
  try {
    return withDb(dbPath, (db) => db.tables().has('toomanycooks_events') &&
      Boolean(db.get('SELECT 1 FROM toomanycooks_events WHERE session_id=? AND rule=? LIMIT 1', sid, rule)))
  } catch {
    return false
  }
}

function guard(source: string): void {
  const mode = PolicyEngine.mode('TOKENOMICS_TOOMANYCOOKS', 'warn', ['warn', 'ask', 'block', 'off'])
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    if (adapter.name !== 'claude-code') return
    const name = String(first(payload, ['tool_name'], '') || '')
    if (!trace.AGENT_TOOLS.has(name)) return
    const input: Obj = isObj(payload.tool_input) ? payload.tool_input : {}
    const path = String(first(payload, ['transcript_path'], '') || '')
    if (!path || !existsSync(path)) return
    const t = trace.parse(path, { tail: TAIL_BYTES })
    const f = judge(t, input)
    if (!f) return
    const sid = adapter.sessionId(payload)
    if (said(dbPath, sid, f.rule)) return
    const cost = typicalCostUsd(dbPath, trace.lastModel(t) ?? '')
    const { fmt } = CostEngine.display()
    const each = cost.measured ? `your subagents have cost about ${fmt(cost.usd)} each` : `a fresh subagent costs about ${fmt(cost.usd)} before it does anything`
    let msg = `too-many-cooks: ${f.detail}; ${each}. ${FIX[f.rule]}`
    const action: PolicyEngine.Action = mode === 'ask' ? 'ask' : mode === 'block' ? 'deny' : 'warn'
    msg += lessons.teach(dbPath, 'subagent', { sessionId: sid, source: adapter.name })
    const out = PolicyEngine.enforce(adapter, action, msg)
    PolicyEngine.log(dbPath, 'toomanycooks_events', { session_id: sid, source: adapter.name, rule: f.rule,
      agent: String(input.subagent_type ?? 'general-purpose').slice(0, 60), est_usd: Math.round(cost.usd * 1e6) / 1e6,
      action: PolicyEngine.effective(adapter, action) })
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `toomanycooks guard\n${errText(e)}`)
  }
}

/** SubagentStop: price the subagent from its own transcript (Claude Code writes one per subagent). */
function record(): void {
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const path = String(first(payload, ['agent_transcript_path'], '') || '')
    if (!path || !existsSync(path)) return
    const t = trace.parse(path)
    if (!t.turns.length) return
    const tokens = t.turns.reduce((a, x) => a + x.usage.inputTokens + x.usage.outputTokens + x.usage.cacheCreationTokens + x.usage.cacheReadTokens, 0)
    PolicyEngine.log(dbPath, 'toomanycooks_agents', { session_id: getAdapter('claude-code').sessionId(payload),
      agent: String(first(payload, ['agent_type'], '') || 'subagent').slice(0, 60), model: trace.lastModel(t) ?? '',
      requests: t.turns.length, tokens, usd: Math.round(trace.costUsd(t) * 1e6) / 1e6 })
  } catch (e) {
    logErr(dbPath, `toomanycooks record\n${errText(e)}`)
  }
}

function report(args: string[]): number {
  const p = period(args, 30)
  const dbPath = defaultDbPath()
  const data = withDb(dbPath, (db) => {
    const tables = db.tables()
    const agents = tables.has('toomanycooks_agents')
      ? db.all(`SELECT agent, COUNT(*) AS n, SUM(usd) AS usd, AVG(usd) AS avg_usd, SUM(tokens) AS tokens FROM toomanycooks_agents
          WHERE substr(ts,1,10) BETWEEN ? AND ? GROUP BY agent ORDER BY usd DESC`, p.since, p.until) : []
    const caught = tables.has('toomanycooks_events')
      ? db.all(`SELECT rule, COUNT(*) AS n, SUM(est_usd) AS usd FROM toomanycooks_events
          WHERE substr(ts,1,10) BETWEEN ? AND ? GROUP BY rule ORDER BY n DESC`, p.since, p.until) : []
    return { agents: agents.map((r) => ({ ...r })), caught: caught.map((r) => ({ ...r })) }
  })
  const total = data.agents.reduce((a, r) => a + Number(r.usd), 0)
  const n = data.agents.reduce((a, r) => a + Number(r.n), 0)
  if (args.includes('--json')) {
    write(JSON.stringify({ period: p.label, subagents: n, total_usd: total, ...data }, money2, 2))
    return 0
  }
  const { fmt } = CostEngine.display()
  if (!n && !data.caught.length) {
    write(`too-many-cooks: no subagents recorded (${p.label}).`)
    return 0
  }
  write(`too-many-cooks: ${n} subagent(s), ${fmt(total)} in all (${p.label}).`)
  for (const r of data.agents) write(`- ${r.agent}: ${r.n} x about ${fmt(Number(r.avg_usd))} = ${fmt(Number(r.usd))}`)
  if (data.caught.length) write('Caught before they ran: ' + data.caught.map((r) => `${r.rule.replace('_', ' ')} x${r.n}`).join(', ') + '.')
  return 0
}

export function main(args: string[]): number {
  const [mode = 'guard', source = 'claude-code'] = args
  if (mode === 'record') record()
  else if (mode === 'report') return report(args.slice(1))
  else guard(source)
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
