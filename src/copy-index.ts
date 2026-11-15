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
  lines?: number[]
}

export interface IndexBackground {
  title: string
  tags?: string[]
  content: string
}

export interface BuildIndexCopyInput {
  day: string
  file: string
  /** Current source name, so a switched log is not labeled as notta. */
  sourceLabel?: string
  segments: IndexSegment[]
  selection: { start: number; end: number }
  trackLabel: string
  filtered: boolean
  /** Background cards the user ticked for this meeting. */
  backgrounds?: IndexBackground[]
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
  const lines = compressLineRanges(segments.flatMap((segment) => segment.lines?.length ? segment.lines : [segment.line ?? 0]))
  const startMinute = segments.length ? Math.min(...segments.map((segment) => segment.s)) : null
  const endMinute = segments.length ? Math.max(...segments.map((segment) => segment.e)) : null
  const dataRange = startMinute !== null && endMinute !== null
    ? `${input.day} ${clockOf(startMinute)} – ${clockOf(endMinute)}`
    : '—'
  const selection = `${input.day} ${clockOf(input.selection.start)} – ${clockOf(input.selection.end)}`
  const track = input.filtered ? `${input.trackLabel}（行号只含该轨道）` : input.trackLabel
  const title = input.sourceLabel ? `${input.sourceLabel}切片` : '当前日志切片'
  const backgrounds = (input.backgrounds ?? []).filter((card) => card.title.trim() || card.content.trim())
  const backgroundBlock = backgrounds.length
    ? [
      '背景资料（用户勾选的长期背景，用来理解人名、项目和术语；不是这场会说的话，不要当成会议结论）：',
      ...backgrounds.map((card) => {
        const tags = card.tags?.filter(Boolean).join('、')
        const head = tags ? `### ${card.title}（标签：${tags}）` : `### ${card.title}`
        return `${head}\n${card.content.trim()}`
      }),
    ]
    : ['背景资料: 无']
  return [
    title,
    '这是一份本地语音转写的索引，不是转写正文。请只读下面指定的行，不要猜文件里的其他内容。',
    `文件: ${input.file}`,
    '格式: JSONL，一行一个 JSON 对象。行号从 1 开始，含两端。',
    `要读的行: ${lines || '—'}`,
    '每行字段: text 是转写正文；startAt / endAt 是 UTC 时间；track 是音轨（mic 麦克风，system 系统声音，merged 合并）；id 是这条的编号。',
    `用户选区: ${selection}（上海时间，只是当时框选的范围）`,
    `这些行实际覆盖: ${dataRange}（上海时间）`,
    `轨道筛选: ${track}`,
    `片段数: ${segments.length}`,
    '注意: 转写可能有错字、断句和口头语。时间以 startAt / endAt 为准，不要用文件修改时间。',
    ...backgroundBlock,
  ].join('\n')
}
