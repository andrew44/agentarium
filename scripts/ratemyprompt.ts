#!/usr/bin/env node
/**
 * tokenomics / rate-my-prompt (alias: judge): a prompt scored out of 10 for what it will cost to carry out.
 *
 * Five criteria, up to 2 points each (rules: tokenomics/engine/promptscore.ts):
 *
 *   target   points at the code: a file, a function, a line, the error
 *   done     says what done looks like: a passing test, an expected result
 *   scope    one bounded task, not "improve everything" or a list of jobs
 *   lean     no padding: pleasantries, repeats, whole files or logs pasted in
 *   output   asks for lean output (a diff, a short reply) and no more effort than the job needs
 *
 *   rate-my-prompt: 6.4/10 (leaky: the agent will search, guess or over-explain)
 *
 *   ratemyprompt.ts "the prompt" [--json]          score this text
 *   ratemyprompt.ts --file prompt.txt [--json]     score a file ('-' or a pipe: read stdin)
 *   ratemyprompt.ts --last [--session ID | --transcript FILE] [--json]
 *                                                  your last prompt in this folder's newest session
 *
 * Read-only. The prompt is scored in memory and never stored. No settings.
 */
import { readFileSync } from 'node:fs'

import { findTranscript } from './coach.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { rate, type Rating } from '../tokenomics/engine/promptscore.ts'
import { argValue, isMain, readStdin } from '../tokenomics/util.ts'
import { write } from './common.ts'

// a prompt asking for the rating is not the one to rate
const ASKS_FOR_RATING = /\b(?:rate[- ]?my[- ]?prompt|judge)\b/i

/** The newest prompt in a transcript that isn't a request to rate one. */
export function lastPrompt(path: string): string | null {
  const prompts = trace.parse(path).prompts
  for (let i = prompts.length - 1; i >= 0; i--) if (!ASKS_FOR_RATING.test(prompts[i].text)) return prompts[i].text
  return null
}

export function markdown(r: Rating): string {
  const L = [`**rate-my-prompt: ${r.score}/${r.max}** (${r.verdict})`, '', '| Criterion | Score | Seen |', '|---|---:|---|']
  for (const c of r.criteria) L.push(`| ${c.label} | ${c.score}/${c.max} | ${c.found.join(', ') || 'nothing'} |`)
  L.push('')
  if (r.tips.length) {
    L.push('## Tighten it', '')
    for (const t of r.tips) L.push(`- ${t}`)
    L.push('')
  }
  L.push(`_About ${r.tokens.toLocaleString('en-GB')} tokens. Scored from the text alone: plain rules, the same prompt always gets the same score._`)
  return L.join('\n')
}

const VALUE_FLAGS = ['--file', '--session', '--transcript']

export function main(args: string[]): number {
  let text: string | null = null
  const file = argValue(args, '--file')
  if (args.includes('--last')) {
    const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
    text = p ? lastPrompt(p) : null
    if (!text) {
      process.stderr.write('No earlier prompt found in this folder\'s newest session. Pass the prompt, --file or --transcript.\n')
      return 1
    }
  } else if (file && file !== '-') {
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      process.stderr.write(`Cannot read ${file}\n`)
      return 1
    }
  } else {
    const words = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]))
    text = words.length ? words.join(' ') : readStdin()
  }
  if (!text.trim()) {
    process.stderr.write('Usage: ratemyprompt.ts "the prompt" | --file prompt.txt | --last  [--json]\n')
    return 2
  }
  const r = rate(text)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
