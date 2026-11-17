import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { addLabel, deleteLabel, groupByDay, readLabels } from '../src/speaker-labels.ts'

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'spk-'))
}

test('adds a label and reads it back', () => {
  const home = tempHome()
  try {
    const { item } = addLabel(home, { day: '2026-11-16', start: 600.5, end: 602.25, label: '佳奇' })
    assert.equal(item.label, '佳奇')
    const items = readLabels(home)
    assert.equal(items.length, 1)
    assert.equal(items[0].start, 600.5)
    assert.equal(items[0].end, 602.25)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rejects a label without a name or a bad day', () => {
  const home = tempHome()
  try {
    assert.throws(() => addLabel(home, { day: '2026-11-16', start: 600, end: 601, label: '' }))
    assert.throws(() => addLabel(home, { day: '16/11/2026', start: 600, end: 601, label: '谁' }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('re-tagging the same stretch replaces instead of stacking', () => {
  const home = tempHome()
  try {
    addLabel(home, { day: '2026-11-16', start: 600, end: 602, label: 'A' })
    addLabel(home, { day: '2026-11-16', start: 600, end: 602, label: 'B' })
    const items = readLabels(home)
    assert.equal(items.length, 1)
    assert.equal(items[0].label, 'B')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('groups by day with newest first', () => {
  const home = tempHome()
  try {
    addLabel(home, { day: '2026-11-15', start: 600, end: 601, label: 'A' })
    addLabel(home, { day: '2026-11-16', start: 500, end: 501, label: 'B' })
    addLabel(home, { day: '2026-11-16', start: 700, end: 701, label: 'C' })
    const groups = groupByDay(readLabels(home))
    assert.deepEqual(groups.map((g) => g.day), ['2026-11-16', '2026-11-15'])
    // 同一天内按打标时间倒序：C 是后打的，排在 B 前面
    assert.deepEqual(groups[0].items.map((i) => i.label), ['C', 'B'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('deletes one label', () => {
  const home = tempHome()
  try {
    const first = addLabel(home, { day: '2026-11-16', start: 600, end: 601, label: 'A' }).item
    addLabel(home, { day: '2026-11-16', start: 700, end: 701, label: 'B' })
    const left = deleteLabel(home, first.id)
    assert.equal(left.length, 1)
    assert.equal(left[0].label, 'B')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('keeps picked line numbers and dedupes them', () => {
  const home = tempHome()
  try {
    addLabel(home, { day: '2026-11-16', start: 600, end: 604, label: '佳奇', lines: [12, 13, 13, 20] })
    const items = readLabels(home)
    assert.deepEqual(items[0].lines, [12, 13, 20])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a label without picks has no lines field', () => {
  const home = tempHome()
  try {
    addLabel(home, { day: '2026-11-16', start: 600, end: 604, label: 'A' })
    assert.equal(readLabels(home)[0].lines, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
