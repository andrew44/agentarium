/** cache-buster, too-many-cooks, kettle, hold-up, diet's learned sizes, doggybag before compaction, receipt and dry-run. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, user, withEnv, writeTranscript, type TempEnv } from './helpers.ts'

import * as cachebuster from '../scripts/cachebuster.ts'
import * as controller from '../scripts/controller.ts'
import * as doggybag from '../scripts/doggybag.ts'
import * as dryrun from '../scripts/dryrun.ts'
import * as kettle from '../scripts/kettle.ts'
import * as receipt from '../scripts/receipt.ts'
import * as cooks from '../scripts/toomanycooks.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as diet from '../tokenomics/engine/diet.ts'
import { TOOL_READ, TOOL_SHELL, toolCall } from '../tokenomics/engine/evidence.ts'
import * as holdup from '../tokenomics/engine/holdup.ts'
import { prefixKind, rebuildCost } from '../tokenomics/engine/prefix.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { PolicyEngine } from '../tokenomics/services/index.ts'
import { today } from '../tokenomics/util.ts'

const MODEL = 'claude-opus-5-5'

/** An assistant request with a timestamp, model and a context of `ctx` tokens (mostly cache reads). */
function turn(id: string, ctx: number, opts: { ts?: string, tools?: [string, object][], extra?: object } = {}) {
  return { type: 'assistant', timestamp: opts.ts ?? '2026-11-25T10:00:00Z', ...opts.extra,
    message: { id, model: MODEL, content: (opts.tools ?? []).map(([name, input], i) => ({ type: 'tool_use', id: `${id}-${i}`, name, input })),
      usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1010 } } }
}

function hook(t: TempEnv, script: string, args: string[], payload: object, env = {}) {
  const p = runScript(script, args, { input: JSON.stringify(payload), env: t.env(env) })
  assert.equal(p.status, 0, p.stderr)
  assert.equal(p.stderr, '')
  return p.stdout.trim() ? JSON.parse(p.stdout) : null
}

