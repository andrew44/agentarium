#!/usr/bin/env node
/**
 * Work out release versions and keep the plugin manifests in step with them.
 *
 *   next_version.ts --base REF   for a pull request: print KEY=VALUE lines for $GITHUB_OUTPUT
 *                                  version=1.3.1   tag=v1.3.1   bump=true|false   previous=v1.3.0
 *                                bump=true means the branch still needs "version" raised to that.
 *   next_version.ts --release    for main: version=1.3.1 tag=v1.3.1 release=true|false previous=v1.3.0
 *                                release=true when the manifest version is newer than every tag.
 *   next_version.ts --write V    set "version" in every manifest to V
 *
 * The version workflow runs --base on each pull request to main and commits the bump to the
 * pull request's branch, so main always carries the version it will be released as. The release
 * workflow runs --release on main and tags that version.
 *
 * Rules for a pull request (the manifests are the source of truth; tags are vX.Y.Z):
 *   * You raised the version past main and the latest tag -> keep it (how you do minor/major).
 *   * Otherwise                                           -> the next patch after the higher of
 *                                                            the two (bump=true), because Claude Code
 *                                                            only sends a plugin update when the
 *                                                            version changes.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Version = [number, number, number]

const ROOT = join(import.meta.dirname, '..', '..')
export const MANIFESTS = [join(ROOT, '.claude-plugin', 'plugin.json'), join(ROOT, 'plugin.json')]
const VERSION_RE = /("version"\s*:\s*")([^"]+)(")/

export class VersionError extends Error {}

export function parse(v: string): Version {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (!m) throw new VersionError(`Not a MAJOR.MINOR.PATCH version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export const fmt = (t: Version) => t.join('.')

export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

const max = (a: Version, b: Version) => (compare(a, b) >= 0 ? a : b)

/** The one version every manifest text agrees on. */
export function agreed(texts: string[]): Version {
  const versions = new Set(texts.map((t) => String(JSON.parse(t).version)))
  if (versions.size !== 1) throw new VersionError(`The manifests disagree on the version: ${[...versions].sort().join(', ')}. Make them match.`)
  return parse([...versions][0])
}

export const manifestVersion = (manifests = MANIFESTS): Version => agreed(manifests.map((p) => readFileSync(p, 'utf8')))

function git(...args: string[]): string {
  return String(spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim()
}

/** The manifest version at a git ref (e.g. origin/main), or null if it has none. */
function versionAt(ref: string): Version | null {
  const texts = MANIFESTS.map((p) => git('show', `${ref}:${p.slice(ROOT.length + 1).replaceAll('\\', '/')}`))
  return texts.some((t) => !t) ? null : agreed(texts)
}

function latestTag(): string | null {
  const tags = git('tag', '--list', 'v*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  return tags.length ? tags.reduce((a, b) => (compare(parse(b), parse(a)) > 0 ? b : a)) : null
}

/** [version, bump] for a pull request, from its manifest version, the base branch's and the
 *  latest tag. */
export function decide(head: Version, base: Version | null, tag: string | null): [Version, boolean] {
  let floor = base
  if (tag !== null) floor = floor ? max(floor, parse(tag)) : parse(tag)
  if (floor === null || compare(head, floor) > 0) return [head, false]
  return [[floor[0], floor[1], floor[2] + 1], true]
}

/** Release main's version only if it is newer than every tag. */
export const releasable = (version: Version, tag: string | null): boolean => tag === null || compare(version, parse(tag)) > 0

export function write(version: string, manifests = MANIFESTS): void {
  for (const p of manifests) {
    const text = readFileSync(p, 'utf8')
    if (!VERSION_RE.test(text)) throw new VersionError(`No version field in ${p}`)
    writeFileSync(p, text.replace(VERSION_RE, (_m, a, _v, c) => a + version + c), 'utf8')
  }
}

function main(argv: string[]): number {
  try {
    const tag = latestTag()
    const out = (o: Record<string, string | boolean>) =>
      process.stdout.write(Object.entries({ ...o, previous: tag ?? '' }).map(([k, v]) => `${k}=${v}\n`).join(''))
    if (argv[0] === '--write') {
      write(fmt(parse(argv[1] ?? '')))
    } else if (argv[0] === '--base' && argv[1]) {
      const [version, bump] = decide(manifestVersion(), versionAt(argv[1]), tag)
      out({ version: fmt(version), tag: `v${fmt(version)}`, bump })
    } else if (argv[0] === '--release') {
      const version = manifestVersion()
      out({ version: fmt(version), tag: `v${fmt(version)}`, release: releasable(version, tag) })
    } else {
      throw new VersionError('Usage: next_version.ts --base REF | --release | --write VERSION')
    }
    return 0
  } catch (e) {
    if (!(e instanceof VersionError)) throw e
    process.stderr.write(e.message + '\n')
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
