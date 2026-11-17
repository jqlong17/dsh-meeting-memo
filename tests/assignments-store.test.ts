/**
 * 按天存储：读一天只碰一个文件；旧大文件仍能读；拆完幂等。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { listDays, readDayAssignments, readDayMap, setAssignment, splitLegacy, writeDay } from '../src/speaker-assignments.ts'

const entry = (name: string) => ({ speaker: 'live', name, track: 'mic', score: 0.8, source: 'live' as const })

test('按天写入与读取', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-asm-'))
  try {
    writeDay(home, '2026-11-17', { '1': entry('苏晴') })
    writeDay(home, '2026-11-16', { '9': entry('陈默') })
    assert.equal(readDayMap(home, '2026-11-17')['1'].name, '苏晴')
    assert.equal(readDayMap(home, '2026-11-16')['9'].name, '陈默')
    assert.deepEqual(listDays(home), ['2026-11-16', '2026-11-17'])
    // 没写过的一天返回 null，和「空表」区分开
    assert.equal(readDayAssignments(home, '2026-11-10'), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('setAssignment 只改当天', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-asm-'))
  try {
    writeDay(home, '2026-11-17', { '1': entry('苏晴') })
    setAssignment(home, '2026-11-17', 2, entry('周叙'))
    const map = readDayMap(home, '2026-11-17')
    assert.equal(Object.keys(map).length, 2)
    assert.equal(map['2'].name, '周叙')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('读旧大文件：兼容，且拆完之后仍可读', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-asm-'))
  try {
    writeFileSync(path.join(home, 'speaker-assignments.json'), JSON.stringify({
      version: 1,
      days: { '2026-11-16': { '163': { speaker: 'speaker_01', track: 'system', source: 'batch' } } },
    }))
    assert.equal(readDayMap(home, '2026-11-16')['163'].speaker, 'speaker_01')

    const result = splitLegacy(home)
    assert.equal(result.days, 1)
    assert.equal(result.entries, 1)
    assert.ok(result.backup && existsSync(result.backup), '旧文件要留底')
    assert.equal(readDayMap(home, '2026-11-16')['163'].speaker, 'speaker_01')

    // 幂等：再拆一次什么也不做
    assert.equal(splitLegacy(home).days, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('已有按天文件时，旧大文件不覆盖它', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-asm-'))
  try {
    writeDay(home, '2026-11-17', { '1': entry('新的') })
    writeFileSync(path.join(home, 'speaker-assignments.json'), JSON.stringify({
      version: 1,
      days: { '2026-11-17': { '1': entry('旧的') } },
    }))
    splitLegacy(home)
    assert.equal(readDayMap(home, '2026-11-17')['1'].name, '新的')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