describe('cache-buster', () => {
  test('knows which files sit at the start of every request', (c) => {
    const t = useTemp(c)
    const cwd = t.mkdir('repo', 'app')
    writeFileSync(join(t.home, 'repo', 'CLAUDE.md'), '# rules\n\n@docs/shared.md\n')
    const kind = (p: string) => withEnv({ HOME: t.home }, () => prefixKind(p, cwd))
    return (async () => {
      assert.equal(await kind(join(cwd, 'CLAUDE.md')), 'instructions')
      assert.equal(await kind(join(t.home, 'repo', 'CLAUDE.md')), 'instructions')          // a parent folder's
      assert.equal(await kind(join(t.home, 'repo', 'docs', 'shared.md')), 'instructions')  // imported with @
      assert.equal(await kind(join(t.home, '.claude', 'CLAUDE.md')), 'instructions')
      assert.equal(await kind(join(cwd, '.claude', 'settings.local.json')), 'settings')
      assert.equal(await kind(join(cwd, '.mcp.json')), 'mcp')
      assert.equal(await kind(join(cwd, '.claude', 'skills', 'x', 'SKILL.md')), 'skills')
      assert.equal(await kind(join(cwd, '.claude', 'commands', 'ship.md')), 'skills')
      assert.equal(await kind(join(cwd, 'src', 'index.ts')), null)
      assert.equal(await kind(join(cwd, 'docs', 'CLAUDE.md.bak')), null)
    })()
  })

  test('prices the rebuild from the last main-thread request', () => {
    const t = trace.parseText([turn('a', 20_000), turn('b', 60_000)].map((r) => JSON.stringify(r)).join('\n'))
    const r = rebuildCost(t)!
    assert.equal(r.ctx, 60_000)
    assert.ok(r.usd > 0 && !r.oneHour)
  })

  test('hook: warns once per file, stays quiet for small contexts and other files', (c) => {
    const t = useTemp(c)
    const cwd = t.mkdir('proj')
    const big = writeTranscript(t.home, 'big', [user('fix it'), turn('m1', 60_000)])
    const small = writeTranscript(t.home, 'small', [user('fix it'), turn('m1', 5_000)])
    const edit = (path: string, transcript = big, sid = 's1') => ({ session_id: sid, cwd, transcript_path: transcript, tool_name: 'Edit',
      tool_input: { file_path: path } })
    const out = hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md')))
    assert.match(out.systemMessage, /^cache-buster: CLAUDE\.md is part of the instructions.*60,000 tokens/)
    assert.equal(hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md'))), null)            // once per file
    assert.equal(hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'src.ts'), big, 's2')), null)
    assert.equal(hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md'), small, 's3')), null)
    assert.equal(hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md'), big, 's4'), { TOKENOMICS_CACHEBUSTER: 'off' }), null)
    const asked = hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md'), big, 's5'), { TOKENOMICS_CACHEBUSTER: 'ask' })
    assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask')
    const denied = hook(t, 'cachebuster.ts', ['claude-code'], edit(join(cwd, 'CLAUDE.md'), big, 's6'), { TOKENOMICS_CACHEBUSTER: 'block' })
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Leave the change as a note/)
    assert.deepEqual(t.rows('SELECT session_id, kind, action FROM cachebuster_events ORDER BY id'),
      [{ session_id: 's1', kind: 'instructions', action: 'warn' }, { session_id: 's5', kind: 'instructions', action: 'ask' },
        { session_id: 's6', kind: 'instructions', action: 'deny' }])
    for (const bad of ['', 'not json', '{}']) assert.equal(runScript('cachebuster.ts', ['claude-code'], { input: bad, env: t.env() }).stdout, '')
  })

  test('check replays a session', (c) => {
    const t = useTemp(c)
    const cwd = t.mkdir('proj')
    const recs = [{ type: 'user', cwd, message: { content: 'tidy CLAUDE.md' } }, turn('m1', 40_000, { tools: [['Edit', { file_path: join(cwd, 'CLAUDE.md') }], ['Edit', { file_path: join(cwd, 'a.ts') }]], extra: { cwd } })]
    const edits = cachebuster.replay(trace.parse(writeTranscript(t.home, 's', recs)))
    assert.deepEqual(edits.map((e) => [e.kind, e.ctx_tokens]), [['instructions', 40_000]])
  })
})

