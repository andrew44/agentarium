#!/usr/bin/env node
/**
 * agentarium / fishingrod: teach a habit rather than flag a prompt.
 *
 * Give a man a fish and you feed him for a day. The prompt-time notices (ballast, parrot, haggle,
 * sommelier, doggybag, budget) say what a prompt costs; the first few times each one comes up it
 * also says why, and what to type next time. After that it shrinks to one line pointing here, so
 * the lesson is always a command away. Lessons: agentarium/engine/lessons.ts.
 *
 *   fishingrod.ts                  every lesson, and how often each has come up
 *   fishingrod.ts <lesson>         one lesson in full, e.g. fishingrod.ts new-task
 *   add --json for machine-readable output. Read-only.
 *
 * Env:
 *   AGENTARIUM_FISHINGROD        on (default: the full lesson the first few times, then a pointer)
 *                                | always (the full lesson every time) | off (no lessons, no pointer)
 *   AGENTARIUM_FISHINGROD_TIMES  how many times a lesson is shown in full (default 3, at most once
 *                                per session)
 * What was shown is logged to `fishingrod_events` (the lesson's name, never the prompt).
 */
import { defaultDbPath } from '../agentarium/config.ts'
import * as lessons from '../agentarium/engine/lessons.ts'
import { isMain } from '../agentarium/util.ts'
import { write } from './common.ts'

export function main(args: string[]): number {
  const json = args.includes('--json')
  const key = args.find((a) => !a.startsWith('--'))
  if (key) {
    const l = lessons.get(key)
    if (!l) {
      process.stderr.write(`No lesson called '${key}'. Run 'agentarium fishingrod' for the list.\n`)
      return 1
    }
    write(json ? JSON.stringify(l, null, 2) : `# ${l.topic}\n\n${lessons.text(l)}`)
    return 0
  }
  const seen = lessons.taught(defaultDbPath())
  const rows = lessons.all().map((l) => ({ ...l, taught: seen.get(l.key)?.total ?? 0 }))
  if (json) {
    write(JSON.stringify({ mode: lessons.mode(), times: lessons.times(), lessons: rows }, null, 2))
    return 0
  }
  const L = ['# fishingrod: the why behind each notice', '',
    `Each lesson is shown in full the first ${lessons.times()} times it comes up, then as a pointer here` +
    `${lessons.mode() === 'off' ? ' (lessons are off: AGENTARIUM_FISHINGROD=off)' : ''}.`, '']
  for (const r of rows) L.push(`- \`${r.key}\` ${r.topic}${r.taught ? ` (shown ${r.taught}x)` : ''}`)
  L.push('', "Read one with 'agentarium fishingrod <lesson>'.")
  write(L.join('\n'))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
