/**
 * 离线导入的存储：一个任务一个目录，与按天存放的实时数据完全隔离。
 *
 *   imports/<id>/
 *     meta.json        文件名、大小、哈希、时长、状态
 *     snippets.jsonl   转写片段（相对文件的秒数，单轨）
 *     minutes.json     生成的纪要（结构化）
 *     minutes.md       生成的纪要（给人看）
 *
 * 目录里**不放音频**：转写直接读用户选中的原文件，完成后不再需要它。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'

export interface ImportMeta {
  version: 1
  id: string
  name: string
  size: number
  hash: string
  durationSec: number
  createdAt: string
  /** 真正开始转写的时间（排队结束时）。 */
  startedAt?: string
  /** 转写结束时间（成功、失败或取消都记）。 */
  finishedAt?: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  /** 转写进度（秒），跑完后等于 durationSec。 */
  processedSec: number
  snippets: number
  model?: string
  error?: string
  /** 纪要生成时间，没有就是还没生成。 */
  minutesAt?: string
}

export interface ImportSnippet {
  startSec: number
  endSec: number
  text: string
}

export function importsRoot(home: string): string {
  return path.join(home, 'imports')
}

export function importDir(home: string, id: string): string {
  return path.join(importsRoot(home), id)
}

function metaFile(home: string, id: string): string {
  return path.join(importDir(home, id), 'meta.json')
}

function snippetsFile(home: string, id: string): string {
  return path.join(importDir(home, id), 'snippets.jsonl')
}

/** 任务 id：时间前缀便于排序，后缀是内容哈希，便于认人。 */
export function makeImportId(hash: string, now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${stamp}-${hash.slice(0, 8)}`
}

/** 文件指纹：大小 + 前 8MB 的 sha256。够用来拦重复导入，又不至于把大文件读完。 */
export function fingerprint(file: string): { hash: string; size: number } {
  const stat = statSync(file)
  const handle = readFileSync(file, { flag: 'r' })
  const head = handle.subarray(0, Math.min(handle.length, 8 * 1024 * 1024))
  const digest = createHash('sha256').update(String(stat.size)).update(head).digest('hex')
  return { hash: digest, size: stat.size }
}

export function listImports(home: string): ImportMeta[] {
  const root = importsRoot(home)
  if (!existsSync(root)) return []
  const items: ImportMeta[] = []
  for (const name of readdirSync(root)) {
    // .trash 之类的内部目录不算任务
    if (name.startsWith('.')) continue
    const meta = readMeta(home, name)
    if (meta) items.push(meta)
  }
  // 新的在前；id 的时间前缀本身可排序
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readMeta(home: string, id: string): ImportMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(metaFile(home, id), 'utf8')) as ImportMeta
    return parsed && parsed.id ? parsed : null
  } catch {
    return null
  }
}

export function writeMeta(home: string, meta: ImportMeta): void {
  mkdirSync(importDir(home, meta.id), { recursive: true })
  const file = metaFile(home, meta.id)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function patchMeta(home: string, id: string, patch: Partial<ImportMeta>): ImportMeta | null {
  const current = readMeta(home, id)
  if (!current) return null
  const next = { ...current, ...patch }
  writeMeta(home, next)
  return next
}

/** 同名同内容的任务已存在就返回它，用于拦重复导入。 */
export function findByHash(home: string, hash: string): ImportMeta | null {
  return listImports(home).find((item) => item.hash === hash) ?? null
}

export function appendSnippet(home: string, id: string, snippet: ImportSnippet): void {
  mkdirSync(importDir(home, id), { recursive: true })
  appendFileSync(
    snippetsFile(home, id),
    `${JSON.stringify({
      startSec: Math.round(snippet.startSec * 1000) / 1000,
      endSec: Math.round(snippet.endSec * 1000) / 1000,
      text: snippet.text,
    })}\n`,
    'utf8',
  )
}

export function readSnippets(home: string, id: string): ImportSnippet[] {
  const file = snippetsFile(home, id)
  if (!existsSync(file)) return []
  const rows: ImportSnippet[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    try {
      const row = JSON.parse(raw) as ImportSnippet
      if (typeof row.startSec === 'number' && typeof row.text === 'string' && row.text) rows.push(row)
    } catch {
      // 坏行跳过
    }
  }
  return rows
}

/** 把片段按「1 分钟一桶」压缩成时间轴用的密度数据。 */
export function bucketsOf(snippets: ImportSnippet[]): Array<{ m: number; s: number }> {
  const map = new Map<number, number>()
  for (const snippet of snippets) {
    const minute = Math.floor(snippet.startSec / 60)
    const seconds = Math.max(0.2, snippet.endSec - snippet.startSec)
    map.set(minute, (map.get(minute) ?? 0) + seconds)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([m, s]) => ({ m, s: Math.round(s * 10) / 10 }))
}

export function writeMinutes(home: string, id: string, markdown: string, json: unknown): void {
  const dir = importDir(home, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'minutes.md'), markdown, 'utf8')
  writeFileSync(path.join(dir, 'minutes.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

export interface ImportSession {
  /** 相对文件的起点/终点（分钟，为兼容纪要结构）。 */
  start: number
  end: number
  topic: string
}

export function readMinutes(home: string, id: string): { markdown: string | null; sessions: ImportSession[] } {
  let markdown: string | null = null
  try {
    markdown = readFileSync(path.join(importDir(home, id), 'minutes.md'), 'utf8')
  } catch {
    markdown = null
  }
  let sessions: ImportSession[] = []
  try {
    const parsed = JSON.parse(readFileSync(path.join(importDir(home, id), 'minutes.json'), 'utf8')) as { sessions?: unknown }
    if (Array.isArray(parsed.sessions)) {
      sessions = parsed.sessions.flatMap((item) => {
        const record = item as { start?: number; end?: number; topic?: string }
        if (typeof record.start !== 'number' || typeof record.end !== 'number') return []
        return [{ start: record.start, end: record.end, topic: String(record.topic ?? '') }]
      })
    }
  } catch {
    sessions = []
  }
  return { markdown, sessions }
}

/** 回收站目录：删除的任务先移到这里，7 天后自动清掉。 */
export function trashRoot(home: string): string {
  return path.join(importsRoot(home), '.trash')
}

/**
 * 删除任务 = 挪进回收站，不是真删。
 * 目录名带上时间戳，避免「删掉 → 重新导入同名文件」时撞车。
 */
export function trashImport(home: string, id: string, now = new Date()): string | null {
  const dir = importDir(home, id)
  if (!existsSync(dir)) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const target = path.join(trashRoot(home), `${stamp}-${id}`)
  mkdirSync(trashRoot(home), { recursive: true })
  renameSync(dir, target)
  return target
}

/** 清空回收站里超过保留期的条目，返回删掉几个。 */
export function purgeTrash(home: string, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const root = trashRoot(home)
  if (!existsSync(root)) return 0
  let removed = 0
  for (const name of readdirSync(root)) {
    const full = path.join(root, name)
    try {
      if (Date.now() - statSync(full).mtimeMs < olderThanMs) continue
      rmSync(full, { recursive: true, force: true })
      removed += 1
    } catch {
      // 删不掉就留着
    }
  }
  return removed
}

/** 回收站里有哪些（面板暂时不展示，留给维护脚本）。 */
export function listTrash(home: string): string[] {
  const root = trashRoot(home)
  if (!existsSync(root)) return []
  return readdirSync(root).sort()
}

export function deleteImport(home: string, id: string): boolean {
  const dir = importDir(home, id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 秒 → `m:ss` / `h:mm:ss`。 */
export function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