describe('too-many-cooks', () => {
  const sent = (desc: string, prompt: string) => ['Agent', { description: desc, prompt, subagent_type: 'general-purpose' }] as [string, object]
  const brief = 'Audit the payment retry logic in src/payments/retry.ts and src/payments/queue.ts for race conditions and summarise every risk you find with line numbers'

  test('judge: overlap, lookup and fan-out', () => {
    const t = trace.parseText([JSON.stringify(user('review payments')), JSON.stringify(turn('m1', 30_000, { tools: [sent('payments audit', brief)] }))].join('\n'))
    assert.equal(cooks.judge(t, { description: 'again', prompt: brief + ' please' })?.rule, 'overlap')
    assert.equal(cooks.judge(t, { prompt: 'find where the config file is' })?.rule, 'lookup')
    assert.equal(cooks.judge(t, { prompt: 'Write the migration for the new invoices table, with a rollback and tests covering both directions of the change' }), null)
    const many = trace.parseText([JSON.stringify(user('go')), JSON.stringify(turn('m1', 30_000, { tools: [1, 2, 3].map((i) => sent(`job ${i}`, `distinct work package number ${i} alpha${i} beta${i} gamma${i}`)) }))].join('\n'))
    assert.equal(cooks.judge(many, { prompt: 'Write the migration for the new invoices table with a rollback' }, 3)?.rule, 'fan_out')
  })

  test('hook warns once per rule; SubagentStop records what a subagent cost', (c) => {
    const t = useTemp(c)
    const main = writeTranscript(t.home, 'main', [user('review payments'), turn('m1', 30_000, { tools: [sent('payments audit', brief)] })])
    const call = (sid: string, env = {}) => hook(t, 'toomanycooks.ts', ['guard', 'claude-code'], { session_id: sid, transcript_path: main,
      tool_name: 'Agent', tool_input: { description: 'dup', prompt: brief } }, env)
    assert.match(call('s1').systemMessage, /^too-many-cooks: its brief shares \d+% of its words with "payments audit"/)
    assert.equal(call('s1'), null)
    assert.equal(call('s2', { TOKENOMICS_TOOMANYCOOKS: 'block' }).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(call('s3', { TOKENOMICS_TOOMANYCOOKS: 'off' }), null)
    const sub = join(t.mkdir('main', 'subagents'), 'agent-1.jsonl')
    writeFileSync(sub, [turn('x1', 15_000), turn('x2', 18_000)].map((r) => JSON.stringify(r)).join('\n') + '\n')
    assert.equal(hook(t, 'toomanycooks.ts', ['record'], { session_id: 's1', agent_type: 'Explore', agent_transcript_path: sub }), null)
    const [row] = t.rows('SELECT agent, model, requests, tokens FROM toomanycooks_agents')
    assert.deepEqual(row, { agent: 'Explore', model: MODEL, requests: 2, tokens: 33_100 })
    const rep = JSON.parse(runScript('toomanycooks.ts', ['report', '--json'], { env: t.env() }).stdout)
    assert.equal(rep.subagents, 1)
    assert.deepEqual(rep.caught.map((r: any) => r.rule), ['overlap'])
  })
})

describe('kettle', () => {
  test('reads the time left and the money at risk', () => {
    const t = trace.parseText(JSON.stringify(turn('m1', 50_000, { ts: '2026-11-25T10:00:00Z' })))
    const at = Date.parse('2026-11-25T10:01:40Z') / 1000
    const k = kettle.reading(t, at)!
    assert.equal(k.secondsLeft, 200)
    assert.match(kettle.message(k), /^kettle: 3:20 to reply before the cache goes cold \(50,000 tokens, about £\d+\.\d\d at risk\)$/)
    assert.equal(kettle.reading(t, at + 400), null)                                    // already cold
    assert.ok(kettle.terminalSequence('a;b\nc').startsWith('\u001b]9;a;b c\u0007'))
  })

  test('hook: a terminal notification once per request, only for waits', (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 's', [user('go'), turn('m1', 50_000, { ts: new Date(Date.now() - 30_000).toISOString() })])
    const p = { session_id: 's', transcript_path: path, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }
    const out = hook(t, 'kettle.ts', ['claude-code'], p)
    assert.match(out.terminalSequence, /^\u001b\]9;kettle: 4:\d\d to reply/)
    assert.equal(out.systemMessage, undefined)
    assert.equal(hook(t, 'kettle.ts', ['claude-code'], p), null)
    assert.equal(hook(t, 'kettle.ts', ['claude-code'], { ...p, session_id: 'x', notification_type: 'auth_success' }), null)
    assert.equal(hook(t, 'kettle.ts', ['claude-code'], { ...p, session_id: 'y' }, { TOKENOMICS_KETTLE: 'off' }), null)
  })
})

