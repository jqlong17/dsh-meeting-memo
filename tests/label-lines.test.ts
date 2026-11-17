/**
 * 展开与删除单句：删一句只影响这一句，删完最后一句整条标注消失。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { addLabel, readLabels, removeLabelLine, removeLabelLines, updateLabel } from '../src/speaker-labels.ts'

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mm-line-'))
}

test('删一句只从这条标注里摘掉它', () => {
  const dir = home()
  try {
    const { item: label } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞', lines: [1, 2, 3] })
    const rest = removeLabelLine(dir, label.id, 2)
    assert.deepEqual(rest?.lines, [1, 3])
    assert.equal(readLabels(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删掉最后一句时整条标注一起消失', () => {
  const dir = home()
  try {
    const { item: label } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞', lines: [5] })
    assert.equal(removeLabelLine(dir, label.id, 5), null)
    assert.equal(readLabels(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批量摘句：一次删多行，只影响选中的', () => {
  const dir = home()
  try {
    const { item } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞', lines: [1, 2, 3, 4] })
    const rest = removeLabelLines(dir, item.id, [2, 4])
    assert.deepEqual(rest?.lines, [1, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批量摘句：选中的是全部时整条消失', () => {
  const dir = home()
  try {
    const { item } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞', lines: [7, 8] })
    assert.equal(removeLabelLines(dir, item.id, [7, 8]), null)
    assert.equal(readLabels(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('改名字与备注，只改这一条', () => {
  const dir = home()
  try {
    const { item } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞', note: '旧备注', lines: [1] })
    const next = updateLabel(dir, item.id, { label: '朝飞（前端）', note: '前端同学' })
    assert.equal(next?.label, '朝飞（前端）')
    assert.equal(next?.note, '前端同学')
    assert.equal(readLabels(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('名字不允许改成空', () => {
  const dir = home()
  try {
    const { item } = addLabel(dir, { day: '2026-11-17', start: 60, end: 62, label: '朝飞' })
    assert.equal(updateLabel(dir, item.id, { label: '   ' }), null)
    assert.equal(readLabels(dir)[0].label, '朝飞')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
