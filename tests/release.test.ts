/** The release workflow's version logic (.github/scripts/next_version.ts). */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import './helpers.ts'

import * as nv from '../.github/scripts/next_version.ts'

describe('next version', () => {
  test('a pull request bumps the patch past main and the latest tag', () => {
    assert.deepEqual(nv.decide([1, 3, 0], [1, 3, 0], 'v1.3.0'), [[1, 3, 1], true])
    assert.deepEqual(nv.decide([1, 3, 4], [1, 3, 4], 'v1.3.2'), [[1, 3, 5], true])
    assert.deepEqual(nv.decide([1, 3, 0], [1, 3, 0], 'v1.3.6'), [[1, 3, 7], true])
  })

  test('a branch that already carries the next version is left alone', () => {
    assert.deepEqual(nv.decide([1, 3, 1], [1, 3, 0], 'v1.3.0'), [[1, 3, 1], false])
  })

  test('a branch whose bump was overtaken by main bumps again', () => {
    // Two pull requests both took 1.3.1; the second must move on once the first is merged.
    assert.deepEqual(nv.decide([1, 3, 1], [1, 3, 1], 'v1.3.1'), [[1, 3, 2], true])
  })

  test('a raised version is kept as it is', () => {
    assert.deepEqual(nv.decide([1, 4, 0], [1, 3, 7], 'v1.3.7'), [[1, 4, 0], false])
    assert.deepEqual(nv.decide([2, 0, 0], null, null), [[2, 0, 0], false])
  })

  test('main is released only when its version is newer than every tag', () => {
    assert.equal(nv.releasable([1, 3, 1], 'v1.3.0'), true)
    assert.equal(nv.releasable([1, 3, 0], 'v1.3.0'), false)
    assert.equal(nv.releasable([1, 3, 0], null), true)
  })

  test('versions compare numerically', () => {
    assert.ok(nv.compare(nv.parse('v1.10.0'), nv.parse('v1.9.0')) > 0)
    assert.throws(() => nv.parse('1.3'), nv.VersionError)
  })

  test('the manifests agree and are semver', () => {
    const versions = new Set(nv.MANIFESTS.map((p) => JSON.parse(readFileSync(p, 'utf8')).version))
    assert.equal(versions.size, 1, 'bump .claude-plugin/plugin.json and plugin.json together')
    nv.parse([...versions][0])
  })

  test('write changes only the version', () => {
    const d = mkdtempSync(join(tmpdir(), 'nv-'))
    try {
      const p = join(d, 'plugin.json')
      writeFileSync(p, '{\n  "name": "tokenomics",\n  "version": "1.3.0",\n  "x": "1.3.0"\n}\n')
      nv.write('1.3.1', [p])
      assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { name: 'tokenomics', version: '1.3.1', x: '1.3.0' })
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
