/**
 * Read-only adapter for notta-input's LifeLog day folder.
 *
 * Data contract (see notta-input `src/LifeLog/LifeLogTypes.swift`):
 * - `activity.jsonl`: one row per minute while capturing. `micSpeechSeconds`,
 *   `systemSpeechSeconds`, `meetingSpeechSeconds` are VAD-gated speech seconds,
 *   so `speechSeconds / 60` is the minute's speech density (0…1).
 * - `snippets.jsonl`: SenseVoice segments with `startAt`/`endAt` (UTC) and text.
 *
 * The plugin never writes into the log root.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface Segment {
  /** Start, minutes of local day (fractional). */
  s: number
  /** End, minutes of local day (fractional). */
  e: number
  track: string
  text: string
  source?: string
  /** 1-based physical line number in snippets.jsonl. */
  line?: number
}

export interface Bucket {
  /** Minute of local day. */
  m: number
  /** VAD-gated speech seconds in this minute. */
  s: number
  /** Characters from ASR in this minute. */
  c: number
  /** ASR segments starting in this minute. */
  n: number
}

export interface DayData {
  root: string
  day: string
  dayDir: string
  hasActivity: boolean
  hasSnippets: boolean
  buckets: Bucket[]
  segments: Segment[]
  warnings: string[]
}

export interface DayStats {
  segments: number
  chars: number
  speechMinutes: number
  captureMinutes: number
  firstMinute: number | null
  lastMinute: number | null
  tracks: Record<string, number>
}

export interface HourRow {
  hour: number
  capturedMinutes: number
  speechMinutes: number
  chars: number
  segments: number
}

export const TRACK_LABELS: Record<string, string> = {
  mic: '麦克风',
  system: '系统声音',
  meeting: '会议',
}

export function trackLabel(track: string | undefined): string {
  return TRACK_LABELS[String(track || 'mic')] ?? '麦克风'
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

/** Turn an ISO instant into its local calendar day and minute-of-day. */
export function localClock(iso: unknown, timeZone: string): { day: string; minute: number } | null {
  if (typeof iso !== 'string' || !iso) return null
  const date = new Date(iso)
  const time = date.getTime()
  if (!Number.isFinite(time)) return null
  const parts = clockFormatter(timeZone).formatToParts(date)
  const pick = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  const day = `${String(pick('year')).padStart(4, '0')}-${String(pick('month')).padStart(2, '0')}-${String(pick('day')).padStart(2, '0')}`
  const minute = pick('hour') * 60 + pick('minute') + pick('second') / 60
  return { day, minute }
}

export function todayKey(timeZone: string, now: Date = new Date()): string {
  return localClock(now.toISOString(), timeZone)?.day ?? ''
}

export function nowMinuteOfDay(timeZone: string, now: Date = new Date()): number {
  return localClock(now.toISOString(), timeZone)?.minute ?? 0
}

export function formatClock(minute: number, withSeconds = false): string {
  const total = Math.max(0, Math.round(minute * 60))
  const hh = Math.floor(total / 3600) % 24
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const base = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  return withSeconds ? `${base}:${String(ss).padStart(2, '0')}` : base
}

/** Accepts `HH:mm`, `HH:mm:ss` or minutes-of-day. Returns minutes (float). */
export function parseClock(value: unknown, fallback: number | null = null): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1440, value))
  if (typeof value === 'string') {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
    if (match) {
      const minutes = Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(match[3]) / 60 : 0)
      if (Number.isFinite(minutes)) return Math.max(0, Math.min(1440, minutes))
    }
  }
  if (fallback !== null) return fallback
  throw new Error(`无法解析时间：${String(value)}（用 HH:mm）`)
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function readDay(root: string, day: string, timeZone: string): DayData {
  const dayDir = path.join(root, day)
  const activityFile = path.join(dayDir, 'activity.jsonl')
  const snippetsFile = path.join(dayDir, 'snippets.jsonl')
  const warnings: string[] = []

  const buckets = new Map<number, Bucket>()
  let activityRows = 0
  let activityBad = 0
  for (const line of readLines(activityFile)) {
    const text = line.trim()
    if (!text) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(text) as Record<string, unknown>
    } catch {
      activityBad += 1
      continue
    }
    const clock = localClock(row.startAt, timeZone)
    if (!clock || clock.day !== day) continue
    const minute = Math.floor(clock.minute)
    const speech = Number(row.micSpeechSeconds || 0) + Number(row.systemSpeechSeconds || 0) + Number(row.meetingSpeechSeconds || 0)
    const chars = Number(row.micChars || 0) + Number(row.systemChars || 0) + Number(row.meetingChars || 0)
    const snippets = Number(row.snippetCount || 0)
    const existing = buckets.get(minute)
    if (existing) {
      existing.s += Number.isFinite(speech) ? speech : 0
      existing.c += Number.isFinite(chars) ? chars : 0
      existing.n += Number.isFinite(snippets) ? snippets : 0
    } else {
      buckets.set(minute, {
        m: minute,
        s: Number.isFinite(speech) ? speech : 0,
        c: Number.isFinite(chars) ? chars : 0,
        n: Number.isFinite(snippets) ? snippets : 0,
      })
    }
    activityRows += 1
  }
  if (activityBad > 0) warnings.push(`activity.jsonl 有 ${activityBad} 行无法解析，已跳过`)

  const segments: Segment[] = []
  let snippetBad = 0
  const snippetLines = readLines(snippetsFile)
  for (let lineIndex = 0; lineIndex < snippetLines.length; lineIndex += 1) {
    const line = snippetLines[lineIndex]
    const text = line.trim()
    if (!text) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(text) as Record<string, unknown>
    } catch {
      snippetBad += 1
      continue
    }
    const content = typeof row.text === 'string' ? row.text.trim() : ''
    if (!content) continue
    const start = localClock(row.startAt, timeZone)
    if (!start || start.day !== day) continue
    const endClock = localClock(row.endAt, timeZone)
    const endMinute = endClock && endClock.day === day ? endClock.minute : start.minute
    const s = clip(start.minute, 0, 1440)
    const e = clip(Math.max(endMinute, s + 0.01), s, 1440)
    const track = typeof row.track === 'string' && row.track ? row.track : 'mic'
    segments.push({
      s,
      e,
      track,
      text: content,
      line: lineIndex + 1,
      ...(typeof row.source === 'string' && row.source ? { source: row.source } : {}),
    })
    const minute = Math.floor(s)
    const bucket = buckets.get(minute)
    if (bucket) {
      bucket.c += content.length
      bucket.n += 1
    } else {
      buckets.set(minute, { m: minute, s: 0, c: content.length, n: 1 })
    }
  }
  if (snippetBad > 0) warnings.push(`snippets.jsonl 有 ${snippetBad} 行无法解析，已跳过`)
  segments.sort((a, b) => a.s - b.s || a.e - b.e)

  // Without activity rows (old days, backfilled logs) fall back to ASR durations.
  if (activityRows === 0) {
    for (const segment of segments) {
      for (let minute = Math.floor(segment.s); minute <= Math.floor(segment.e - 1e-9); minute += 1) {
        if (minute < 0 || minute >= 1440) continue
        const overlap = Math.max(0, Math.min(segment.e, minute + 1) - Math.max(segment.s, minute))
        if (overlap <= 0) continue
        const bucket = buckets.get(minute)
        if (bucket) bucket.s += overlap * 60
      }
    }
  }

  return {
    root,
    day,
    dayDir,
    hasActivity: activityRows > 0,
    hasSnippets: segments.length > 0,
    buckets: [...buckets.values()].sort((a, b) => a.m - b.m),
    segments,
    warnings,
  }
}

