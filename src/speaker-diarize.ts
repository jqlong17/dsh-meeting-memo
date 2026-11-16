/**
 * 说话人分离：把一天的转写片段按音色聚类，再用人工标签给簇起名字。
 *
 * 做法尽量少依赖：把当天的 wav 按时间顺序拼成一个长文件（我们自己的 wav 都是
 * 16k 单声道 16bit，直接拼 data 块就行），交给 sherpa-onnx 的离线分离，
 * 再把每个原始片段按「重叠最多」映射到分离结果的 speaker id。
 *
 * 标签只用来命名，不参与聚类——这样标签少的时候也能跑。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Segment } from './lifelog.ts'
import type { SpeakerLabel } from './speaker-labels.ts'

export interface DiarizePiece {
  /** 原始片段在当天的时间（分钟）。 */
  start: number
  end: number
  audio: string
  line?: number
  lines?: number[]
}

export interface DiarizeSegment {
  start: number
  end: number
  speaker: string
}

export interface DiarizeResult {
  track: string
  pieces: number
  speakers: string[]
  segments: DiarizeSegment[]
  /** 行号 → speaker id。 */
  byLine: Map<number, string>
}

/** 读 wav 的 data 块；只支持 16bit PCM。 */
function wavData(file: string): Buffer | null {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return null
  }
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') return buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    offset += 8 + size + (size % 2)
  }
  return null
}

function wavHeader(dataLength: number, sampleRate = 16_000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bits / 8, 28)
  header.writeUInt16LE(channels * bits / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataLength, 40)
  return header
}

/** 把多个 wav 拼成一个；返回每段在拼接文件里的时间偏移（分钟）。 */
export function concatWavs(pieces: Array<{ audio: string; start: number; end: number }>, outFile: string): Array<{ start: number; end: number }> | null {
  const chunks: Buffer[] = []
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  const bytesPerMinute = 16_000 * 2 * 60
  for (const piece of pieces) {
    const data = wavData(piece.audio)
    if (!data || !data.length) continue
    const minutes = data.length / bytesPerMinute
    spans.push({ start: cursor, end: cursor + minutes })
    chunks.push(data)
    cursor += minutes
  }
  if (!chunks.length) return null
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  writeFileSync(outFile, Buffer.concat([wavHeader(total), ...chunks]))
  return spans
}

function parseDiarization(stdout: string): DiarizeSegment[] {
  const segments: DiarizeSegment[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*([\d.]+)\s*--\s*([\d.]+)\s+(speaker_\d+)\s*$/.exec(line)
    if (!match) continue
    segments.push({ start: Number(match[1]) / 60, end: Number(match[2]) / 60, speaker: match[3] })
  }
  return segments
}

