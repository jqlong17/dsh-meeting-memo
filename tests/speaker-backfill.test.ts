import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readAssignments } from '../src/speaker-assignments.ts'
import { backfillLabel } from '../src/speaker-backfill.ts'

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-backfill-'))
  const day = '2026-11-17'
  const dir = path.join(home, 'asr-log', day)
  mkdirSync(dir, { recursive: true })
  const rows = [
    { startAt: '2026-11-17T02:00:00Z', endAt: '2026-11-17T02:00:05Z', track: 'mic', text: '第一句' },
    { startAt: '2026-11-17T02:01:00Z', endAt: '2026-11-17T02:01:05Z', track: 'mic', text: '第二句' },
    { startAt: '2026-11-17T02:02:00Z', endAt: '2026-11-17T02:02:05Z', track: 'system', text: '第三句' }
  ]
  writeFileSync(path.join(dir, 'snippets.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  return home
}

test('按行号回填，置信度为 1，来源为 label', () => {
  const home = makeHome()
  try {
    const applied = backfillLabel(home, 'Asia/Shanghai', {
      id: 'spk-1',
      day: '2026-11-17',
      start: 600,
      end: 603,
      label: '龙嘉奇',
      lines: [1, 3],
      createdAt: new Date().toISOString()
    })
    assert.equal(applied, 2)
    const days = readAssignments(home)
    const bucket = days['2026-11-17']
    assert.equal(bucket['1'].name, '龙嘉奇')
    assert.equal(bucket['1'].score, 1)
    assert.equal(bucket['1'].source, 'label')
    assert.equal(bucket['3'].track, 'system')
    assert.equal(bucket['2'], undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有行号时按时间区间回填（按配置时区换算）', () => {
  const home = makeHome()
  try {
    // 上海时间 10:00–10:01 对应 UTC 02:00–02:01
    const applied = backfillLabel(home, 'Asia/Shanghai', {
      id: 'spk-2',
      day: '2026-11-17',
      start: 600,
      end: 601.5,
      label: '高斌',
      createdAt: new Date().toISOString()
    })
    assert.equal(applied, 2)
    const bucket = readAssignments(home)['2026-11-17']
    assert.equal(bucket['1'].name, '高斌')
    assert.equal(bucket['2'].name, '高斌')
    assert.equal(bucket['3'], undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
