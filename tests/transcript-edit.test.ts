/**
 * 手动改某一句：只改那一行的 text，行数/顺序/其它字段都不动。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendSnippet, updateSnippetText } from '../src/asr-log.ts'

const DAY = '2026-11-20'

test('改第二句，其余行与字段保持不变', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-edit-'))
  try {
    appendSnippet(root, { day: DAY, startAt: `${DAY}T01:00:00.000Z`, endAt: `${DAY}T01:00:05.000Z`, track: 'mic', text: '第一句' })
    appendSnippet(root, { day: DAY, startAt: `${DAY}T01:01:00.000Z`, endAt: `${DAY}T01:01:05.000Z`, track: 'mic', text: '第二句错了' })
    appendSnippet(root, { day: DAY, startAt: `${DAY}T01:02:00.000Z`, endAt: `${DAY}T01:02:05.000Z`, track: 'mic', text: '第三句' })
    assert.equal(updateSnippetText(root, DAY, 2, '第二句改对了'), true)
    const rows = readFileSync(path.join(root, DAY, 'snippets.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.length, 3)
    assert.equal(rows[0].text, '第一句')
    assert.equal(rows[1].text, '第二句改对了')
    assert.equal(rows[2].text, '第三句')
    // 其它字段仍在
    assert.equal(rows[1].track, 'mic')
    assert.ok(rows[1].startAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('行号越界返回 false，不写坏文件', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-edit-'))
  try {
    appendSnippet(root, { day: DAY, startAt: `${DAY}T02:00:00.000Z`, endAt: `${DAY}T02:00:05.000Z`, track: 'mic', text: '唯一一句' })
    assert.equal(updateSnippetText(root, DAY, 9, '乱写'), false)
    const rows = readFileSync(path.join(root, DAY, 'snippets.jsonl'), 'utf8').trim().split('\n')
    assert.equal(rows.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