export async function diarizeTrack(input: {
  runtimeHome: string
  modelsDir: string
  track: string
  pieces: DiarizePiece[]
  workDir: string
  threshold: number
  /** 知道人数时直接给定簇数，比阈值更稳。 */
  numClusters?: number
  timeZone: string
}): Promise<DiarizeResult | null> {
  const runtime = path.join(input.runtimeHome, 'runtimes', 'sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts')
  const binary = path.join(runtime, 'bin', 'sherpa-onnx-offline-speaker-diarization')
  const segModel = path.join(input.modelsDir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
  const embModel = path.join(input.modelsDir, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx')
  if (!existsSync(binary) || !existsSync(segModel) || !existsSync(embModel)) return null
  if (!input.pieces.length) return null

  mkdirSync(input.workDir, { recursive: true })
  const wav = path.join(input.workDir, `${input.track}.wav`)
  const spans = concatWavs(input.pieces, wav)
  if (!spans) return null

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const clusterArgs = input.numClusters && input.numClusters > 0
        ? [`--clustering.num-clusters=${input.numClusters}`]
        : [`--clustering.cluster-threshold=${input.threshold}`]
      const child = spawn(binary, [
        ...clusterArgs,
        `--segmentation.pyannote-model=${segModel}`,
        `--embedding.model=${embModel}`,
        wav,
      ], {
        env: { ...process.env, DYLD_LIBRARY_PATH: path.join(runtime, 'lib') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { out += chunk })
      child.stderr?.on('data', (chunk: string) => { err += chunk })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve(out)
        else reject(new Error(err.trim().slice(-200) || `分离失败 ${code}`))
      })
    })

    const segments = parseDiarization(stdout)
    if (!segments.length) return null

    const byLine = new Map<number, string>()
    // 拼接文件里的时间 → 原始片段的行号；按最大重叠归一票
    input.pieces.forEach((piece, index) => {
      const span = spans[index]
      if (!span) return
      const votes = new Map<string, number>()
      for (const segment of segments) {
        const overlap = Math.min(span.end, segment.end) - Math.max(span.start, segment.start)
        if (overlap <= 0) continue
        votes.set(segment.speaker, (votes.get(segment.speaker) ?? 0) + overlap)
      }
      let best = ''
      let bestWeight = 0
      for (const [speaker, weight] of votes) {
        if (weight > bestWeight) {
          best = speaker
          bestWeight = weight
        }
      }
      if (!best) return
      for (const line of piece.lines ?? (piece.line ? [piece.line] : [])) byLine.set(line, best)
    })

    const speakers = [...new Set(segments.map((segment) => segment.speaker))].sort()
    return { track: input.track, pieces: input.pieces.length, speakers, segments, byLine }
  } finally {
    rmSync(wav, { force: true })
  }
}

/**
 * 用人工标签给 speaker id 起名字。
 *
 * 两种标签都算票：勾选行的按行投票；只按时间段打标的，用该时间段里
 * 出现的 speaker 各得一票（区间内的片段数加权），免得漏掉一部分样本。
 */
export function nameSpeakers(results: DiarizeResult[], labels: SpeakerLabel[]): Map<string, string> {
  const votes = new Map<string, Map<string, number>>()
  const vote = (key: string, label: string, weight = 1): void => {
    const bucket = votes.get(key) ?? new Map<string, number>()
    bucket.set(label, (bucket.get(label) ?? 0) + weight)
    votes.set(key, bucket)
  }
  for (const result of results) {
    for (const label of labels) {
      const picked = label.lines ?? []
      if (picked.length) {
        for (const line of picked) {
          const speaker = result.byLine.get(line)
          if (speaker) vote(`${result.track}:${speaker}`, label.label)
        }
        continue
      }
      // 没勾选行：按该时间段里每个 speaker 的累计时长投票
      const overlap = new Map<string, number>()
      for (const segment of result.segments) {
        const shared = Math.min(segment.end, label.end) - Math.max(segment.start, label.start)
        if (shared <= 0) continue
        overlap.set(segment.speaker, (overlap.get(segment.speaker) ?? 0) + shared)
      }
      for (const [speaker, seconds] of overlap) {
        vote(`${result.track}:${speaker}`, label.label, seconds)
      }
    }
  }
  const named = new Map<string, string>()
  for (const [key, bucket] of votes) {
    let best = ''
    let bestVotes = 0
    for (const [label, count] of bucket) {
      if (count > bestVotes) {
        best = label
        bestVotes = count
      }
    }
    if (best) named.set(key, best)
  }
  return named
}

/** 从片段列表里挑出带音频的，按时间排序。 */
export function audioPieces(segments: Segment[], track: string): DiarizePiece[] {
  return segments
    .filter((segment) => segment.track === track && segment.audio)
    .map((segment) => ({
      start: segment.s,
      end: segment.e,
      audio: segment.audio as string,
      ...(typeof segment.line === 'number' ? { line: segment.line } : {}),
      ...(segment.lines?.length ? { lines: segment.lines } : {}),
    }))
}
