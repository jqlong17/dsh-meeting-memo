/**
 * Plugin-owned life log. Same day-folder contract as notta-input
 * (`activity.jsonl` + `snippets.jsonl`) so the Today view can point here.
 */
import { countSnippetLines, appendEmb } from './emb-store.ts'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type AsrMode = 'raw' | 'tracks' | 'merged'

export function asrLogRoot(home: string): string {
  return path.join(home, 'asr-log')
}

export function dayKey(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function dayDir(root: string, day: string): string {
  const dir = path.join(root, day)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface AsrSnippetInput {
  day: string
  startAt: string
  endAt: string
  track: string
  text: string
  audio?: string
  /** float16 + base64 的声纹向量，用于实时说话人匹配。 */
  emb?: string
  /** 这句是不是「按声纹切开」切出来的前半截。 */
  split?: boolean
  /** 麦克风设备名：声纹跨设备会明显掉分，所以按设备分开登记。 */
  input?: string
  /** 写入当时判定的说话人（快照；权威值仍在 speaker-assignments.json）。 */
  speaker?: string
  /** 判定相似度 0-1，大模型据此判断「有多确信」。 */
  speakerScore?: number
}


/** 当天正文行数缓存：新写入的声纹要按行号对齐，不能每句都数一遍文件。 */
const lineCounts = new Map<string, number>()

function nextLineNumber(file: string): number {
  const cached = lineCounts.get(file)
  if (typeof cached === 'number') {
    lineCounts.set(file, cached + 1)
    return cached + 1
  }
  const count = countSnippetLines(file)
  lineCounts.set(file, count + 1)
  return count + 1
}

/** 供重算等场景重置计数（外部改写过文件时）。 */
export function resetLineCount(file: string): void {
  lineCounts.delete(file)
}


/**
 * 改某一行的正文，其它行原样保留。
 *
 * 行号是说话人归属、打标、声纹的对齐键，所以这里**只替换第 n 行的 text 字段**，
 * 行数不变、顺序不变、其余字段全部保留。整文件先写临时文件再 rename，避免写坏。
 */
export function updateSnippetText(root: string, day: string, line: number, text: string): boolean {
  const file = path.join(dayDir(root, day), 'snippets.jsonl')
  if (!existsSync(file)) return false
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  // 末尾空行不占行号：按非空行计数
  let index = 0
  let target = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue
    index += 1
    if (index === line) { target = i; break }
  }
  if (target < 0) return false
  let row: Record<string, unknown>
  try {
    row = JSON.parse(lines[target]) as Record<string, unknown>
  } catch {
    return false
  }
  row.text = text
  lines[target] = JSON.stringify(row)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, lines.join('\n'), 'utf8')
  renameSync(tmp, file)
  return true
}

export function appendSnippet(root: string, input: AsrSnippetInput): number {
  const dir = dayDir(root, input.day)
  const row = {
    id: `asr-${input.track}-${Date.parse(input.startAt) || Date.now()}`,
    day: input.day,
    startAt: input.startAt,
    endAt: input.endAt,
    track: input.track,
    text: input.text,
    source: 'asr',
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.split ? { split: true } : {}),
    ...(input.input ? { input: input.input } : {}),
    ...(input.speaker ? { speaker: input.speaker } : {}),
    ...(typeof input.speakerScore === 'number' ? { speakerScore: input.speakerScore } : {}),
  }
  const file = path.join(dir, 'snippets.jsonl')
  // 声纹单独存：正文保持可读，行号与这里对齐
  const line = nextLineNumber(file)
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
  if (input.emb) appendEmb(dir, line, input.emb)
  // 返回真实行号：调用方别自己数，跨天/重启/重写之后计数必然漂
  return line
}

export interface AsrActivityInput {
  day: string
  startAt: string
  micSpeechSeconds?: number
  systemSpeechSeconds?: number
  micChars?: number
  systemChars?: number
  snippetCount?: number
  /** 这一分钟收到多少个麦克风缓冲 / 峰值：用来判断「面板可用但实际没声音」 */
  micBuffers?: number
  micPeak?: number
  systemBuffers?: number
  systemPeak?: number
}

export function appendActivity(root: string, input: AsrActivityInput): void {
  const dir = dayDir(root, input.day)
  const row = {
    startAt: input.startAt,
    micSpeechSeconds: input.micSpeechSeconds ?? 0,
    systemSpeechSeconds: input.systemSpeechSeconds ?? 0,
    meetingSpeechSeconds: 0,
    micChars: input.micChars ?? 0,
    systemChars: input.systemChars ?? 0,
    meetingChars: 0,
    snippetCount: input.snippetCount ?? 0,
    ...(typeof input.micBuffers === 'number' ? { micBuffers: input.micBuffers } : {}),
    ...(typeof input.micPeak === 'number' ? { micPeak: input.micPeak } : {}),
    ...(typeof input.systemBuffers === 'number' ? { systemBuffers: input.systemBuffers } : {}),
    ...(typeof input.systemPeak === 'number' ? { systemPeak: input.systemPeak } : {}),
    source: 'asr',
  }
  appendFileSync(path.join(dir, 'activity.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
}

export function audioDir(root: string, day: string, track: string): string {
  const dir = path.join(dayDir(root, day), 'audio', track)
  mkdirSync(dir, { recursive: true })
  return dir
}
