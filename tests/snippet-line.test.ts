/**
 * appendSnippet 必须返回真实行号：说话人归属按行号对齐，计数一漂名字就挂错行。
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendSnippet } from '../src/asr-log.ts'

const DAY = '2026-11-18'

test('连续写入返回递增行号，且与文件行数一致', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-line-'))
  try {
    const first = appendSnippet(root, { day: DAY, startAt: `${DAY}T01:00:00.000Z`, endAt: `${DAY}T01:00:05.000Z`, track: 'mic', text: '第一句' })
    const second = appendSnippet(root, { day: DAY, startAt: `${DAY}T01:01:00.000Z`, endAt: `${DAY}T01:01:05.000Z`, track: 'mic', text: '第二句' })
    assert.equal(first, 1)
    assert.equal(second, 2)
    const lines = readFileSync(path.join(root, DAY, 'snippets.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('不同日期各自从 1 开始编号', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-line-'))
  try {
    const today = appendSnippet(root, { day: DAY, startAt: `${DAY}T03:00:00.000Z`, endAt: `${DAY}T03:00:05.000Z`, track: 'mic', text: 'A' })
    const other = appendSnippet(root, { day: '2026-11-19', startAt: '2026-11-19T01:00:00.000Z', endAt: '2026-11-19T01:00:05.000Z', track: 'mic', text: 'B' })
    assert.equal(today, 1)
    assert.equal(other, 1, '换一天要重新从 1 开始')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
