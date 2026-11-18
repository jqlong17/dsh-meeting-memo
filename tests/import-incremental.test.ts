/**
 * 增量拉取与临时文件清扫：面板轮询不该每 2 秒重传整份转写。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ImportService } from '../src/import-service.ts'
import { appendSnippet, listImports, listTrash, purgeTrash, trashImport, writeMeta } from '../src/imports.ts'

const ID = '20261118-1315-abc12345'

function makeService(): { service: ImportService; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-inc-'))
  writeMeta(home, {
    version: 1, id: ID, name: 'a.m4a', size: 1, hash: 'abc12345', durationSec: 120,
    createdAt: '2026-11-18T05:15:00.000Z', status: 'done', processedSec: 120, snippets: 3,
  })
  appendSnippet(home, ID, { startSec: 1, endSec: 3, text: '第一句' })
  appendSnippet(home, ID, { startSec: 5, endSec: 8, text: '第二句' })
  appendSnippet(home, ID, { startSec: 12, endSec: 15, text: '第三句' })
  const fake = { config: { home } } as unknown as ConstructorParameters<typeof ImportService>[0]
  return { service: new ImportService(fake, '/nonexistent', () => '', () => 'zhen'), home }
}

test('fromIndex=0 返回全部，并能拿到总数', () => {
  const { service, home } = makeService()
  try {
    const detail = service.get(ID)
    assert.equal(detail.snippets.length, 3)
    assert.equal(detail.total, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('fromIndex 只返回新增部分', () => {
  const { service, home } = makeService()
  try {
    const detail = service.get(ID, 2)
    assert.equal(detail.snippets.length, 1)
    assert.equal(detail.snippets[0].text, '第三句')
    assert.equal(detail.total, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('fromIndex 超过总数时返回空而不是报错', () => {
  const { service, home } = makeService()
  try {
    const detail = service.get(ID, 99)
    assert.equal(detail.snippets.length, 0)
    assert.equal(detail.total, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('清扫临时音轨只删老文件', async () => {
  const file = path.join(os.tmpdir(), `asr-import-${Date.now()}-test.m4a`)
  const { writeFileSync, existsSync, utimesSync } = await import('node:fs')
  writeFileSync(file, 'x')
  // 新文件：不该被删
  ImportService.sweepTempFiles()
  assert.equal(existsSync(file), true, '刚创建的文件不能删')
  // 改成 3 天前：该被删
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  utimesSync(file, old, old)
  const removed = ImportService.sweepTempFiles()
  assert.ok(removed >= 1)
  assert.equal(existsSync(file), false)
})


test('删除是移入回收站，不是真删', () => {
  const { service, home } = makeService()
  try {
    assert.equal(service.remove(ID), true)
    // 任务列表里没了
    assert.equal(listImports(home).length, 0)
    // 但目录还在回收站里
    const trashed = listTrash(home)
    assert.equal(trashed.length, 1)
    assert.ok(trashed[0].endsWith(ID))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('回收站里超过保留期的条目会被清掉', () => {
  const { service, home } = makeService()
  try {
    const target = trashImport(home, ID)
    assert.ok(target)
    // 刚放进去：不该被清
    assert.equal(purgeTrash(home), 0)
    // 把目录时间改成 8 天前：该被清
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(target!, old, old)
    assert.equal(purgeTrash(home), 1)
    assert.deepEqual(listTrash(home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
