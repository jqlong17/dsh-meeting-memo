/**
 * 回归：当天有归属表时以表为准。
 * 重算把某行判成「不认识」后，正文里的旧快照不能再被回退显示出来。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MeetingService } from '../src/service.ts'

const DAY = '2026-11-17'

function makeService(assignments: unknown | null): { service: MeetingService; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-auth-'))
  if (assignments !== null) {
    writeFileSync(path.join(home, 'speaker-assignments.json'), JSON.stringify(assignments))
  }
  const config = {
    lifelogRoot: null,
    home,
    timeZone: 'Asia/Shanghai',
    autoUpdate: false,
    windowStart: 0,
    windowEnd: 1440,
    provider: null,
    model: null,
  }
  return { service: new MeetingService(config as never, home), home }
}

test('表里有这一行：用表里的名字，覆盖正文快照', () => {
  const { service, home } = makeService({
    version: 1,
    days: { [DAY]: { '7': { speaker: 'rebuild', name: '苏晴', score: 0.81, track: 'mic', source: 'live' } } },
  })
  try {
    const name = service.speakerOf(DAY, { line: 7, speaker: '陈默', speakerScore: 0.9 })
    assert.equal(name, '苏晴(0.81)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('表里没有这一行：判定为不认识，不回退正文快照', () => {
  const { service, home } = makeService({
    version: 1,
    // 当天表存在但没有第 8 行 —— 重算把它清掉了
    days: { [DAY]: { '7': { speaker: 'rebuild', name: '苏晴', score: 0.8, track: 'mic', source: 'live' } } },
  })
  try {
    const name = service.speakerOf(DAY, { line: 8, speaker: '陈默', speakerScore: 0.9 })
    assert.equal(name, undefined, '旧快照不该被回退')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('当天完全没有归属表：才回退到正文快照（兼容旧数据）', () => {
  const { service, home } = makeService({ version: 1, days: {} })
  try {
    const name = service.speakerOf(DAY, { line: 9, speaker: '林知远', speakerScore: 0.77 })
    assert.equal(name, '林知远(0.77)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('invalidateSpeakerCache 之后能读到新的表', () => {
  const { service, home } = makeService({ version: 1, days: { [DAY]: {} } })
  try {
    assert.equal(service.speakerOf(DAY, { line: 3, speaker: '苏晴' }), undefined)
    writeFileSync(path.join(home, 'speaker-assignments.json'), JSON.stringify({
      version: 1,
      days: { [DAY]: { '3': { speaker: 'rebuild', name: '周叙', score: 0.7, track: 'mic', source: 'live' } } },
    }))
    assert.equal(service.speakerOf(DAY, { line: 3, speaker: '苏晴' }), undefined, '缓存还在时读到旧结果')
    service.invalidateSpeakerCache()
    assert.equal(service.speakerOf(DAY, { line: 3, speaker: '苏晴' }), '周叙(0.70)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