export function dayStats(data: DayData): DayStats {
  let chars = 0
  let speech = 0
  const tracks: Record<string, number> = {}
  let first: number | null = null
  let last: number | null = null
  for (const bucket of data.buckets) {
    speech += Math.max(0, bucket.s)
  }
  for (const segment of data.segments) {
    chars += segment.text.length
    tracks[segment.track] = (tracks[segment.track] ?? 0) + 1
    first = first === null ? segment.s : Math.min(first, segment.s)
    last = last === null ? segment.e : Math.max(last, segment.e)
  }
  return {
    segments: data.segments.length,
    chars,
    speechMinutes: Math.round((speech / 60) * 10) / 10,
    captureMinutes: data.buckets.length,
    firstMinute: first,
    lastMinute: last,
    tracks,
  }
}

export function hourlySummary(data: DayData, from = 6, to = 24): HourRow[] {
  const rows: HourRow[] = Array.from({ length: Math.max(0, to - from) }, (_, index) => ({
    hour: from + index,
    capturedMinutes: 0,
    speechMinutes: 0,
    chars: 0,
    segments: 0,
  }))
  for (const bucket of data.buckets) {
    const index = Math.floor(bucket.m / 60) - from
    if (index < 0 || index >= rows.length) continue
    rows[index].capturedMinutes += 1
    rows[index].speechMinutes += Math.max(0, bucket.s) / 60
    rows[index].chars += bucket.c
  }
  for (const row of rows) {
    row.speechMinutes = Math.round(row.speechMinutes * 10) / 10
  }
  for (const segment of data.segments) {
    const index = Math.floor(segment.s / 60) - from
    if (index < 0 || index >= rows.length) continue
    rows[index].segments += 1
  }
  return rows
}

export interface RangeResult {
  day: string
  start: number
  end: number
  segments: Segment[]
  buckets: Bucket[]
  chars: number
  speechSeconds: number
  truncated: boolean
  text: string
}

/** Slice one day to a clock range; used by tools and the panel's "copy" action. */
export function sliceRange(
  data: DayData,
  start: number,
  end: number,
  options: { maxChars?: number; maxSegments?: number; withText?: boolean } = {},
): RangeResult {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.min(1440, Math.max(start, end))
  const maxChars = Math.max(500, options.maxChars ?? 24_000)
  const maxSegments = Math.max(1, options.maxSegments ?? 4_000)
  const segments = data.segments.filter((segment) => segment.e > from && segment.s < to)
  const buckets = data.buckets.filter((bucket) => bucket.m >= Math.floor(from) && bucket.m < Math.ceil(to))
  const chars = segments.reduce((sum, segment) => sum + segment.text.length, 0)
  const speechSeconds = buckets.reduce((sum, bucket) => sum + Math.max(0, bucket.s), 0)
  const clipped = segments.slice(0, maxSegments)
  const lines: string[] = []
  let budget = maxChars
  let truncated = clipped.length < segments.length
  if (options.withText !== false) {
    for (const segment of clipped) {
      const line = `[${formatClock(segment.s, true)}] ${trackLabel(segment.track)}：${segment.text}`
      if (line.length > budget) {
        truncated = true
        break
      }
      lines.push(line)
      budget -= line.length + 1
    }
  }
  return {
    day: data.day,
    start: from,
    end: to,
    segments: clipped,
    buckets,
    chars,
    speechSeconds,
    truncated,
    text: lines.join('\n'),
  }
}