describe('diet: what calls actually print', () => {
  test('files sizes under the program or file type, never the arguments', () => {
    const sh = (command: string) => diet.sizeKind(toolCall('Bash', TOOL_SHELL, { command }))
    assert.equal(sh('FOO=1 sudo kubectl get pods -A'), 'kubectl')
    assert.equal(sh('kubectl logs x | tail'), null)                // filtered: says nothing about the program
    assert.equal(sh('cat big.log # diet-ok'), null)
    assert.equal(diet.sizeKind(toolCall('Read', TOOL_READ, { path: '/w/data/Report.JSON' })), 'read .json')
  })

  test('a program that floods the context here gets the same treatment as the built-in rules', () => {
    const call = toolCall('Bash', TOOL_SHELL, { command: 'terraform plan' })
    assert.equal(diet.check(call, null, {}), null)
    assert.equal(diet.check(call, null, { terraform: 200 * 1024 })?.rule, 'big-by-habit')
    assert.equal(diet.check(toolCall('Bash', TOOL_SHELL, { command: 'terraform plan | grep change' }), null, { terraform: 200 * 1024 }), null)
  })

  test('adapters measure tool output', () => {
    const cc = getAdapter('claude-code')
    assert.equal(cc.toolResultChars({ tool_response: { stdout: 'abc', stderr: 'de', interrupted: false } }), 5)
    assert.equal(cc.toolResultChars({ tool_response: { file: { content: 'x'.repeat(40) } } }), 40)
    assert.equal(getAdapter('copilot').toolResultChars({ toolResult: { resultType: 'success', textResultForLlm: 'hello' } }), 5)
    assert.equal(cc.toolResultChars({}), null)
  })

  test('the post-tool hook records sizes, and the guard learns from them', (c) => {
    const t = useTemp(c)
    const big = 'x'.repeat(300 * 1024)
    for (let i = 0; i < diet.LEARN_MIN_RUNS; i++) {
      assert.equal(hook(t, 'diet.ts', ['measure', 'claude-code'], { session_id: 's', tool_name: 'Bash',
        tool_input: { command: `terraform plan -var n=${i}` }, tool_response: { stdout: big, stderr: '' } }), null)
    }
    assert.deepEqual(t.rows('SELECT DISTINCT kind FROM diet_sizes'), [{ kind: 'terraform' }])
    assert.ok(!JSON.stringify(t.rows('SELECT * FROM diet_sizes')).includes('-var'))
    const out = hook(t, 'diet.ts', ['claude-code'], { session_id: 's', tool_name: 'Bash', tool_input: { command: 'terraform plan' } })
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /`terraform` has typically printed about 76,800 tokens here/)
    assert.equal(hook(t, 'diet.ts', ['claude-code'], { session_id: 's', tool_name: 'Bash', tool_input: { command: 'terraform plan' } },
      { TOKENOMICS_DIET_LEARN: 'off' }), null)
    const sizes = JSON.parse(runScript('diet.ts', ['sizes', '--json'], { env: t.env() }).stdout)
    assert.deepEqual(sizes.kinds.map((k: any) => [k.kind, k.runs, k.flagged]), [['terraform', 5, true]])
  })
})

