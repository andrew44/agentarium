#!/usr/bin/env node
/**
 * agentarium / audit: every "where is it leaking?" check in one report.
 *
 * pennywise, the band and the guard-rails prevent spend as it happens. The audits find what they
 * can't: the fixed load every request carries, output nobody needed, cold caches, context dragged
 * between tasks, bloated instruction files, work that produced nothing, loops, repeated
 * instructions and creeping cost per task. Each is still its own helper (and command); this runs
 * them all, keeps the sections with something to say, and puts the biggest money first.
 *
 *   audit.ts [--days 30] [--only pack-light,waffle] [--json] [--currency USD]
 *
 * Sections (all read-only):
 *   pack-light    what every request carries before you type, and what you never use
 *   waffle        output spend: long replies, recaps, whole-file rewrites
 *   cold-snap     every cold cache, why it went cold, and what it cost
 *   ballast       context carried from one task into the next (newest session here)
 *   spring-clean  CLAUDE.md / AGENTS.md: duplicate, stale and bloated instructions
 *   deadwood      spend on work that produced nothing
 *   groundhog     loops the newest session here went round
 *   parrot        instructions you repeat across sessions
 *   waistline     is the same work getting dearer?
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { argValue, isMain, type Obj } from '../agentarium/util.ts'

type Section = { name: string, about: string, args: (days: string) => string[] }

export const SECTIONS: Section[] = [
  { name: 'pack-light', about: 'what every request carries', args: (d) => ['--days', d] },
  { name: 'waffle', about: 'output spend', args: (d) => ['--days', d] },
  { name: 'cold-snap', about: 'cold caches and why', args: (d) => ['--days', d] },
  { name: 'ballast', about: 'context carried between tasks', args: () => ['check'] },
  { name: 'spring-clean', about: 'instruction files', args: () => [] },
  { name: 'deadwood', about: 'work that produced nothing', args: (d) => ['--days', d] },
  { name: 'groundhog', about: 'loops', args: () => ['check'] },
  { name: 'parrot', about: 'repeated instructions', args: (d) => ['report', '--days', d] },
  { name: 'waistline', about: 'cost per task, trending', args: (d) => ['--days', d] },
]

export type Result = { name: string, about: string, ok: boolean, json: Obj | null, markdown: string, money: number }

/** The biggest money figure a section's JSON mentions (USD or display currency), for ordering. */
export function headline(j: unknown): number {
  let best = 0
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 4) return
    if (typeof v === 'number' && /(usd|cost|saving|spend|per_month|wasted|dead)/i.test(key) && Number.isFinite(v)) best = Math.max(best, v)
    else if (Array.isArray(v)) v.slice(0, 50).forEach((x) => walk(x, key, depth + 1))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1)
  }
  walk(j, '', 0)
  return best
}

/** The helper's script: its name without the hyphens (cold-snap -> coldsnap.ts). */
export const script = (name: string) => name.replaceAll('-', '')

function run(name: string, args: string[], extra: string[]): { status: number | null, stdout: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, `${script(name)}.ts`), ...args, ...extra],
    { encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, stdout: r.stdout ?? '' }
}

export function audit(opts: { days?: string, only?: string[], currency?: string } = {}): Result[] {
  const days = opts.days ?? '30'
  const cur = opts.currency ? ['--currency', opts.currency] : []
  const out: Result[] = []
  for (const s of SECTIONS) {
    if (opts.only?.length && !opts.only.some((o) => script(o) === script(s.name))) continue   // the old unhyphenated names still match
    const withCur = ['pack-light', 'spring-clean', 'deadwood', 'waistline'].includes(s.name) ? cur : []
    const j = run(s.name, s.args(days), ['--json', ...withCur])
    let json: Obj | null = null
    try {
      json = j.status === 0 ? JSON.parse(j.stdout) : null
    } catch {
      json = null
    }
    const md = json ? run(s.name, s.args(days), withCur).stdout.trim() : ''
    out.push({ name: s.name, about: s.about, ok: Boolean(json), json, markdown: md, money: json ? headline(json) : 0 })
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || b.money - a.money)
}

export function markdown(rs: Result[]): string {
  const L = ['# agentarium audit', '',
    '_Every leak check in one place, biggest money first. Each section is also its own command (`agentarium <name>`)._', '']
  // a section with no money in it and only a line or two is a "nothing yet": fold it into one line
  const quiet = (r: Result) => !r.ok || !r.markdown || (r.money === 0 && r.markdown.split('\n').filter((l) => l.trim()).length <= 4)
  const empty = rs.filter(quiet)
  for (const r of rs.filter((x) => !quiet(x))) {
    const body = r.markdown.replace(/^# .*\n+/, '')        // each report's own title becomes a section
    L.push(`## ${r.name}: ${r.about}`, '', body, '')
  }
  if (empty.length) L.push(`_Nothing to report yet: ${empty.map((r) => r.name).join(', ')} (no sessions or files to check here)._`)
  return L.join('\n')
}

export function main(argv: string[]): number {
  const only = (argValue(argv, '--only') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const rs = audit({ days: argValue(argv, '--days') ?? '30', only, currency: argValue(argv, '--currency') ?? undefined })
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(rs.map(({ markdown: _m, ...r }) => r), null, 2) + '\n')
  else process.stdout.write(markdown(rs) + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
