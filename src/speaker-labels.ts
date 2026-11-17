/**
 * 说话人标签：用户手动把某一段时间标成「谁在说」。
 *
 * 这些数据是以后做说话人识别的训练素材——时间区间 + 人工标签，
 * 音频本身由转写落在 `asr-log/<day>/audio/<track>/<ms>.wav`，不需要再复制一份。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface SpeakerLabel {
  id: string
  /** yyyy-MM-dd */
  day: string
  /** 当天的分钟数，带小数，和其它记录保持一致。 */
  start: number
  end: number
  label: string
  note?: string
  /** 勾选的具体转写行（snippets.jsonl 行号）；按行打标时才有。 */
  lines?: number[]
  createdAt: string
}

interface Store {
  version: 1
  items: SpeakerLabel[]
}

const FILE = 'speaker-labels.json'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function fileOf(home: string): string {
  return path.join(home, FILE)
}

function normalize(raw: unknown): SpeakerLabel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const day = String(record.day ?? '').trim()
  const start = Number(record.start)
  const end = Number(record.end)
  const label = String(record.label ?? '').trim()
  if (!DAY_RE.test(day) || !Number.isFinite(start) || !Number.isFinite(end) || !label) return null
  const s = Math.max(0, Math.min(1439, start))
  const e = Math.max(s + 1 / 60, Math.min(1440, end))
  const note = String(record.note ?? '').trim()
  const lines = Array.isArray(record.lines)
    ? [...new Set(record.lines.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b)
    : []
  return {
    id: String(record.id ?? '').trim() || `spk-${randomUUID()}`,
    day,
    start: Math.round(s * 100) / 100,
    end: Math.round(e * 100) / 100,
    label: label.slice(0, 40),
    ...(note ? { note: note.slice(0, 200) } : {}),
    ...(lines.length ? { lines } : {}),
    createdAt: typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : new Date().toISOString(),
  }
}

export function readLabels(home: string): SpeakerLabel[] {
  const file = fileOf(home)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { items?: unknown }
    const items = Array.isArray(parsed.items) ? parsed.items : []
    return items.map(normalize).filter((item): item is SpeakerLabel => item !== null)
      .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)
  } catch {
    return []
  }
}

function writeAll(home: string, items: SpeakerLabel[]): void {
  mkdirSync(home, { recursive: true })
  const store: Store = { version: 1, items }
  const tmp = `${fileOf(home)}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(tmp, fileOf(home))
}

export function addLabel(home: string, raw: unknown): { item: SpeakerLabel; items: SpeakerLabel[] } {
  const item = normalize(raw)
  if (!item) throw new Error('标签需要日期、开始、结束和一个名字')
  const items = readLabels(home)
  // 同一段重复打标时替换，避免堆一堆重叠条目
  const kept = items.filter((existing) => !(existing.day === item.day
    && Math.abs(existing.start - item.start) < 0.02
    && Math.abs(existing.end - item.end) < 0.02))
  const next = [...kept, item].sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)
  writeAll(home, next)
  return { item, items: next }
}

export function deleteLabel(home: string, id: string): SpeakerLabel[] {
  const next = readLabels(home).filter((item) => item.id !== id)
  writeAll(home, next)
  return next
}

/** 日期归档：按天分组，新的在前。 */

/**
 * 从一条标注里摘掉某一句。
 * 句子删空就把整条标注删掉；返回剩下的标注（或 null 表示已删除）。
 */
export function removeLabelLine(home: string, labelId: string, line: number): SpeakerLabel | null {
  const items = readLabels(home)
  const index = items.findIndex((item) => item.id === labelId)
  if (index < 0) return null
  const item = items[index]
  const rest = (item.lines ?? []).filter((value) => value !== line)
  if (!rest.length) {
    items.splice(index, 1)
    writeAll(home, items)
    return null
  }
  const next: SpeakerLabel = { ...item, lines: rest }
  items[index] = next
  writeAll(home, items)
  return next
}

export function groupByDay(items: SpeakerLabel[]): Array<{ day: string; items: SpeakerLabel[] }> {
  const map = new Map<string, SpeakerLabel[]>()
  for (const item of items) {
    const list = map.get(item.day) ?? []
    list.push(item)
    map.set(item.day, list)
  }
  // 日期新的在上；同一天里按「打标时间」倒序——刚打的在最前，打错了立刻能删
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({
      day,
      items: list.sort((a, b) => {
        const byCreated = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        // 老数据没有 createdAt 时退回按时间点倒序
        return byCreated !== 0 ? byCreated : b.start - a.start
      }),
    }))
}