describe('doggybag before compaction', () => {
  test('packs at PreCompact without printing, and loads the note back after', (c) => {
    const t = useTemp(c)
    const cwd = t.mkdir('proj')
    const path = writeTranscript(t.home, 'sess', [user('add a login page'), turn('m1', 80_000, { tools: [['Edit', { file_path: join(cwd, 'login.ts') }]] })])
    const d = { session_id: 'sess', cwd, transcript_path: path, trigger: 'auto' }
    assert.equal(hook(t, 'doggybag.ts', ['compact', 'claude-code'], d), null)
    const meta = JSON.parse(readFileSync(join(cwd, '.doggybag', 'sess.json'), 'utf8'))
    assert.equal(meta.reason, 'auto-compact')
    const out = doggybag.start({ session_id: 'sess', cwd, source: 'compact' })!
    assert.match(out.hookSpecificOutput.additionalContext, /packed just before the conversation was compacted[\s\S]*# Doggybag/)
    assert.equal(doggybag.start({ session_id: 'other', cwd, source: 'compact' }), null)
  })
})

describe('receipt', () => {
  test('adds up only the lines on this branch in this repository, subagents included', (c) => {
    const t = useTemp(c)
    const repo = t.mkdir('repo')
    const on = (b: string, cwd = repo) => ({ gitBranch: b, cwd, sessionId: 'S1' })
    const path = writeTranscript(t.home, 'S1', [
      { ...user('build it'), ...on('feat/x') }, turn('a', 20_000, { extra: on('feat/x') }),
      turn('b', 30_000, { extra: on('main') }), turn('c', 30_000, { extra: on('feat/x', join(t.home, 'elsewhere')) }),
    ])
    mkdirSync(join(t.home, 'S1', 'subagents'), { recursive: true })
    writeFileSync(join(t.home, 'S1', 'subagents', 'agent-1.jsonl'), JSON.stringify(turn('s', 10_000, { extra: on('feat/x') })) + '\n')
    const r = receipt.receipt(repo, 'feat/x', [path], t.db)
    assert.deepEqual([r.sessions, r.requests, r.prompts], [1, 2, 1])
    assert.equal(r.cache_read_tokens, 30_000 - 2_020)
    assert.match(receipt.line(r), /^AI-Cost: £\d+\.\d\d \(1 session, 2 requests, \d+% cache reads\)$/)
    assert.match(receipt.markdown(r), /\*\*AI cost of `feat\/x`:\*\*/)
    assert.equal(receipt.receipt(repo, 'feat/y', [path], t.db).requests, 0)
  })
})

describe('dry-run', () => {
  test('prices skills, plugins and MCP servers', async (c) => {
    const t = useTemp(c)
    const [skill] = dryrun.skillItems(join(ROOT, 'skills', 'receipt'))
    assert.equal(skill.name, 'receipt')
    assert.ok(skill.every_request > 50 && skill.per_use > skill.every_request)
    const all = dryrun.pluginItems(ROOT)
    assert.ok(all.filter((i) => i.kind === 'skill').length >= 28)
    const server = join(t.home, 'mcp.mjs')
    writeFileSync(server, `import readline from 'node:readline'
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l)
  if (m.method === 'initialize') out({ id: m.id, result: { capabilities: {} } })
  if (m.method === 'tools/list') out({ id: m.id, result: m.params.cursor ? { tools: [{ name: 'b', description: 'y'.repeat(400) }] }
    : { tools: [{ name: 'a', description: 'x'.repeat(400) }], nextCursor: '2' } }) })
`)
    const tools = await dryrun.listTools([process.execPath, server], 10_000)
    assert.deepEqual(tools.map((x) => x.name), ['a', 'b'])
    const item = dryrun.mcpItem('fake', tools)
    assert.ok(item.every_request > 200 && item.every_request < 260)
    const priced = dryrun.price([item], { sessions: 10, requests: 1000, usdPerTokenMonth: 0.0003 }, 30)
    assert.equal(Math.round(priced.per_month_usd * 1000) / 1000, Math.round(item.every_request * 0.0003 * 1000) / 1000)
    const cli = runScript('dryrun.ts', ['mcp', '--json', '--', process.execPath, server], { env: t.env() })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).items[0].name, 'mcp')
    assert.equal(runScript('dryrun.ts', [], { env: t.env() }).status, 2)
  })
})

