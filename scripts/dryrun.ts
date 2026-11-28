#!/usr/bin/env node
/**
 * tokenomics / dry-run: what a skill, plugin or MCP server will cost before you install it.
 *
 * Everything installed adds to the fixed load every request carries: a skill its line in the skill
 * listing, an MCP server its tool definitions. pack-light measures that load afterwards; dry-run prices
 * the addition first, at your own pace (requests and sessions in your recent Claude Code sessions,
 * re-read at cache-read prices and written once a session):
 *
 *   dry-run: the github MCP server adds about 9,800 tokens to every request:
 *   about £14.20 a month at your pace (2,130 requests in 41 sessions over the last 30 days).
 *
 *   dryrun.ts skill <SKILL.md or its folder>      the listing line, and what each use loads
 *   dryrun.ts plugin <folder>                     every skill, command and agent in a plugin
 *   dryrun.ts mcp --tools <file.json>             tool definitions saved from tools/list
 *   dryrun.ts mcp -- <command> [args ...]         start a stdio MCP server, ask for its tools, stop it
 *   add --days N (default 30), --json, --currency USD, --projects DIR.
 *
 * Read-only: it installs nothing and changes no setting. `mcp --` runs the command you give it, as
 * Claude Code would, for at most 20 seconds. Install between sessions: mid-session, the change makes
 * the cache start again (see cache-buster).
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { approxTokens } from '../tokenomics/engine/trace.ts'
import { CostEngine } from '../tokenomics/services/index.ts'
import { argValue, frontmatterDescription, isMain, isObj, type Obj } from '../tokenomics/util.ts'
import { money2, numArg, useCurrency, write } from './common.ts'
import { listingTokens, monthlyRate } from './packlight.ts'

const MCP_TIMEOUT_MS = 20_000

export type Item = { kind: 'skill' | 'command' | 'agent' | 'mcp', name: string, every_request: number, per_use: number }

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const frontName = (path: string) => /^---[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(path, 'utf8'))?.[1].trim().replace(/^["']|["']$/g, '')

/** A SKILL.md (or a command or agent .md): its listing line, and the body that loads when it is used. */
export function priceMarkdown(path: string, kind: Item['kind'], fallbackName: string): Item {
  const text = readFileSync(path, 'utf8')
  const name = frontName(path) || fallbackName
  const desc = frontmatterDescription(path) ?? ''
  const body = text.replace(/^---[\s\S]*?\n---\n?/, '')
  return { kind, name, every_request: listingTokens(name, desc), per_use: approxTokens(body.length) }
}

export function skillItems(target: string): Item[] {
  const file = isDir(target) ? join(target, 'SKILL.md') : target
  return [priceMarkdown(file, 'skill', basename(isDir(target) ? target : join(target, '..')))]
}

export function pluginItems(dir: string): Item[] {
  const out: Item[] = []
  const list = (d: string) => {
    try {
      return readdirSync(d)
    } catch {
      return []
    }
  }
  for (const s of list(join(dir, 'skills'))) {
    const f = join(dir, 'skills', s, 'SKILL.md')
    try {
      out.push(priceMarkdown(f, 'skill', s))
    } catch {
      // not a skill folder
    }
  }
  for (const [sub, kind] of [['commands', 'command'], ['agents', 'agent']] as const) {
    for (const f of list(join(dir, sub)).filter((x) => x.endsWith('.md'))) out.push(priceMarkdown(join(dir, sub, f), kind, f.replace(/\.md$/, '')))
  }
  return out
}

/** Tool definitions as they go into each request: name, description and input schema. */
export function mcpItem(name: string, tools: Obj[]): Item {
  const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema ?? t.input_schema }))
  return { kind: 'mcp', name, every_request: approxTokens(JSON.stringify(defs).length), per_use: 0 }
}

function toolsFrom(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.filter(isObj)
  if (isObj(v) && Array.isArray(v.tools)) return v.tools.filter(isObj)
  if (isObj(v) && isObj(v.result)) return toolsFrom(v.result)
  return []
}

