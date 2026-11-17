import assert from 'node:assert/strict'
import test from 'node:test'

import { centroidKey, neededScopes, parseRows, rebuildAssignments } from '../src/speaker-rebuild.ts'
import { encodeVector } from '../src/speaker-live.ts'
import type { CentroidSet, Vector } from '../src/speaker-live.ts'

function vec(values: number[]): Vector {
  return Float32Array.from(values)
}

const ALICE = vec([1, 0, 0, 0])
const BOB = vec([0, 1, 0, 0])
const UNKNOWN = vec([0, 0, 1, 0])

function sets(): Map<string, CentroidSet> {
  return new Map<string, CentroidSet>([
    [`mic|builtin`, { centroids: new Map([['苏晴', ALICE], ['陈默', BOB]]), samples: 4 }],
  ])
}

test('解析行号并从 1 开始计数，空行不占号', () => {
  const text = '{"track":"mic","emb":"x"}\n\n{"track":"system"}\n'
  const rows = parseRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].line, 1)
  assert.equal(rows[1].line, 2)
})

test('把声纹归到最像的已登记人，并带上分数', () => {
  const rows = [
    { line: 1, track: 'mic', input: 'builtin', emb: encodeVector(ALICE) },
    { line: 2, track: 'mic', input: 'builtin', emb: encodeVector(BOB) },
  ]
  const result = rebuildAssignments({
    rows,
    centroidSets: sets(),
    decode: (b64) => decodeFor(b64),
  })
  assert.equal(result.total, 2)
  assert.equal(result.matched, 2)
  assert.equal(result.map['1'].name, '苏晴')
  assert.equal(result.map['2'].name, '陈默')
  assert.ok((result.map['1'].score ?? 0) > 0.9)
})

test('陌生人落不进已登记的人（留空而不是乱标）', () => {
  const rows = [{ line: 1, track: 'mic', input: 'builtin', emb: encodeVector(UNKNOWN) }]
  const result = rebuildAssignments({ rows, centroidSets: sets(), decode: (b64) => decodeFor(b64) })
  assert.equal(result.total, 1)
  assert.equal(result.matched, 0)
  assert.deepEqual(result.names, {})
})

test('没有声纹的行不参与统计', () => {
  const rows = [{ line: 1, track: 'mic', input: 'builtin' }]
  const result = rebuildAssignments({ rows, centroidSets: sets(), decode: (b64) => decodeFor(b64) })
  assert.equal(result.total, 0)
})

test('设备不同的麦克风各用各的质心（键必须一致）', () => {
  assert.equal(centroidKey('mic', 'builtin'), 'mic|builtin')
  assert.equal(centroidKey('system', undefined), 'system|')
  const scopes = neededScopes([
    { line: 1, track: 'mic', input: 'builtin', emb: 'a' },
    { line: 2, track: 'mic', input: 'earpods', emb: 'b' },
    { line: 3, track: 'system', emb: 'c' },
  ])
  assert.equal(scopes.length, 3)
})

function decodeFor(base64: string): Vector | null {
  // 测试里用 encodeVector 生成的 base64，直接交给真实的解码器
  // （动态 import 会破坏同步性，所以这里内联最小实现）
  const buffer = Buffer.from(base64, 'base64')
  const out = new Float32Array(buffer.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    const bits = buffer.readUInt16LE(i * 2)
    const sign = bits & 0x8000 ? -1 : 1
    const exponent = (bits >> 10) & 0x1F
    const fraction = bits & 0x3FF
    out[i] = exponent === 0 ? sign * fraction * 2 ** -24 : sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
  }
  return out
}
