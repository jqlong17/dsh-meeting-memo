/**
 * Background cards: user-authored context (project, people, glossary) that can
 * be attached to an AI minutes generation.
 *
 * Stored as one small JSON file under the plugin home. The last selection of
 * card ids is kept separately so the Today tab can restore it across reloads.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface BackgroundCard {
  id: string
  title: string
  tags: string[]
  content: string
  createdAt: string
  updatedAt: string
}

interface BackgroundFile {
  version: number
  items: BackgroundCard[]
}

const FILE = 'backgrounds.json'
const SELECTION_FILE = 'background-selection.json'
const MAX_TITLE = 120
const MAX_CONTENT = 20_000
const MAX_TAGS = 12

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((item) => String(item ?? '')) : String(value ?? '').split(/[,，、/;；\n]+/)
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of raw) {
    const tag = item.trim().replace(/^#/, '').slice(0, 32)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function normalizeCard(raw: unknown, existing?: BackgroundCard): BackgroundCard | null {
  const record = asRecord(raw)
  const title = String(record.title ?? '').trim().slice(0, MAX_TITLE)
  const content = String(record.content ?? '').trim().slice(0, MAX_CONTENT)
  if (!title || !content) return null
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? `bg-${randomUUID()}`,
    title,
    tags: normalizeTags(record.tags),
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export function backgroundsFile(home: string): string {
  return path.join(home, FILE)
}

export function readBackgrounds(home: string): BackgroundCard[] {
  const file = backgroundsFile(home)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const items = Array.isArray(parsed) ? parsed : asRecord(parsed).items
    if (!Array.isArray(items)) return []
    return items
      .map((item) => {
        const record = asRecord(item)
        const title = String(record.title ?? '').trim()
        const content = String(record.content ?? '').trim()
        if (!title || !content) return null
        return {
          id: String(record.id ?? '') || `bg-${randomUUID()}`,
          title,
          tags: normalizeTags(record.tags),
          content,
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
        } satisfies BackgroundCard
      })
      .filter((item): item is BackgroundCard => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    throw new Error('背景卡片文件无法解析，请检查 backgrounds.json')
  }
}

function writeBackgrounds(home: string, items: BackgroundCard[]): void {
  const payload: BackgroundFile = { version: 1, items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  writeAtomic(backgroundsFile(home), `${JSON.stringify(payload, null, 2)}\n`)
}

export function upsertBackground(home: string, raw: unknown): { item: BackgroundCard; items: BackgroundCard[] } {
  const record = asRecord(raw)
  const id = String(record.id ?? '').trim()
  const items = readBackgrounds(home)
  const existing = id ? items.find((item) => item.id === id) : undefined
  const card = normalizeCard(record, existing)
  if (!card) throw new Error('背景标题和内容都不能为空')
  const next = existing
    ? items.map((item) => (item.id === card.id ? card : item))
    : [card, ...items]
  writeBackgrounds(home, next)
  return { item: card, items: readBackgrounds(home) }
}

export function deleteBackground(home: string, id: string): { items: BackgroundCard[]; selection: string[] } {
  const items = readBackgrounds(home).filter((item) => item.id !== id)
  writeBackgrounds(home, items)
  const selection = readBackgroundSelection(home).filter((selected) => items.some((item) => item.id === selected))
  writeBackgroundSelection(home, selection)
  return { items, selection }
}

export function readBackgroundSelection(home: string): string[] {
  const file = path.join(home, SELECTION_FILE)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const record = asRecord(parsed)
    const ids = Array.isArray(record.ids) ? record.ids : Array.isArray(parsed) ? parsed : []
    return [...new Set(ids.map((id) => String(id ?? '')).filter(Boolean))]
  } catch {
    return []
  }
}

export function writeBackgroundSelection(home: string, ids: string[]): string[] {
  const clean = [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
  writeAtomic(path.join(home, SELECTION_FILE), `${JSON.stringify({ ids: clean }, null, 2)}\n`)
  return clean
}
