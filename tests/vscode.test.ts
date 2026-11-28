/** The VS Code adapter: Claude Code-shaped hooks, Copilot's tools and bill. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, withEnv } from './helpers.ts'

import { statusVsix, vscodeHooks, zip } from '../scripts/cli.ts'
import { copilotStatus } from '../scripts/statusline.ts'
import { stepsFor } from '../scripts/controller.ts'
import { decide } from '../scripts/premium.ts'
import { settings } from '../agentarium/config.ts'
import { TOOL_CODE_EDIT, TOOL_READ, TOOL_SHELL } from '../agentarium/engine/evidence.ts'
import * as session from '../agentarium/engine/session.ts'
import { ALL_CAPABILITIES, BILLING_COPILOT_PREMIUM_REQUESTS, Capability } from '../agentarium/platform/capabilities.ts'
import { getAdapter, premiumBilled } from '../agentarium/platform/registry.ts'
import { TelemetryEngine } from '../agentarium/services/index.ts'
import { events } from '../agentarium/services/telemetry.ts'
import { eventSessions } from '../agentarium/services/value.ts'
import { withDb } from '../agentarium/engine/db.ts'

const vs = () => getAdapter('vscode')

describe('vscode adapter', () => {
  test('is registered, with its aliases, and declares every capability', () => {
    assert.equal(vs().name, 'vscode')
    assert.equal(getAdapter('vscode-copilot').name, 'vscode')
    assert.equal(getAdapter('VS-Code').name, 'vscode')
    for (const cap of ALL_CAPABILITIES) assert.ok(cap in vs().capabilities, cap)
  })

  test('bills premium requests and reads no transcript', () => {
    assert.equal(vs().billingModel, BILLING_COPILOT_PREMIUM_REQUESTS)
    assert.ok(premiumBilled('vscode') && premiumBilled('copilot') && !premiumBilled('claude-code'))
    assert.ok(!vs().supports(Capability.TRANSCRIPT) && !vs().supports(Capability.TOKEN_USAGE))
    assert.ok(vs().supports(Capability.PROMPT_DECISION))
    assert.equal(vs().sessionEvidence({ sessionId: 's', transcript_path: '/nope.json' }), null)
  })

  test('maps VS Code events onto the shared lifecycle', () => {
    const cases: [string, string][] = [['UserPromptSubmit', 'prompt'], ['PreToolUse', 'tool_call'], ['PostToolUse', 'tool_result'],
      ['Stop', 'turn_end'], ['SubagentStop', 'turn_end'], ['SessionStart', 'session_start']]
    for (const [name, want] of cases) assert.equal(vs().lifecycle({ hookEventName: name }, 'x'), want, name)
    assert.equal(vs().event({ hookEventName: 'Stop' }, 'finalize'), 'turn_end')
    assert.equal(vs().sessionId({ sessionId: 'abc' }), 'abc')
  })

  test("reads Copilot's tool names from Claude Code-shaped payloads", () => {
    const call = (tool_name: string, tool_input: object) => vs().toolCall({ tool_name, tool_input })!
    assert.equal(call('read_file', { filePath: 'a.ts', startLine: 1, endLine: 20 }).kind, TOOL_READ)
    assert.equal(call('read_file', { filePath: 'a.ts', startLine: 1 }).ranged, true)
    assert.equal(call('replace_string_in_file', { filePath: 'a.ts' }).kind, TOOL_CODE_EDIT)
    assert.equal(call('edit_notebook_file', { filePath: 'n.ipynb' }).path, 'n.ipynb')
    assert.equal(call('run_in_terminal', { command: 'npm test' }).kind, TOOL_SHELL)
    assert.equal(vs().toolCall({}), null)
  })

  test('tool results: resultType or success / is_error', () => {
    assert.equal(vs().toolOk({ tool_response: { resultType: 'failure' } }), false)
    assert.equal(vs().toolOk({ tool_response: { success: true } }), true)
    assert.equal(vs().toolOk({ tool_response: { is_error: true } }), false)
    assert.equal(vs().toolOk({ tool_response: 'ok' }), null)
  })

  test("answers in Claude Code's hook output shapes", () => {
    assert.equal((vs().denyTool('no') as any).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal((vs().askTool('sure?') as any).hookSpecificOutput.permissionDecision, 'ask')
    assert.deepEqual(vs().blockPrompt('stop'), { continue: false, stopReason: 'stop', systemMessage: 'stop' })
    assert.deepEqual(vs().notify('hi'), { systemMessage: 'hi' })
  })

  test('the model comes from the payload only', () => {
    assert.equal(vs().sessionModel({ model: 'gpt-5' }), 'gpt-5')
    assert.equal(vs().sessionModel({ model: { id: 'claude-sonnet-4' } }), 'claude-sonnet-4')
    assert.equal(vs().sessionModel({}), null)
  })
})

describe('vscode sessions', () => {
  test('are recorded from events, with no tokens invented', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db })
    session.recordPrompt(vs(), { sessionId: 'v', hookEventName: 'UserPromptSubmit', prompt: 'add a parser' }, s)
    session.recordTool(vs(), { sessionId: 'v', hookEventName: 'PostToolUse', tool_name: 'create_file', tool_input: { filePath: 'p.ts' } }, s)
    await session.finalize(vs(), { sessionId: 'v', hookEventName: 'Stop' }, s)
    const r = t.session('v')!
    assert.equal(r.total_tokens, null)
    assert.deepEqual([r.billing_model, r.evidence], [BILLING_COPILOT_PREMIUM_REQUESTS, 'hook-events'])
  })

  test('count towards the premium allowance and the event-only reports', (c) => {
    const t = useTemp(c)
    TelemetryEngine.ingest(getAdapter('copilot'), { sessionId: 'a', hookEventName: 'userPromptSubmitted', prompt: 'x' }, 'prompt', t.db)
    TelemetryEngine.ingest(vs(), { sessionId: 'b', hookEventName: 'UserPromptSubmit', prompt: 'y' }, 'prompt', t.db)
    withDb(t.db, (db) => {
      assert.equal(events(db, { platform: ['copilot', 'vscode'] }).filter((e) => e.type === 'prompt').length, 2)
      assert.deepEqual(eventSessions(db, '2000-01-01').map((e) => e.platform).sort(), ['copilot', 'vscode'])
    }, { readOnly: true })
  })

  test('the premium guard can pause a VS Code prompt', async (c) => {
    const t = useTemp(c)
    for (const sid of ['a', 'b']) TelemetryEngine.ingest(vs(), { sessionId: sid, hookEventName: 'UserPromptSubmit', prompt: 'p' }, 'prompt', t.db)
    const out = await withEnv({ AGENTARIUM_DB: t.db, AGENTARIUM_COPILOT_ALLOWANCE: '1', AGENTARIUM_PREMIUM: undefined },
      () => decide({ sessionId: 'b', prompt: 'p' }, vs(), t.db))
    assert.equal(out?.continue, false)
  })
})

describe('vscode hooks', () => {
  test('the controller runs the steps that work without a transcript', () => {
    assert.deepEqual(stepsFor('vscode').map((s) => s.name), ['till', 'premium', 'holdup', 'blinkers'])
  })

  test('every hook goes through the launcher, as vscode, with this install path', () => {
    const cfg = JSON.parse(vscodeHooks('/opt/tk'))
    const hooks = Object.values(cfg.hooks).flat() as { command: string, windows: string }[]
    assert.ok(hooks.length >= 5)
    for (const h of hooks) {
      assert.match(h.command, /^sh "\/opt\/tk\/scripts\/run\.sh" \S+\.ts .*vscode$/)
      assert.match(h.windows, /"\/opt\/tk\/scripts\/\S+\.ts" .*vscode$/)
      const script = h.command.split(' ')[2]
      assert.ok(existsSync(join(ROOT, 'scripts', script)), script)
    }
    assert.ok(!readFileSync(join(ROOT, 'vscode-hooks.json'), 'utf8').includes('copilot '))
  })
})

/** The entries of a stored (uncompressed) zip, as zip() writes them. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18)
    const n = buf.readUInt16LE(at + 26)
    const name = buf.subarray(at + 30, at + 30 + n).toString('utf8')
    out[name] = buf.subarray(at + 30 + n, at + 30 + n + size).toString('utf8')
    at += 30 + n + size
  }
  return out
}

describe('Copilot in VS Code\'s status bar and the Copilot app\'s window', () => {
  const prompt = (t: { db: string }, sid: string) =>
    TelemetryEngine.ingest(vs(), { sessionId: sid, hookEventName: 'UserPromptSubmit', prompt: 'p' }, 'prompt', t.db)

  test('without an allowance: today\'s prompts, and how to get the forecast', (c) => {
    const t = useTemp(c)
    prompt(t, 'a')
    prompt(t, 'b')
    return withEnv({ AGENTARIUM_DB: t.db, AGENTARIUM_COPILOT_ALLOWANCE: undefined, AGENTARIUM_BAND: undefined }, () => {
      const b = copilotStatus()
      assert.ok(b.show)
      assert.equal(b.short, '2 prompts today')
      assert.equal(b.premium, null)
      assert.match(b.hint!, /AGENTARIUM_COPILOT_ALLOWANCE/)
    })
  })

  test('with an allowance: requests left, and amber or red as it runs short', (c) => {
    const t = useTemp(c)
    for (const sid of ['a', 'b', 'c']) prompt(t, sid)
    return withEnv({ AGENTARIUM_DB: t.db, AGENTARIUM_COPILOT_MULTIPLIER: '1', AGENTARIUM_BAND: undefined }, async () => {
      const roomy = await withEnv({ AGENTARIUM_COPILOT_ALLOWANCE: '100000' }, () => copilotStatus())
      assert.ok(roomy.show && roomy.premium)
      assert.equal(roomy.level, 'green')
      assert.match(roomy.short, /^99997\/100000 premium left/)
      assert.match(roomy.text, /premium requests left this month/)
      assert.ok(!roomy.text.includes('\x1b'))
      const over = await withEnv({ AGENTARIUM_COPILOT_ALLOWANCE: '2' }, () => copilotStatus())
      assert.ok(over.show)
      assert.equal(over.level, 'red')
      assert.equal(over.short, '3/2 premium · over')
    })
  })

  test('--band-off hides it everywhere', () =>
    withEnv({ AGENTARIUM_BAND: 'off' }, () => assert.deepEqual(copilotStatus(), { show: false })))

  test('statusline.ts --copilot --json gives the same numbers', (c) => {
    const t = useTemp(c)
    prompt(t, 'a')
    const r = runScript('statusline.ts', ['--copilot', '--json'], { env: { ...process.env, AGENTARIUM_DB: t.db, AGENTARIUM_COPILOT_ALLOWANCE: '300' } })
    const b = JSON.parse(r.stdout)
    assert.equal(b.platform, 'copilot')
    assert.equal(b.premium.used, 1)
    assert.equal(b.today.prompts, 1)
  })

  test('the .vsix holds the manifest and the extension, pointed at this install', () => {
    const files = unzip(statusVsix("/opt/it's tk"))
    assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/extension.js', 'extension/package.json'])
    const pkg = JSON.parse(files['extension/package.json'])
    const version = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).version
    assert.equal(pkg.version, version)
    assert.match(files['extension.vsixmanifest'], new RegExp(`Id="agentarium-status" Version="${version}" Publisher="agentarium"`))
    assert.ok(files['extension/extension.js'].includes("const ROOT = '/opt/it\\'s tk'"))
    assert.ok(!files['extension/extension.js'].includes('${AGENTARIUM_ROOT}'))
  })

  test('zip() writes entries a reader can find, with their CRCs', () => {
    const buf = zip({ 'a.txt': 'hello', 'b/c.json': '{}' })
    assert.deepEqual(unzip(buf), { 'a.txt': 'hello', 'b/c.json': '{}' })
    assert.equal(buf.readUInt32LE(14), 0x3610a686)                    // crc32('hello')
    assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50)
    assert.equal(buf.readUInt16LE(buf.length - 12), 2)
  })

  test('the extension draws the numbers on a status bar item, and hides it when off', (c) => {
    const t = useTemp(c)
    const file = join(t.home, 'extension.js')
    writeFileSync(file, readFileSync(join(ROOT, 'vscode', 'extension.js'), 'utf8'))
    class ThemeColor { id: string; constructor(id: string) { this.id = id } }
    class MarkdownString { value = ''; constructor(v = '') { this.value = v } appendMarkdown(s: string) { this.value += s; return this } }
    const fake = { ThemeColor, MarkdownString }
    const req = createRequire(file)
    const Module = req('node:module')
    const load = Module._load
    Module._load = function (name: string, ...rest: unknown[]) { return name === 'vscode' ? fake : load.call(this, name, ...rest) }
    try {
      const { draw } = req(file)
      const item: Record<string, any> = { shown: false, show() { this.shown = true }, hide() { this.shown = false } }
      draw(item, null, { show: true, level: 'yellow', short: '40/300 premium left · runs out ~27 Nov', text: 'row', today: { prompts: 3, requests: 3 }, hint: null })
      assert.equal(item.text, '$(pulse) 40/300 premium left · runs out ~27 Nov')
      assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground')
      assert.match(item.tooltip.value, /Today: 3 prompts/)
      assert.ok(item.shown)
      draw(item, 'spawn node ENOENT', null)
      assert.equal(item.text, '$(pulse) agentarium')
      assert.match(item.tooltip.value, /ENOENT/)
      draw(item, null, { show: false })
      assert.ok(!item.shown)
    } finally {
      Module._load = load
    }
  })
})
