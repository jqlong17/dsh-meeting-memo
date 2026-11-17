import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { compareVersion, dueForCheck, readDependency } from '../src/update.ts'

test('compares versions by major.minor.patch', () => {
  assert.equal(compareVersion('0.3.5', '0.3.4'), 1)
  assert.equal(compareVersion('0.3.4', '0.3.5'), -1)
  assert.equal(compareVersion('0.3.4', '0.3.4'), 0)
  assert.equal(compareVersion('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersion('v0.3.4', '0.3.4'), 0)
})

test('treats link: and file: as local development', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prof-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-meeting-memo': 'link:/tmp/repo' },
    }))
    assert.equal(readDependency(dir, 'dsh-meeting-memo').mode, 'link')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('treats a semver range as an installed package', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prof-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-meeting-memo': '^0.3.0' },
    }))
    assert.equal(readDependency(dir, 'dsh-meeting-memo').mode, 'npm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown when the dependency is absent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prof-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    assert.equal(readDependency(dir, 'dsh-meeting-memo').mode, 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checks once per day', () => {
  const now = Date.parse('2026-11-17T10:00:00Z')
  assert.equal(dueForCheck({}, now), true)
  assert.equal(dueForCheck({ checkedAt: new Date(now - 60_000).toISOString() }, now), false)
  assert.equal(dueForCheck({ checkedAt: new Date(now - 23 * 3600_000).toISOString() }, now), false)
  assert.equal(dueForCheck({ checkedAt: new Date(now - 24 * 3600_000).toISOString() }, now), true)
  assert.equal(dueForCheck({ checkedAt: 'not-a-date' }, now), true)
})