describe('hold-up', () => {
  const ask = 'why does the worker crash at start-up? here is the log:\n'
  const log = (lines: number) => Array.from({ length: lines }, (_, i) =>
    `2026-11-25T10:${String(i % 60).padStart(2, '0')}:00.123Z INFO  worker[${i}] processed job ${i} in ${i % 97} ms queue=default`).join('\n')
  const BIG = ask + log(2000)                          // about 42,000 tokens

  test('says what most of a paste is', () => {
    const json = JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `user ${i}`, active: i % 2 === 0 })), null, 2)
    const csv = 'id,name,email\n' + Array.from({ length: 2000 }, (_, i) => `${i},User ${i},u${i}@example.com`).join('\n')
    const blob = 'data:image/png;base64,' + Buffer.from(Array.from({ length: 30_000 }, (_, i) => (i * 7919) % 256)).toString('base64')
    const py = 'Traceback (most recent call last):\n' +
      Array.from({ length: 600 }, (_, i) => `  File "/app/m${i}.py", line ${i}, in run\n    return step(ctx)`).join('\n') + '\nValueError: bad'
    const code = Array.from({ length: 2000 }, (_, i) => `  const v${i} = compute(input, options) // ERROR handling below`).join('\n')
    const prose = Array.from({ length: 600 }, (_, i) => `Sentence ${i}, which goes on a while, and then some more words until it ends.`).join('\n')
    const diff = Array.from({ length: 300 }, (_, i) => `diff --git a/src/m${i}.ts b/src/m${i}.ts\n--- a/src/m${i}.ts\n+++ b/src/m${i}.ts\n` +
      `@@ -${i},3 +${i},3 @@ export function run() {\n   const ctx = load()\n-  return step(ctx)\n+  return step(ctx, opts)\n }`).join('\n')
    const cases: [string, holdup.Kind][] = [[BIG, 'log'], [ask + py, 'log'], [ask + json, 'data'], [ask + JSON.stringify(JSON.parse(json)), 'data'],
      [ask + csv, 'data'], [ask + blob, 'blob'], [ask + code, 'code'], [ask + prose, 'doc'], [ask + diff, 'diff'],
      [readFileSync(join(ROOT, 'scripts', 'controller.ts'), 'utf8'), 'code'], [readFileSync(join(ROOT, 'docs', 'reference.md'), 'utf8'), 'doc'],
      [ask + Array.from({ length: 3000 }, (_, i) => `${'#'.repeat(i % 5)}~${i}~`.repeat(3)).join('\n'), 'paste']]
    for (const [text, kind] of cases) assert.equal(holdup.measure(text).kind, kind, text.slice(ask.length, ask.length + 60))
    const m = holdup.measure(BIG)
    assert.equal(m.lines, 2001)
    assert.equal(m.tokens, Math.ceil(BIG.length / 4))
  })

  test('only a big prompt, never a slash command', () => {
    assert.equal(holdup.check(ask + log(100), 10_000), null)
    assert.equal(holdup.check('/compact keep the plan\n' + log(2000), 10_000), null)
    assert.equal(holdup.check('', 10_000), null)
    assert.equal(holdup.check(BIG, 10_000)?.kind, 'log')
  })

  test('a blatantly broad ask, and only a blatant one', () => {
    for (const text of ['refactor the whole codebase', 'fix all the bugs', 'review every file and tidy it up', 'clean up everything',
      'explain the entire repo to me', 'go through the project-wide code and improve it']) assert.equal(holdup.tooBroad(text)?.kind, 'broad', text)
    for (const text of ['run the tests and fix any errors', 'fix all the lint issues', 'now do the same across the whole codebase',
      'in src/auth.ts fix all the bugs', 'fix every bug in `parseDate`', 'only touch the whole app config, leave the tests alone',
      'improve the code', 'fix the typo in the README', '/review the whole codebase', '',
      'refactor the whole codebase ' + 'with care '.repeat(50)]) assert.equal(holdup.tooBroad(text), null, text)
    assert.deepEqual(holdup.tooBroad('refactor the whole codebase and fix all the bugs')!.found, ['the whole codebase', 'every bug'])
    const b = holdup.tooBroad('fix all the bugs')!
    assert.match(holdup.broadMessage(b, { paused: true }),
      /^hold-up: this prompt asks for every bug in it but names no file, function or error .* re-read at every later step\. Name where to start .* Send the prompt again to go ahead as it is\.$/)
    assert.match(holdup.broadMessage(b, { paused: false }), /^hold-up: that prompt asked for every bug in it .* Cheaper next time: name where to start/)
  })

  test('the hook pauses a broad ask once, without money, and has its own switch', (c) => {
    const t = useTemp(c)
    const p = { session_id: 'b1', cwd: t.home, prompt: 'refactor the whole codebase' }
    const first = hook(t, 'holdup.ts', ['claude-code'], p)
    assert.equal(first.decision, 'block')
    assert.match(first.reason, /^hold-up: this prompt asks for the whole codebase/)
    assert.ok(!/[$£€]/.test(first.reason.split('\n')[0]))
    assert.match(first.reason, /\nWhy: An agent's cost is mostly reading/)            // the big-task lesson
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], p), null)
    assert.match(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 'b2' }, { TOKENOMICS_HOLDUP_BROAD: 'warn' }).systemMessage, /^hold-up: that prompt asked/)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 'b3' }, { TOKENOMICS_HOLDUP_BROAD: 'off' }), null)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 'b4' }, { TOKENOMICS_HOLDUP: 'off' }), null)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 'b5' }, { TOKENOMICS_HOLDUP: 'off', TOKENOMICS_HOLDUP_BROAD: 'block' }).decision, 'block')
    assert.deepEqual(t.rows('SELECT kind, action, usd FROM holdup_events ORDER BY id').map((r) => [r.kind, r.action, r.usd]),
      [['broad', 'block', null], ['broad', 'resent', null], ['broad', 'warn', null], ['broad', 'block', null]])
  })

  test('prices the paste: written once, re-read at every later step', () => {
    const p = holdup.price(100_000, MODEL, { steps: 5 })
    assert.ok(p.sendUsd > 0 && p.stepUsd > 0 && p.stepUsd < p.sendUsd)
    assert.equal(Math.round(p.taskUsd * 1e9), Math.round((p.sendUsd + 4 * p.stepUsd) * 1e9))
    assert.ok(holdup.price(100_000, MODEL, { ttl1h: true }).sendUsd > p.sendUsd)
    assert.equal(holdup.price(100_000, MODEL).taskUsd, p.sendUsd)
  })

  test('the notice: money where billed by the token, the way out and what to do instead', () => {
    const p = holdup.measure(BIG)
    const cost = holdup.price(p.tokens, MODEL, { steps: 9 })
    const money = (usd: number) => `$${usd.toFixed(2)}`
    const paused = holdup.message(p, { paused: true, cost, money })
    assert.match(paused, /^hold-up: this prompt is about 42,\d{3} tokens over 2,001 lines, mostly a pasted log\. /)
    assert.match(paused, /about \$\d+\.\d\d to send, then \$\d+\.\d\d at every later step until you \/clear \(about \$\d+\.\d\d over a task like your last ones, 9 steps\)/)
    assert.match(paused, /the agent can grep it.* Send the prompt again to go ahead as it is\.$/)
    assert.match(holdup.message(p, { paused: false, cost, money }), /^hold-up: that prompt was .* \/compact drops it .* Cheaper next time: save it to a file/)
    const plain = holdup.message(p, { paused: true })
    assert.ok(!/[$£€]/.test(plain), 'no money where the platform bills premium requests')
    assert.match(plain, /filling the context window/)
  })

  test('the hook pauses once, lets the same prompt through and logs no prompt text', (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 's1', [user('start the worker'), turn('a', 30_000), turn('b', 31_000), turn('c', 32_000)])
    const p = { session_id: 's1', transcript_path: path, cwd: t.home, prompt: BIG }
    const first = hook(t, 'holdup.ts', ['claude-code'], p)
    assert.equal(first.decision, 'block')
    assert.match(first.reason, /^hold-up: this prompt is about 42,\d{3} tokens .*mostly a pasted log\. .*about £\d+\.\d\d to send/)
    assert.match(first.reason, /over a task like your last ones, 3 steps/)
    assert.match(first.reason, /\nWhy: A prompt stays in the conversation/)             // the lesson
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], p), null)                          // sent again: go ahead
    const rows = t.rows('SELECT * FROM holdup_events ORDER BY id')
    assert.deepEqual(rows.map((r) => [r.kind, r.action]), [['log', 'block'], ['log', 'resent']])
    assert.ok(Number(rows[0].usd) > 0 && rows[1].usd === null)
    assert.ok(rows.every((r) => !Object.values(r).some((v) => typeof v === 'string' && v.includes('worker['))), 'never the prompt itself')

    const warned = hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 's2' }, { TOKENOMICS_HOLDUP: 'warn' })
    assert.match(warned.systemMessage, /^hold-up: that prompt was/)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 's3' }, { TOKENOMICS_HOLDUP: 'off' }), null)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 's4' }, { TOKENOMICS_HOLDUP_MIN_TOKENS: '60000' }), null)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 's5', prompt: 'fix the typo in the README' }), null)
    assert.equal(hook(t, 'holdup.ts', ['claude-code'], { ...p, session_id: 's6', transcript_path: join(t.home, 'gone.jsonl') }).decision, 'block')
    assert.equal(runScript('holdup.ts', ['claude-code'], { input: 'not json', env: t.env() }).status, 0)
  })

  test('VS Code pauses without money; Copilot CLI, which ignores the output, only records', (c) => {
    const t = useTemp(c)
    const vs = hook(t, 'holdup.ts', ['vscode'], { sessionId: 'v1', hookEventName: 'UserPromptSubmit', prompt: BIG })
    assert.equal(vs.continue, false)
    assert.ok(!/[$£€]/.test(vs.stopReason))
    assert.equal(hook(t, 'holdup.ts', ['copilot'], { sessionId: 'c1', prompt: BIG }), null)
    assert.deepEqual(t.rows('SELECT source, action FROM holdup_events ORDER BY id').map((r) => [r.source, r.action]),
      [['vscode', 'block'], ['copilot', 'none']])
  })

  test('the controller runs it before pennywise, and a pause stops the rest', async (c) => {
    const t = useTemp(c)
    const raw = JSON.stringify({ session_id: 'k1', cwd: t.home, prompt: BIG })
    const vars = { TOKENOMICS_DB: t.db, TOKENOMICS_HOME: join(t.home, '.tk'), TOKENOMICS_CONTROLLER_TIMING: 'off', TOKENOMICS_HOLDUP: undefined,
      TOKENOMICS_BUDGET_DAILY: undefined, TOKENOMICS_BUDGET_SESSION: undefined, ANTHROPIC_BASE_URL: '' }
    const d = await withEnv(vars, () => controller.decide(raw))
    assert.equal(d.output!.decision, 'block')
    assert.equal(d.decidedBy, 'holdup')
    assert.deepEqual(d.ran, ['spendlens', 'budget', 'holdup'])
  })

  test('the dashboard counts the pauses, and tokens kept out only for pastes not sent again', (c) => {
    const t = useTemp(c)
    const ev = (fields: Record<string, string | number | null>) => PolicyEngine.log(t.db, 'holdup_events',
      { session_id: 's', source: 'claude-code', kind: 'log', lines: 100, prompt_sha: 'x', usd: null, ...fields })
    ev({ est_tokens: 30_000, usd: 0.4, action: 'block' })
    ev({ est_tokens: 30_000, action: 'resent' })
    ev({ est_tokens: 20_000, usd: 0.3, action: 'block' })
    ev({ est_tokens: 12_000, usd: 0.1, action: 'warn' })
    ev({ est_tokens: 8, kind: 'broad', action: 'block' })
    const h = withDb(t.db, (db) => PolicyEngine.activity(db, today()), { readOnly: true }).helpers.find((x) => x.helper === 'hold-up')!
    assert.deepEqual([h.stopped, h.flagged, h.tokens, h.at_stake_usd, h.saved_usd], [3, 1, 20_000, 0.8, 0])
  })
})

