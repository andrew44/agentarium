/**
 * Prefix: the files whose contents sit at the start of every request, and what it costs when one changes.
 *
 * Claude Code builds the start of each request from instruction files (CLAUDE.md, CLAUDE.local.md and
 * the files they import with @path), settings, MCP servers and the skill, command and agent listings.
 * That start is what the prompt cache keys on. Change any of it mid-session and the next request that
 * picks the change up writes the whole context to the cache again: the same "prefix change" cold-snap
 * finds afterwards. Used by cache-buster (before the edit) and dry-run (before an install).
 *
 * Words and numbers only: file names are compared, contents are read only to follow @imports.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { ratesFor } from './pricing.ts'
import type { Trace } from './trace.ts'

export type PrefixKind = 'instructions' | 'settings' | 'mcp' | 'skills'

const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md'])
const IMPORT_RE = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/gm

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

function expand(p: string, base: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return isAbsolute(p) ? p : resolve(base, p)
}

/** The instruction files Claude Code loads for `cwd`: CLAUDE.md and CLAUDE.local.md in it and every folder
 *  above, and ~/.claude/CLAUDE.md. */
export function instructionFiles(cwd: string): string[] {
  const out = [join(homedir(), '.claude', 'CLAUDE.md')]
  let d = resolve(cwd)
  for (;;) {
    for (const f of INSTRUCTION_FILES) out.push(join(d, f))
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/** Files an instruction file pulls in with `@path` lines (one level, as Claude Code follows them). */
export function imports(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const base = dirname(file)
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(IMPORT_RE)].map((m) => expand(m[1], base))
}

/** What part of the prefix `path` is, for a session in `cwd`, or null when editing it leaves the prefix alone. */
export function prefixKind(path: string, cwd: string): PrefixKind | null {
  if (!path) return null
  const p = expand(path, cwd)
  const home = homedir()
  const roots = [resolve(cwd), home]
  const name = basename(p)
  const loaded = instructionFiles(cwd)
  if (loaded.includes(p)) return 'instructions'
  if (loaded.some((f) => imports(f).includes(p))) return 'instructions'
  if (p === join(home, '.claude.json') || p === join(resolve(cwd), '.mcp.json')) return 'mcp'
  for (const r of roots) {
    const claude = join(r, '.claude')
    if (!inside(p, claude)) continue
    const rel = relative(claude, p).split(sep)
    if (rel.length === 1 && /^settings(\.local)?\.json$/.test(name)) return 'settings'
    if (rel[0] === 'skills' && name === 'SKILL.md') return 'skills'
    if ((rel[0] === 'commands' || rel[0] === 'agents') && name.endsWith('.md')) return 'skills'
  }
  return null
}

export type Rebuild = { ctx: number, model: string, usd: number, oneHour: boolean }

/** What re-writing this session's context to the cache would cost over a warm read, from its last
 *  main-thread request. Null when the session has no priced request yet. */
export function rebuildCost(t: Trace): Rebuild | null {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const x = t.turns[i]
    if (x.sidechain || x.ctx <= 0) continue
    const r = ratesFor(x.model)
    const oneHour = x.usage.cacheCreation1hTokens > 0
    return { ctx: x.ctx, model: x.model, oneHour, usd: x.ctx * ((oneHour ? r.cache_write_1h : r.cache_write_5m) - r.cache_read) / 1e6 }
  }
  return null
}
