/**
 * Build the clipboard "source index" for one selected range: the absolute
 * snippets.jsonl path plus the exact line numbers, so another agent/model can
 * open the raw SenseVoice rows without a second transcription.
 *
 * Pure and browser-safe: the panel imports this value, so no node built-ins.
 */

export interface IndexSegment {
  s: number
  e: number
  line?: number
}

export interface BuildIndexCopyInput {
  day: string
  file: string
  segments: IndexSegment[]
  selection: { start: number; end: number }
  trackLabel: string
  filtered: boolean
}

export function clockOf(minute: number): string {
  const total = Math.max(0, Math.round(minute * 60))
  const hh = Math.floor(total / 3600) % 24
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

/** Compress sorted/un-sorted line numbers into `1-3, 5, 7-8`. */
export function compressLineRanges(lines: number[]): string {
  const unique = [...new Set(lines.filter((line) => Number.isFinite(line) && line > 0))].sort((a, b) => a - b)
  if (!unique.length) return ''
  const parts: string[] = []
  let start = unique[0]
  let previous = unique[0]
  const flush = (): void => {
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
  }
  for (let index = 1; index < unique.length; index += 1) {
    const line = unique[index]
    if (line === previous + 1) {
      previous = line
      continue
    }
    flush()
    start = line
    previous = line
  }
  flush()
  return parts.join(', ')
}

export function buildIndexCopy(input: BuildIndexCopyInput): string {
  const { segments } = input
  const lines = compressLineRanges(segments.map((segment) => segment.line ?? 0))
  const startMinute = segments.length ? Math.min(...segments.map((segment) => segment.s)) : null
  const endMinute = segments.length ? Math.max(...segments.map((segment) => segment.e)) : null
  const dataRange = startMinute !== null && endMinute !== null
    ? `${input.day} ${clockOf(startMinute)} – ${clockOf(endMinute)}`
    : '—'
  const selection = `${input.day} ${clockOf(input.selection.start)} – ${clockOf(input.selection.end)}`
  const track = input.filtered ? `${input.trackLabel}（行号只含该轨道）` : input.trackLabel
  return [
    'notta 生活日志切片',
    `文件: ${input.file}`,
    `行号: ${lines || '—'}`,
    `选区: ${selection}`,
    `数据: ${dataRange}`,
    `轨道: ${track}`,
    `片段: ${segments.length}`,
    '说明: 行号为 1-based、含端点；打开上述文件读取这些行即可得到 SenseVoice 原始转写。',
  ].join('\n')
}
