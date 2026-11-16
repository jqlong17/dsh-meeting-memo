/**
 * 实时说话人识别：转写片段一落库就跟已登记的人比对，命中的写进分配表。
 *
 * 采集进程在片段关闭时算好 192 维声纹（float16 + base64）随事件发来，
 * 这里只做「质心匹配」——不碰音频，也不再需要原音文件。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { SpeakerLabel } from './speaker-labels.ts'

/**
 * 判定「是他」需要两个条件同时成立：
 *   1. 最高分够高（THRESHOLD）
 *   2. 和第二名拉开差距（MARGIN）
 * 只看绝对分数时，同一个人不同句子的分数会在 0.6 附近漂，容易漏；
 * 而「像自己 0.66、像别人 0.09」这种悬殊差距才是更稳的信号。
 */
export const MATCH_THRESHOLD = 0.55
export const MATCH_MARGIN = 0.15

export type Vector = Float32Array

/** float16 位模式还原成 float32。 */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1F
  const fraction = bits & 0x3FF
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

/** 解析 helper 发来的 base64(float16 小端) 向量。 */
export function decodeEmbedding(base64: string): Vector | null {
  if (!base64) return null
  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null
  const count = buffer.length / 2
  const vector = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    vector[i] = halfToFloat(buffer.readUInt16LE(i * 2))
  }
  return vector.length ? vector : null
}

export function cosine(a: Vector, b: Vector): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

export function centroid(vectors: Vector[]): Vector | null {
  if (!vectors.length) return null
  const size = vectors[0].length
  const sum = new Float32Array(size)
  for (const vector of vectors) {
    for (let i = 0; i < size; i += 1) sum[i] += vector[i]
  }
  for (let i = 0; i < size; i += 1) sum[i] /= vectors.length
  return sum
}


/**
 * 老片段（加声纹之前录的）只有 wav 没有向量。这里用 bin/embed 批量补算，
 * 结果存进 cache 文件，之后就不再需要音频了。
 */
export function backfillEmbeddings(
  home: string,
  needs: Array<{ key: string; audio: string }>,
): Record<string, string> {
  const cacheFile = path.join(home, 'emb-cache.json')
  let cache: Record<string, string> = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>
  } catch {
    cache = {}
  }
  const missing = needs.filter((item) => !cache[item.key] && existsSync(item.audio))
  if (!missing.length) return cache

  const tool = path.join(home, 'bin', 'embed')
  if (!existsSync(tool)) return cache
  const model = resolveEmbedModelFile()
  if (!model) return cache

  // 一次进程算一批，避免每个片段起一次
  const result = spawnSync(tool, [model, ...missing.map((item) => item.audio)], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout) return cache
  const byPath = new Map<string, string>()
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { path?: string; vector?: number[] }
      if (!parsed.path || !parsed.vector?.length) continue
      byPath.set(parsed.path, encodeVector(Float32Array.from(parsed.vector)))
    } catch {
      // 单行坏了跳过
    }
  }
  for (const item of missing) {
    const encoded = byPath.get(item.audio)
    if (encoded) cache[item.key] = encoded
  }
  try {
    writeFileSync(cacheFile, `${JSON.stringify(cache)}\n`, 'utf8')
  } catch {
    // 写不进去也不影响本次
  }
  return cache
}

/** float32 → float16 base64，和 helper 的口径保持一致。 */
export function encodeVector(vector: Vector): string {
  const buffer = Buffer.alloc(vector.length * 2)
  for (let i = 0; i < vector.length; i += 1) {
    buffer.writeUInt16LE(floatToHalf(vector[i]), i * 2)
  }
  return buffer.toString('base64')
}

function floatToHalf(value: number): number {
  const float = new Float32Array(1)
  float[0] = value
  const bits = new Uint32Array(float.buffer)[0]
  const sign = (bits >> 16) & 0x8000
  const exponent = ((bits >> 23) & 0xFF) - 127 + 15
  if (exponent <= 0) return sign
  if (exponent >= 31) return sign | 0x7C00
  return sign | (exponent << 10) | ((bits >> 13) & 0x3FF)
}

