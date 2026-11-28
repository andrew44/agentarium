#!/usr/bin/env node
/**
 * agentarium / receipt: what the AI work on this branch cost, as one line for a commit or a pull request.
 *
 * Claude Code tags every transcript line with the git branch it was on, so receipt adds up exactly the
 * requests made on this branch in this repository, subagents included, across every session:
 *
 *   AI-Cost: £1.42 (3 sessions, 38 requests, 71% cache reads, pennywise routed 12 prompts and saved £0.40)
 *
 * Numbers only: no prompt, file or command text goes into the line. Claude Code only (Copilot bills
 * premium requests, which agentarium never turns into money).
 *
 *   receipt.ts [--branch NAME] [--days 90] [--json]   this branch (default: the one checked out here)
 *   receipt.ts --trailer                              just the line, for git:
 *     git commit --trailer "$(agentarium receipt --trailer)"
 *   receipt.ts --markdown                             a short table for a pull request description
 *   add --currency USD to any of them; --projects DIR reads transcripts from another folder.
 * Read-only. --json gives money in US dollars, to two decimal places.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { defaultDbPath } from '../agentarium/config.ts'
import { withDb } from '../agentarium/engine/db.ts'
import * as trace from '../agentarium/engine/trace.ts'
import { CostEngine } from '../agentarium/services/index.ts'
import { argValue, isMain, isObj, type Obj } from '../agentarium/util.ts'
import { money2, numArg, recentTranscripts, useCurrency, write } from './common.ts'

function git(cwd: string, ...args: string[]): string {
  try {
    const p = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    return p.status === 0 ? String(p.stdout).trim() : ''
  } catch {
    return ''
  }
}

export type Receipt = {
  branch: string, repo: string, sessions: number, requests: number, prompts: number, cost_usd: number,
  input_tokens: number, cache_write_tokens: number, cache_read_tokens: number, output_tokens: number,
  cache_read_share: number | null, routed: number, saved_usd: number, first: string | null, last: string | null,
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** A session's transcript and its subagents' own transcripts (Claude Code keeps those in <session>/subagents/). */
function withSubagents(p: string): string[] {
  const dir = join(p.replace(/\.jsonl$/, ''), 'subagents')
  try {
    return [p, ...readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))]
  } catch {
    return [p]
  }
}

/** Only the lines written on `branch` in `repo`, parsed and priced. */
export function branchTrace(path: string, repo: string, branch: string): trace.Trace | null {
  const [text] = trace.readText(path)
  const keep: string[] = []
  for (const line of text.split('\n')) {
    if (!line.includes(branch)) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (isObj(ev) && ev.gitBranch === branch && typeof ev.cwd === 'string' && inside(resolve(ev.cwd), repo)) keep.push(line)
  }
  return keep.length ? trace.parseText(keep.join('\n'), path) : null
}

export function receipt(repo: string, branch: string, files: string[], dbPath = defaultDbPath()): Receipt {
  const r: Receipt = { branch, repo, sessions: 0, requests: 0, prompts: 0, cost_usd: 0, input_tokens: 0, cache_write_tokens: 0,
    cache_read_tokens: 0, output_tokens: 0, cache_read_share: null, routed: 0, saved_usd: 0, first: null, last: null }
  const sessions = new Set<string>()
  const stamps: number[] = []
  for (const main of files) {
    for (const p of withSubagents(main)) {
      const t = branchTrace(p, repo, branch)
      if (!t) continue
      if (t.sessionId) sessions.add(t.sessionId)
      if (p === main) r.prompts += t.prompts.length
      for (const x of t.turns) {
        r.requests++
        r.cost_usd += x.costUsd
        r.input_tokens += x.usage.inputTokens
        r.cache_write_tokens += x.usage.cacheCreationTokens
        r.cache_read_tokens += x.usage.cacheReadTokens
        r.output_tokens += x.usage.outputTokens
        if (x.ts !== null) stamps.push(x.ts)
      }
    }
  }
  r.sessions = sessions.size
  const all = r.input_tokens + r.cache_write_tokens + r.cache_read_tokens
  r.cache_read_share = all ? Math.round(r.cache_read_tokens / all * 1000) / 1000 : null
  if (stamps.length) {
    r.first = new Date(Math.min(...stamps) * 1000).toISOString()
    r.last = new Date(Math.max(...stamps) * 1000).toISOString()
  }
  if (sessions.size && existsSync(dbPath)) {
    try {
      withDb(dbPath, (db) => {
        if (!db.tables().has('pennywise_events')) return
        const cols = db.columns('pennywise_events')
        const ids = [...sessions]
        const row = db.get(`SELECT COUNT(*) AS n${cols.has('saved_usd') ? ', COALESCE(SUM(saved_usd),0) AS saved' : ''} FROM pennywise_events ` +
          `WHERE action='routed' AND session_id IN (${ids.map(() => '?').join(',')})`, ...ids)
        r.routed = Number(row?.n ?? 0)
        r.saved_usd = Number(row?.saved ?? 0)
      }, { readOnly: true })
    } catch {
      // the receipt stands without the routing line
    }
  }
  return r
}

export function line(r: Receipt): string {
  const { fmt } = CostEngine.display()
  const bits = [`${r.sessions} session${r.sessions === 1 ? '' : 's'}`, `${r.requests} requests`]
  if (r.cache_read_share !== null) bits.push(`${Math.round(r.cache_read_share * 100)}% cache reads`)
  if (r.routed) bits.push(`pennywise routed ${r.routed} prompt${r.routed === 1 ? '' : 's'}${r.saved_usd > 0.005 ? ` and saved ${fmt(r.saved_usd)}` : ''}`)
  return `AI-Cost: ${fmt(r.cost_usd)} (${bits.join(', ')})`
}

export function markdown(r: Receipt): string {
  const { fmt } = CostEngine.display()
  const n = (v: number) => v.toLocaleString('en-GB')
  return [
    `**AI cost of \`${r.branch}\`:** ${fmt(r.cost_usd)}`, '',
    '| Sessions | Requests | Tokens read from cache | Tokens written to cache | Uncached input | Output |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${r.sessions} | ${r.requests} | ${n(r.cache_read_tokens)} | ${n(r.cache_write_tokens)} | ${n(r.input_tokens)} | ${n(r.output_tokens)} |`,
    ...(r.routed ? ['', `pennywise routed ${r.routed} prompt(s) to a cheaper model${r.saved_usd > 0.005 ? ` and saved ${fmt(r.saved_usd)}` : ''}.`] : []),
    '', '<sub>From Claude Code transcripts by agentarium receipt; API prices, numbers only.</sub>',
  ].join('\n')
}

export function main(args: string[]): number {
  if (!useCurrency(args)) return 2
  const cwd = process.cwd()
  const repo = git(cwd, 'rev-parse', '--show-toplevel')
  const branch = argValue(args, '--branch') ?? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (!repo || !branch || branch === 'HEAD') {
    process.stderr.write('receipt: run it inside a git repository, on a branch (or pass --branch NAME).\n')
    return 1
  }
  const root = argValue(args, '--projects') ?? undefined
  const r = receipt(resolve(repo), branch, recentTranscripts(Math.max(0, numArg(args, '--days', 90)), root))
  if (args.includes('--json')) {
    write(JSON.stringify({ ...r, line: line(r) } satisfies Obj, money2, 2))
    return 0
  }
  if (!r.requests) {
    if (args.includes('--trailer')) return 1                 // an empty trailer would make git fail anyway
    write(`receipt: no Claude Code requests found on ${branch} in this repository.`)
    return 0
  }
  write(args.includes('--markdown') ? markdown(r) : line(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
