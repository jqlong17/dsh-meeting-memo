/**
 * Plugin-owned life log. Same day-folder contract as notta-input
 * (`activity.jsonl` + `snippets.jsonl`) so the Today view can point here.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
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
  /** 麦克风设备名：声纹跨设备会明显掉分，所以按设备分开登记。 */
  input?: string
  /** 写入当时判定的说话人（快照；权威值仍在 speaker-assignments.json）。 */
  speaker?: string
  /** 判定相似度 0-1，大模型据此判断「有多确信」。 */
  speakerScore?: number
}

export function appendSnippet(root: string, input: AsrSnippetInput): void {
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
    ...(input.emb ? { emb: input.emb } : {}),
    ...(input.input ? { input: input.input } : {}),
    ...(input.speaker ? { speaker: input.speaker } : {}),
    ...(typeof input.speakerScore === 'number' ? { speakerScore: input.speakerScore } : {}),
  }
  appendFileSync(path.join(dir, 'snippets.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
}

export interface AsrActivityInput {
  day: string
  startAt: string
  micSpeechSeconds?: number
  systemSpeechSeconds?: number
  micChars?: number
  systemChars?: number
  snippetCount?: number
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
    source: 'asr',
  }
  appendFileSync(path.join(dir, 'activity.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
}

export function audioDir(root: string, day: string, track: string): string {
  const dir = path.join(dayDir(root, day), 'audio', track)
  mkdirSync(dir, { recursive: true })
  return dir
}
