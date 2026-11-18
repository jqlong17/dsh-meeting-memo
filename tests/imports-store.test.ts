/**
 * 离线导入的存储：按任务独立目录、重复拦截、片段与密度、删除。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendSnippet,
  bucketsOf,
  clock,
  deleteImport,
  findByHash,
  fingerprint,
  listImports,
  makeImportId,
  readSnippets,
  writeMeta,
} from '../src/imports.ts'

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
}

test('fingerprint 稳定，同内容同大小哈希一致', () => {
  const file = path.join(os.tmpdir(), `mm-fp-${Date.now()}.bin`)
  writeFileSync(file, 'hello world')
  const a = fingerprint(file)
  const b = fingerprint(file)
  assert.equal(a.hash, b.hash)
  rmSync(file, { force: true })
})

test('任务 id 带时间前缀和哈希后缀', () => {
  const id = makeImportId('abcdef1234567890', new Date('2026-11-18T12:40:00'))
  assert.match(id, /^20261118-1240-[0-9a-f]{8}$/)
})

test('写入、读回片段，密度按分钟聚合', () => {
  const dir = home()
  try {
    const id = '20261118-1240-aaaaaaaa'
    writeMeta(dir, {
      version: 1, id, name: 'a.m4a', size: 10, hash: 'aaaaaaaa', durationSec: 120,
      createdAt: '2026-11-18T04:40:00.000Z', status: 'done', processedSec: 120, snippets: 2,
    })
    appendSnippet(dir, id, { startSec: 5, endSec: 10, text: '第一句' })
    appendSnippet(dir, id, { startSec: 65, endSec: 70, text: '第二句' })
    const rows = readSnippets(dir, id)
    assert.equal(rows.length, 2)
    const buckets = bucketsOf(rows)
    assert.deepEqual(buckets.map((b) => b.m), [0, 1])
    assert.equal(listImports(dir).length, 1)
    assert.equal(findByHash(dir, 'aaaaaaaa')?.name, 'a.m4a')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除任务后目录消失', () => {
  const dir = home()
  try {
    const id = '20261118-1240-bbbbbbbb'
    writeMeta(dir, {
      version: 1, id, name: 'b.m4a', size: 10, hash: 'bbbbbbbb', durationSec: 60,
      createdAt: '2026-11-18T04:40:00.000Z', status: 'done', processedSec: 60, snippets: 0,
    })
    assert.ok(existsSync(path.join(dir, 'imports', id)))
    assert.equal(deleteImport(dir, id), true)
    assert.equal(existsSync(path.join(dir, 'imports', id)), false)
    assert.equal(readdirSync(path.join(dir, 'imports')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clock 显示 m:ss 与 h:mm:ss', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(75), '1:15')
  assert.equal(clock(3725), '1:02:05')
})