/** Start a stdio MCP server, list its tools (following nextCursor), stop it. */
export function listTools(cmd: string[], timeoutMs = MCP_TIMEOUT_MS): Promise<Obj[]> {
  return new Promise((done, fail) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const tools: Obj[] = []
    let buf = ''
    let id = 1
    const finish = (err?: Error) => {
      clearTimeout(timer)
      p.kill()
      if (err) fail(err)
      else done(tools)
    }
    const timer = setTimeout(() => finish(tools.length ? undefined : new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs)
    const send = (m: Obj) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    p.on('error', (e) => finish(e))
    p.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        let m: Obj
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'notifications/initialized' })
          send({ id: ++id, method: 'tools/list', params: {} })
        } else if (m.id === id && isObj(m.result)) {
          tools.push(...toolsFrom(m.result))
          if (m.result.nextCursor) send({ id: ++id, method: 'tools/list', params: { cursor: m.result.nextCursor } })
          else finish()
        } else if (m.id === id && m.error) {
          finish(new Error(String(m.error.message ?? 'tools/list failed')))
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'tokenomics-dry-run', version: '1' } } })
  })
}

export function price(items: Item[], rate: { sessions: number, requests: number, usdPerTokenMonth: number }, days: number): Obj {
  const tokens = items.reduce((a, i) => a + i.every_request, 0)
  return { items, every_request_tokens: tokens, per_month_usd: tokens * rate.usdPerTokenMonth,
    basis: { days, sessions: rate.sessions, requests: rate.requests } }
}

function render(label: string, r: Obj): string {
  const { fmt } = CostEngine.display()
  const n = (v: number) => Math.round(v).toLocaleString('en-GB')
  const L = [`dry-run: ${label} adds about ${n(r.every_request_tokens)} tokens to every request.`]
  if (r.basis.requests) {
    L.push(`About ${fmt(r.per_month_usd)} a month at your pace (${n(r.basis.requests)} requests in ${r.basis.sessions} session${r.basis.sessions === 1 ? '' : 's'} over the last ${r.basis.days} days).`)
  } else {
    L.push('No recent Claude Code sessions to price it against: run it again after a few sessions, or pass --days 0 for all time.')
  }
  if (r.items.length > 1) for (const i of [...r.items].sort((a: Item, b: Item) => b.every_request - a.every_request)) L.push(`- ${i.kind} ${i.name}: ${n(i.every_request)} tokens`)
  const used = r.items.filter((i: Item) => i.per_use > 0)
  if (used.length === 1) L.push(`Each time it is used it loads about ${n(used[0].per_use)} more tokens.`)
  L.push('Install it between sessions: mid-session, the change makes the prompt cache start again.')
  return L.join('\n')
}

export async function main(args: string[]): Promise<number> {
  if (!useCurrency(args)) return 2
  const [what, target] = args
  const days = Math.max(0, Math.trunc(numArg(args, '--days', 30)))
  let items: Item[]
  let label: string
  try {
    if (what === 'skill' && target) {
      items = skillItems(target)
      label = `the ${items[0].name} skill`
    } else if (what === 'plugin' && target) {
      items = pluginItems(target)
      label = `the ${basename(resolve(target))} plugin (${items.length} skills, commands and agents)`
      if (!items.length) throw new Error(`no skills, commands or agents in ${target}`)
    } else if (what === 'mcp' && argValue(args, '--tools')) {
      const file = argValue(args, '--tools')!
      items = [mcpItem(argValue(args, '--name') ?? basename(file, '.json'), toolsFrom(JSON.parse(readFileSync(file, 'utf8'))))]
      label = `the ${items[0].name} MCP server (${toolsFrom(JSON.parse(readFileSync(file, 'utf8'))).length} tools)`
    } else if (what === 'mcp' && args.includes('--')) {
      const cmd = args.slice(args.indexOf('--') + 1)
      if (!cmd.length) throw new Error('give the server command after --')
      const tools = await listTools(cmd)
      const name = argValue(args.slice(0, args.indexOf('--')), '--name') ?? basename([...cmd].reverse().find((c) => !c.startsWith('-')) ?? cmd[0]).replace(/\.[cm]?[jt]s$|\.py$/, '')
      items = [mcpItem(name, tools)]
      label = `the ${name} MCP server (${tools.length} tools)`
    } else {
      process.stderr.write('Usage: dryrun.ts skill <path> | plugin <folder> | mcp --tools <file.json> | mcp -- <command> [args]\n')
      return 2
    }
  } catch (e) {
    process.stderr.write(`dry-run: ${e instanceof Error ? e.message : e}\n`)
    return 1
  }
  const r = price(items, monthlyRate(days, argValue(args, '--projects') ?? undefined), days)
  write(args.includes('--json') ? JSON.stringify({ target: label, ...r }, money2, 2) : render(label, r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
