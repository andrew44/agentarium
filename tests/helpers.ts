/**
 * Shared test helpers. Importing this first gives the whole test process a throwaway HOME,
 * AGENTARIUM_HOME and AGENTARIUM_DB, so no test ever touches the real ~/.agentarium, and drops any
 * TOKENOMICS_* settings (import.ts reads them), so a tokenomics install never leaks in either.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Db, type Row } from '../agentarium/engine/db.ts'

export const ROOT = join(import.meta.dirname, '..')
export const SCRIPTS = join(ROOT, 'scripts')

const sandbox = mkdtempSync(join(tmpdir(), 'agentarium-test-'))
const ours = (k: string) => k.startsWith('AGENTARIUM_') || k.startsWith('TOKENOMICS_')
for (const k of Object.keys(process.env)) if (ours(k)) delete process.env[k]
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.AGENTARIUM_HOME = join(sandbox, '.agentarium')
process.env.AGENTARIUM_DB = join(sandbox, '.agentarium', 'till.db')
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

export const USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 }

export function user(text: unknown, meta = false) {
  return { type: 'user', isMeta: meta, message: { role: 'user', content: text } }
}

export function assistant(mid: string, tools: [string, object][] = [], usage: object = USAGE): Record<string, any> {
  return { type: 'assistant', message: { id: mid, content: tools.map(([name, input]) => ({ type: 'tool_use', name, input })), usage } }
}

export function writeTranscript(directory: string, name: string, records: object[]): string {
  const p = join(directory, `${name}.jsonl`)
  writeFileSync(p, records.map((r) => JSON.stringify(r) + '\n').join(''))
  return p
}

export type Env = Record<string, string | undefined>

/** Run a script the way a hook runs it: node <script> args, with stdin. */
export function runScript(script: string, args: string[] = [], opts: { input?: string, env?: Env, timeout?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script.includes('/') || script.includes('\\') ? script : join(SCRIPTS, script), ...args], {
    input: opts.input ?? '', env: opts.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: opts.timeout ?? 30_000,
  })
}

/** Run `fn` with some environment variables set (undefined = unset), then put them back. */
export async function withEnv<T>(vars: Env, fn: () => T | Promise<T>): Promise<T> {
  const old: Env = {}
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Isolated HOME + DB for one test. */
export class TempEnv {
  home: string
  db: string

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'agentarium-t-'))
    this.db = join(this.home, 'till.db')
  }

  env(extra: Env = {}): Env {
    const e: Env = { ...process.env }
    for (const k of Object.keys(e)) if (ours(k)) delete e[k]
    return { ...e, HOME: this.home, USERPROFILE: this.home, AGENTARIUM_DB: this.db, ...extra }
  }

  hook(mode: string, source: string, payload: unknown, extra: Env = {}) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return runScript('till.ts', [mode, source], { input: data, env: this.env(extra) })
  }

  rows(sql: string, ...args: (string | number)[]): Row[] {
    const db = new Db(this.db)
    try {
      return db.all(sql, ...args).map((r) => ({ ...r }))
    } finally {
      db.close()
    }
  }

  session(sid: string): Row | null {
    return this.rows('SELECT * FROM sessions WHERE session_id=?', sid)[0] ?? null
  }

  mkdir(...parts: string[]): string {
    const p = join(this.home, ...parts)
    mkdirSync(p, { recursive: true })
    return p
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true })
  }
}

/** A TempEnv per test, cleaned up afterwards. */
export function useTemp(t: { after: (fn: () => void) => void }): TempEnv {
  const e = new TempEnv()
  t.after(() => e.cleanup())
  return e
}

/** A stand-in `claude` that behaves as the real one does where the installer cares (checked against
 *  Claude Code 2.1.332): `plugin update` fails when the plugin isn't installed and moves an installed
 *  one to `latest`; `plugin install` leaves an installed one at its version and exits 0; `plugin list
 *  --json` says which version is installed. The marketplace stays at the source it was first added
 *  from (`owner/repo#ref`, or a folder): adding it from another fails, `marketplace list --json`
 *  reports it as the real one does, and removing it uninstalls the plugin. Every call is logged to
 *  `log`. `installed` starts it with that version in place; `updates: false` makes `plugin update`
 *  succeed without moving it; `marketplace` starts it with the marketplace added from that source. */
export function fakeClaude(bin: string, log: string,
  opts: { latest: string, installed?: string, updates?: boolean, marketplace?: string }): string {
  const state = join(bin, '.claude-installed')
  const market = join(bin, '.claude-marketplace')
  if (opts.installed) writeFileSync(state, opts.installed)
  if (opts.marketplace) writeFileSync(market, opts.marketplace)
  const updates = opts.updates === false ? 'no' : 'yes'
  const path = join(bin, 'claude')
  writeFileSync(path, `#!/bin/sh
echo "$*" >> "${log}"
state="${state}"
market="${market}"
case "$1 $2 $3" in
  "plugin marketplace add") if [ ! -f "$market" ]; then printf '%s' "$4" > "$market"; elif [ "$(cat "$market")" != "$4" ]; then exit 1; fi ;;
  "plugin marketplace list")
    if [ ! -f "$market" ]; then echo '[]'; exit 0; fi
    src=$(cat "$market"); repo=\${src%%#*}; ref=\${src#"$repo"}; ref=\${ref#"#"}
    case "$src" in
      /*|./*) printf '[{"name":"agentarium","source":"directory","path":"%s"}]\\n' "$src" ;;
      *) if [ -n "$ref" ]; then printf '[{"name":"agentarium","source":"github","repo":"%s","ref":"%s"}]\\n' "$repo" "$ref"
         else printf '[{"name":"agentarium","source":"github","repo":"%s"}]\\n' "$repo"; fi ;;
    esac ;;
  "plugin marketplace remove") rm -f "$market" "$state" ;;
esac
case "$1 $2" in
  "plugin update") [ -f "$state" ] || exit 1; [ "${updates}" = yes ] && printf '%s' "${opts.latest}" > "$state"; exit 0 ;;
  "plugin install") [ -f "$state" ] || printf '%s' "${opts.latest}" > "$state"; exit 0 ;;
  "plugin list") if [ -f "$state" ]; then printf '[{"id":"agentarium@agentarium","version":"%s","scope":"user"}]\\n' "$(cat "$state")"; else echo '[]'; fi ;;
  "plugin uninstall") rm -f "$state" ;;
esac
exit 0
`)
  chmodSync(path, 0o755)
  return path
}