describe('wiring: the new hooks, commands and skills', () => {
  test('every one is registered', (c) => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    const cmds = (event: string) => (hooks[event] ?? []).flatMap((g: any) => g.hooks.map((h: any) => `${g.matcher ?? ''} ${h.command}`))
    assert.ok(cmds('PreToolUse').some((x: string) => x.startsWith('Edit|Write') && x.endsWith('cachebuster.ts claude-code')))
    assert.ok(cmds('PreToolUse').some((x: string) => x.startsWith('Agent|Task') && x.endsWith('toomanycooks.ts guard claude-code')))
    assert.ok(cmds('PostToolUse').some((x: string) => x.endsWith('diet.ts measure claude-code')))
    assert.ok(cmds('SubagentStop').some((x: string) => x.endsWith('toomanycooks.ts record claude-code')))
    assert.ok(cmds('PreCompact').some((x: string) => x.endsWith('doggybag.ts compact claude-code')))
    assert.ok(cmds('Notification').some((x: string) => x.startsWith('idle_prompt') && x.endsWith('kettle.ts claude-code')))
    assert.ok(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8').includes('diet.ts measure copilot'))
    const t = useTemp(c)
    for (const name of ['cache-buster', 'too-many-cooks', 'receipt', 'dry-run']) {
      assert.match(readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`^---\\nname: ${name}\\ndescription: `))
    }
    for (const args of [['cache-buster', '--transcript', writeTranscript(t.home, 'x', [user('hi')])], ['too-many-cooks'], ['toomanycooks'], ['diet', 'sizes']]) {
      const p = runScript('cli.ts', args, { env: t.env() })
      assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`)
    }
  })
})
