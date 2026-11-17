/**
 * 回归：声纹搬到 emb.jsonl 之后，质心构建必须还能读到声纹。
 * 出过的事故：正文里没有 emb 了，质心全空，实时说话人识别全部变成「—」。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCentroids, encodeVector } from '../src/speaker-live.ts'
import type { SpeakerLabel } from '../src/speaker-labels.ts'

const DAY = '2026-11-17'

function makeHome(withSidecar: boolean): { home: string; root: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-centroid-'))
  const root = path.join(home, 'asr-log')
  const dir = path.join(root, DAY)
  mkdirSync(dir, { recursive: true })
  const emb = encodeVector(Float32Array.from([1, 0, 0, 0]))
  const rows = [1, 2].map((line) => ({
    id: `row-${line}`,
    day: DAY,
    startAt: `${DAY}T01:0${line}:00.000Z`,
    endAt: `${DAY}T01:0${line}:05.000Z`,
    track: 'mic',
    input: 'dev-a',
    text: `第${line}句`,
    source: 'asr',
    // 新格式：正文里没有 emb
  }))
  writeFileSync(path.join(dir, 'snippets.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  if (withSidecar) {
    writeFileSync(path.join(dir, 'emb.jsonl'), [1, 2].map((line) => JSON.stringify({ line, emb })).join('\n') + '\n')
  }
  return { home, root }
}

const labels: SpeakerLabel[] = [{
  id: 'spk-1',
  day: DAY,
  start: 60,
  end: 62,
  label: '苏晴',
  lines: [1, 2],
  createdAt: `${DAY}T02:00:00.000Z`,
}]

test('声纹在旁挂文件里也能算出质心', () => {
  const { home, root } = makeHome(true)
  try {
    const set = buildCentroids(root, labels, home, 'dev-a', 'mic')
    assert.equal(set.centroids.size, 1, '应该算出 1 个人')
    assert.equal(set.samples, 2)
    assert.ok(set.centroids.has('苏晴'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('两边都没有声纹时质心为空（而不是报错）', () => {
  const { home, root } = makeHome(false)
  try {
    const set = buildCentroids(root, labels, home, 'dev-a', 'mic')
    assert.equal(set.centroids.size, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
