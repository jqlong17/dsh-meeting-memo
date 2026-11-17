/**
 * 人工标签回填：用户亲自打标的那几句，立刻把「谁在说」写进分配表。
 *
 * 为什么要有这个：实时识别只对打标之后的片段生效，打标之前的句子仍然没有名字。
 * 但用户是亲手挑的行/填的时间段，这些判定比声纹匹配更可信，应当直接生效。
 * 置信度按 1 记（人工确认），来源记 label，便于和 live / batch 区分。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { asrLogRoot } from './asr-log.ts'
import { readDayMap, writeDay, type Assignment } from './speaker-assignments.ts'
import type { SpeakerLabel } from './speaker-labels.ts'

/** 把 ISO 时间换算成「当天第几分钟」，按配置时区。 */
function minuteOfDay(iso: string, timeZone: string): number | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const hour = pick('hour') % 24
  return hour * 60 + pick('minute') + pick('second') / 60
}

interface SnippetRow {
  line: number
  startAt: string
  track: string
}

function readSnippetRows(home: string, day: string): SnippetRow[] {
  const file = path.join(asrLogRoot(home), day, 'snippets.jsonl')
  if (!existsSync(file)) return []
  const rows: SnippetRow[] = []
  let index = 0
  try {
    for (const text of readFileSync(file, 'utf8').split('\n')) {
      if (!text.trim()) continue
      index += 1
      try {
        const row = JSON.parse(text) as Record<string, unknown>
        rows.push({ line: index, startAt: String(row.startAt ?? ''), track: String(row.track ?? '') })
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    return []
  }
  return rows
}

/**
 * 把一条人工标签回填进分配表，返回回填了几行。
 *
 * 选中行优先（label.lines）；没有行号时按时间区间命中。
 */
export function backfillLabel(home: string, timeZone: string, label: SpeakerLabel): number {
  const rows = readSnippetRows(home, label.day)
  if (!rows.length) return 0
  const picked = new Set(label.lines ?? [])
  const bucket = readDayMap(home, label.day)
  let touched = 0
  for (const row of rows) {
    let hit = false
    if (picked.size) {
      hit = picked.has(row.line)
    } else {
      const minute = minuteOfDay(row.startAt, timeZone)
      hit = minute !== null && minute >= label.start && minute <= label.end
    }
    if (!hit) continue
    const entry: Assignment = {
      speaker: 'label',
      name: label.label,
      track: row.track,
      score: 1,
      source: 'label',
    }
    bucket[String(row.line)] = entry
    touched += 1
  }
  if (touched) writeDay(home, label.day, bucket)
  return touched
}
