/**
 * Local meeting-minutes store.
 *
 * One day = one JSON document (canonical) plus one Markdown mirror for reading
 * and for the user's own notes. Nothing leaves the machine.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { formatClock } from './lifelog.ts'

export type SessionSource = 'draft' | 'ai' | 'agent' | 'manual'

export interface MinutesSession {
  id: string
  /** Minutes of local day. */
  start: number
  end: number
  topic: string
  summary: string
  points: string[]
  todos: string[]
  /** Titles of background cards used for this entry. */
  backgrounds?: string[]
  source: SessionSource
  updatedAt: string
}

export interface MinutesDoc {
  day: string
  title: string
  note: string
  updatedAt: string
  /** Provider/model that wrote the AI entries, e.g. deepseek-official/deepseek-flash. */
  model?: string
  sessions: MinutesSession[]
}

export interface StoredDoc {
  doc: MinutesDoc
  jsonPath: string
  mdPath: string
}

export interface SelectionState {
  day: string
  start: number
  end: number
  updatedAt: string
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDay(day: string): string {
  if (!DAY_RE.test(day)) throw new Error(`非法日期：${day || '(空)'}`)
  return day
}

export function minutesDir(home: string): string {
  return path.join(home, 'minutes')
}

export function paths(home: string, day: string): { jsonPath: string; mdPath: string } {
  const safe = assertDay(day)
  const dir = minutesDir(home)
  return {
    jsonPath: path.join(dir, `${safe}.json`),
    mdPath: path.join(dir, `${safe}.md`),
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export function emptyDoc(day: string): MinutesDoc {
  return {
    day,
    title: `${day} 会议纪要`,
    note: '由 notta 生活日志的 VAD 分钟密度与 SenseVoice 转写整理；本地保存。',
    updatedAt: '',
    sessions: [],
  }
}

export function readDoc(home: string, day: string): MinutesDoc {
  const { jsonPath } = paths(home, day)
  if (!existsSync(jsonPath)) return emptyDoc(day)
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const sessions = Array.isArray(record.sessions)
    ? record.sessions.map((item) => normalizeSession(item as Record<string, unknown>, day)).filter((item): item is MinutesSession => item !== null)
    : []
  return {
    day,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : `${day} 会议纪要`,
    note: typeof record.note === 'string' ? record.note : emptyDoc(day).note,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    ...(typeof record.model === 'string' && record.model.trim() ? { model: record.model.trim() } : {}),
    sessions: sortSessions(sessions),
  }
}

export function sortSessions(sessions: MinutesSession[]): MinutesSession[] {
  return [...sessions].sort((a, b) => a.start - b.start || a.end - b.end)
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split('\n').map((line) => line.replace(/^[-*•\s]+/, '').trim()).filter(Boolean)
  }
  return []
}

export function normalizeSession(raw: Record<string, unknown>, day: string, fallbackSource: SessionSource = 'manual'): MinutesSession | null {
  const start = Number(raw.start)
  const end = Number(raw.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const startClamped = Math.max(0, Math.min(1439, start))
  const endClamped = Math.max(startClamped + 1 / 60, Math.min(1440, end))
  const topic = String(raw.topic ?? '').trim() || '未命名时段'
  const points = asStringList(raw.points).slice(0, 40)
  const todos = asStringList(raw.todos).slice(0, 20)
  const backgrounds = asStringList(raw.backgrounds).slice(0, 20)
  const summary = String(raw.summary ?? '').trim()
  const sourceRaw = String(raw.source ?? fallbackSource)
  const source: SessionSource = sourceRaw === 'draft' || sourceRaw === 'ai' || sourceRaw === 'agent' || sourceRaw === 'manual' ? sourceRaw : fallbackSource
  const id = String(raw.id ?? '').trim() || `s-${day}-${Math.round(startClamped * 60)}-${Math.round(endClamped * 60)}`
  return {
    id,
    start: startClamped,
    end: endClamped,
    topic,
    summary,
    points,
    todos,
    ...(backgrounds.length ? { backgrounds } : {}),
    source,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  }
}

export function renderMarkdown(doc: MinutesDoc, timeZone: string): string {
  const lines: string[] = []
  lines.push(`# 会议纪要 · ${doc.day}`)
  lines.push('')
  lines.push(`- 更新时间：${formatStamp(doc.updatedAt, timeZone)}`)
  lines.push('- 数据来源：notta 生活日志（VAD 分钟密度 + SenseVoice 转写）')
  if (doc.model) lines.push(`- 生成模型：${doc.model}`)
  if (doc.note) lines.push(`- 说明：${doc.note}`)
  lines.push('')
  if (!doc.sessions.length) {
    lines.push('_还没有内容。在面板里选择时间区间生成草稿，或让 Agent 写入。_')
    lines.push('')
    return lines.join('\n')
  }
  for (const session of doc.sessions) {
    lines.push(`## ${formatClock(session.start)}–${formatClock(session.end)} · ${session.topic}`)
    lines.push('')
    lines.push(`- **时间**：${formatClock(session.start)}–${formatClock(session.end)}`)
    lines.push(`- **主题**：${session.topic}`)
    if (session.summary) lines.push(`- **概述**：${session.summary}`)
    if (session.backgrounds?.length) lines.push(`- **参考背景**：${session.backgrounds.join('、')}`)
    if (session.points.length) {
      lines.push('- **内容**：')
      for (const point of session.points) lines.push(`  - ${point}`)
    }
    if (session.todos.length) {
      lines.push('- **TODO**：')
      for (const todo of session.todos) lines.push(`  - [ ] ${todo}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function formatStamp(iso: string, timeZone: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date).replace(/\//g, '-')
  } catch {
    return iso
  }
}

export function writeDoc(home: string, day: string, doc: MinutesDoc, timeZone: string): StoredDoc {
  const { jsonPath, mdPath } = paths(home, day)
  const updatedAt = new Date().toISOString()
  const normalized: MinutesDoc = {
    day,
    title: doc.title?.trim() || `${day} 会议纪要`,
    note: doc.note?.trim() || emptyDoc(day).note,
    updatedAt,
    ...(doc.model?.trim() ? { model: doc.model.trim() } : {}),
    sessions: sortSessions(doc.sessions).map((session) => ({ ...session, updatedAt: session.updatedAt || updatedAt })),
  }
  writeAtomic(jsonPath, `${JSON.stringify(normalized, null, 2)}\n`)
  writeAtomic(mdPath, `${renderMarkdown(normalized, timeZone)}\n`)
  return { doc: normalized, jsonPath, mdPath }
}

export function statePath(home: string): string {
  return path.join(home, 'state.json')
}

export function readState(home: string): SelectionState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8')) as Record<string, unknown>
    const day = String(parsed.day ?? '')
    const start = Number(parsed.start)
    const end = Number(parsed.end)
    if (!DAY_RE.test(day) || !Number.isFinite(start) || !Number.isFinite(end)) return null
    return {
      day,
      start: Math.max(0, Math.min(1440, start)),
      end: Math.max(0, Math.min(1440, end)),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return null
  }
}

export function writeState(home: string, state: SelectionState): void {
  writeAtomic(statePath(home), `${JSON.stringify(state, null, 2)}\n`)
}

export function removeDoc(home: string, day: string): void {
  const { jsonPath, mdPath } = paths(home, day)
  for (const file of [jsonPath, mdPath]) {
    try {
      unlinkSync(file)
    } catch {
      // Missing files are fine: delete is idempotent.
    }
  }
}

/** Replace every entry overlapping a clock range; used by AI generation. */
export function replaceRangeSessions(doc: MinutesDoc, start: number, end: number, sessions: MinutesSession[]): MinutesDoc {
  const kept = doc.sessions.filter((session) => !(session.end > start && session.start < end))
  return { ...doc, sessions: sortSessions([...kept, ...sessions]) }
}
