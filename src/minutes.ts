/**
 * Local meeting-minutes store.
 *
 * One day = one JSON document (canonical) plus one Markdown mirror for reading
 * and for the user's own notes. Nothing leaves the machine.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { formatClock } from './lifelog.ts'

export type SessionSource = 'draft' | 'ai' | 'agent' | 'manual'

export interface MinutesSession {
  id: string
  /** Minutes of local day. */
  start: number
  end: number
  topic: string
  /** 这场会议的全部内容，就是一段 Markdown（背景与目标 / 核心结论 / TODO / 相关链接与资源）。 */
  content: string
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
    // 一天的纪要在同一个 md 文件里，按场次分节。
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
    return value.split('\n')
      .map((line) => (line.trim().startsWith('**') ? line.trim() : line.replace(/^[-*•]\s*/, '').trim()))
      .filter(Boolean)
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
  const content = String(raw.content ?? '').trim()
  const sourceRaw = String(raw.source ?? fallbackSource)
  const source: SessionSource = sourceRaw === 'draft' || sourceRaw === 'ai' || sourceRaw === 'agent' || sourceRaw === 'manual' ? sourceRaw : fallbackSource
  const id = String(raw.id ?? '').trim() || `s-${day}-${Math.round(startClamped * 60)}-${Math.round(endClamped * 60)}`
  return {
    id,
    start: startClamped,
    end: endClamped,
    topic,
    content,
    source,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  }
}

/** 链接渲染成 Markdown；本地绝对路径用等宽文本，方便直接复制。 */
function formatLink(raw: string): string {
  const text = raw.trim()
  const match = text.match(/https?:\/\/\S+/)
  if (match) {
    const url = match[0].replace(/[，。；、,.)）\]]+$/, '')
    const label = text.replace(match[0], '').replace(/\s*[-—:：|·]\s*$/, '').trim() || url
    return `[${label}](${url})`
  }
  const local = text.match(/(\/Users\/[^\s]+|~\/[^\s]+)/)
  if (local) {
    const path = local[0].replace(/[，。；、,.)）\]]+$/, '')
    const rest = text.replace(local[0], '').replace(/\s*[-—:：|·]\s*$/, '').trim()
    return rest ? `${rest}：\`${path}\`` : `\`${path}\``
  }
  return text
}

export function renderSession(session: MinutesSession, day: string, timeZone: string, model?: string): string {
  const lines: string[] = []
  lines.push(`# ${formatClock(session.start)}–${formatClock(session.end)} · ${session.topic}`)
  lines.push('')
  lines.push(`- 日期：${day}`)
  lines.push(`- 更新时间：${formatStamp(session.updatedAt, timeZone)}`)
  if (model) lines.push(`- 生成模型：${model}`)
  lines.push('')
  appendSessionLines(lines, session, { heading: false, meta: false })
  return lines.join('\n')
}

function appendSessionLines(
  lines: string[],
  session: MinutesSession,
  options: { heading?: boolean; meta?: boolean } = {},
): void {
  const { heading = true, meta = true } = options
  if (heading) {
    lines.push(`## ${formatClock(session.start)}–${formatClock(session.end)} · ${session.topic}`)
    lines.push('')
  }
  if (meta) {
    lines.push(`- **时间**：${formatClock(session.start)}–${formatClock(session.end)}`)
    lines.push(`- **主题**：${session.topic}`)
    lines.push('')
  }
  const body = session.content.trim()
  if (body) {
    for (const line of body.split('\n')) lines.push(line)
    lines.push('')
  }
}


/** 从一段正文里拆出旧客户端仍在读的字段（过渡期兼容，新客户端只用 content）。 */
export function deriveLegacy(content: string): {
  summary: string
  decisions: string[]
  todos: string[]
  relatedDocs: string[]
} {
  const lines = content.split('\n')
  let section = ''
  const decisions: string[] = []
  const todos: string[] = []
  const relatedDocs: string[] = []
  const quote: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('> ')) {
      const text = line.slice(2).trim()
      if (text && !text.startsWith('💡') && !text.startsWith('来源：') && !text.startsWith('参考背景：')) quote.push(text)
      continue
    }
    if (line.startsWith('### ')) {
      section = line.slice(4).trim()
      continue
    }
    if (!line.startsWith('- ')) continue
    const body = line.slice(2).trim()
    if (section.includes('核心结论')) decisions.push(body)
    else if (section.toUpperCase().includes('TODO')) todos.push(body.replace(/^\[( |x|X)\]\s*/, ''))
    else if (section.includes('相关链接')) relatedDocs.push(body)
  }
  return { summary: quote.join(' ').trim(), decisions, todos, relatedDocs }
}

export function renderMarkdown(doc: MinutesDoc, timeZone: string): string {
  const lines: string[] = []
  lines.push(`# 会议纪要 · ${doc.day}`)
  lines.push('')
  lines.push(`- 更新时间：${formatStamp(doc.updatedAt, timeZone)}`)
  if (doc.model) lines.push(`- 生成模型：${doc.model}`)
  if (doc.note) lines.push(`- 说明：${doc.note}`)
  lines.push('')
  if (!doc.sessions.length) {
    lines.push('_还没有内容。在面板里选择时间区间生成草稿，或让 Agent 写入。_')
    lines.push('')
    return lines.join('\n')
  }
  for (const session of doc.sessions) {
    appendSessionLines(lines, session)
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
  // 迁移：早期按场次拆分的目录不再维护，整目录清掉。
  try {
    rmSync(path.join(minutesDir(home), day), { recursive: true, force: true })
  } catch {
    // 不存在即忽略。
  }
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
  try {
    unlinkSync(jsonPath)
  } catch {
    // Missing files are fine: delete is idempotent.
  }
  try {
    rmSync(mdPath, { recursive: true, force: true })
  } catch {
    // Missing directories are fine too.
  }
}

/** Replace every entry overlapping a clock range; used by AI generation. */
export function replaceRangeSessions(doc: MinutesDoc, start: number, end: number, sessions: MinutesSession[]): MinutesDoc {
  const kept = doc.sessions.filter((session) => !(session.end > start && session.start < end))
  return { ...doc, sessions: sortSessions([...kept, ...sessions]) }
}