function resolveEmbedModelFile(): string {
  const fromEnv = (process.env.SPEAKER_EMBED_MODEL || '').trim()
  if (fromEnv) return fromEnv
  const fallback = path.join(
    process.env.HOME || '',
    '.dsh', 'voice-split', 'models', '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  )
  return existsSync(fallback) ? fallback : ''
}

export interface CentroidSet {
  centroids: Map<string, Vector>
  /** 建质心用到的样本数，0 表示还没有可用的登记。 */
  samples: number
}

/**
 * 从当天片段里取声纹，按人工标签求每人质心。
 * 标签里的行号对应 snippets.jsonl 的行号，所以历史片段也能直接参与，不需要音频。
 */
export function buildCentroids(
  root: string,
  day: string,
  labels: SpeakerLabel[],
  home?: string,
  /** 只统计这个设备录的样本：换麦克风后声纹会明显掉分，混在一起就会谁都认不出。 */
  device?: string,
  /** 只看这条轨道的样本：麦克风是近讲、系统声音是回环，混在一起质心会飘。 */
  track?: string,
): CentroidSet {
  const centroids = new Map<string, Vector>()
  let samples = 0
  const file = path.join(root, day, 'snippets.jsonl')
  if (!existsSync(file)) return { centroids, samples }

  const byLine = new Map<number, Vector>()
  const audioByLine = new Map<number, string>()
  const trackByLine = new Map<number, string>()
  let index = 0
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    index += 1
    let row: { emb?: unknown; audio?: unknown; input?: unknown; track?: unknown }
    try {
      row = JSON.parse(raw) as { emb?: unknown; audio?: unknown; input?: unknown; track?: unknown }
    } catch {
      continue
    }
    if (typeof row.track === 'string') trackByLine.set(index, row.track)
    if (track && row.track !== track) {
      if (typeof row.audio === 'string') audioByLine.set(index, row.audio)
      continue
    }
    if (device && (typeof row.input !== 'string' || row.input !== device)) {
      // 设备不匹配的样本不参与质心
      if (typeof row.audio === 'string') audioByLine.set(index, row.audio)
      continue
    }
    if (typeof row.audio === 'string') audioByLine.set(index, row.audio)
    if (typeof row.emb !== 'string') continue
    const vector = decodeEmbedding(row.emb)
    if (vector) byLine.set(index, vector)
  }

  // 老片段没向量：用 wav 补算（只在标签覆盖到它们时）
  if (home) {
    const needs: Array<{ key: string; audio: string }> = []
    for (const label of labels) {
      for (const line of label.lines ?? []) {
        if (byLine.has(line)) continue
        if (track && trackByLine.get(line) !== track) continue
        const audio = audioByLine.get(line)
        if (audio) needs.push({ key: `${day}:${line}`, audio })
      }
    }
    if (needs.length) {
      const cache = backfillEmbeddings(home, needs)
      for (const need of needs) {
        const encoded = cache[need.key]
        if (!encoded) continue
        const vector = decodeEmbedding(encoded)
        if (vector) byLine.set(Number(need.key.split(':')[1]), vector)
      }
    }
  }

  const grouped = new Map<string, Vector[]>()
  for (const label of labels) {
    for (const line of label.lines ?? []) {
      const vector = byLine.get(line)
      if (!vector) continue
      const list = grouped.get(label.label) ?? []
      list.push(vector)
      grouped.set(label.label, list)
      samples += 1
    }
  }
  for (const [name, vectors] of grouped) {
    const center = centroid(vectors)
    if (center) centroids.set(name, center)
  }
  return { centroids, samples }
}

export interface Match {
  name: string
  score: number
}

export function matchSpeaker(
  vector: Vector,
  set: CentroidSet,
  threshold = MATCH_THRESHOLD,
  margin = MATCH_MARGIN,
): Match | null {
  let best: Match | null = null
  let second = 0
  for (const [name, center] of set.centroids) {
    const score = cosine(vector, center)
    if (!best || score > best.score) {
      if (best) second = best.score
      best = { name, score }
    } else if (score > second) {
      second = score
    }
  }
  if (!best || best.score < threshold) return null
  if (best.score - second < margin) return null
  return best
}
