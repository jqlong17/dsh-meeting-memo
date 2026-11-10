/**
 * Model-facing pieces of AI meeting-minutes generation: prompt, transcript
 * clipping, and strict parsing of the model's JSON reply.
 *
 * The parser is intentionally conservative: one meeting covers the whole
 * selection unless the model (and a switch-marker check) proves otherwise.
 */
import { formatClock, parseClock } from './lifelog.ts'

export interface PromptRange {
  start: number
  end: number
}

export interface BackgroundInput {
  title: string
  tags?: string[]
  content: string
}

export interface BuildPromptInput {
  day: string
  range: PromptRange
  transcript: string
  truncated: boolean
  /** User-selected background cards; optional. */
  backgrounds?: BackgroundInput[]
}

export interface ParsedMeeting {
  start: number
  end: number
  topic: string
  summary: string
  points: string[]
  todos: string[]
}

export class AiOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiOutputError'
  }
}

export const SYSTEM_PROMPT = `你是会议纪要助手。用户会给你一段本地 ASR 转写（可能有错别字、口语、重复和填充词）。
把整段转写整理成按时间线的会议纪要。

规则：
1. 默认整段是同一场会议：只输出 1 条 meeting，start/end 用给定区间。不要因为有停顿、切换话题词或换发言人而拆分。
2. 只有转写里出现明确的换场/换会标志（例如「下一个议题」「今天先到这」「我们先开另一个会」「散会」）时，才拆成多条。
3. 只依据转写，不编造人名、结论、数字；听不清或信息不足就写得概括，不要补细节。
4. 忽略「嗯、啊、喂、对」等无信息内容，合并重复表达。
5. 每条 meeting：topic 不超过 16 字；summary 1–2 句；points 3–8 条，每条一句短语；todos 只写明确要做的事，没有就给空数组。
6. 如果提供了「背景资料」，用它消除人名、项目名、术语的歧义，让要点落在背景的项目语境里；不要照抄背景，也不要把背景里没发生的事写成会议结论。
7. 严格输出 JSON，不要 Markdown 代码块，不要解释：
{"meetings":[{"start":"HH:mm","end":"HH:mm","topic":"…","summary":"…","points":["…"],"todos":["…"]}]}`

/** Render selected cards for the prompt, bounded so backgrounds cannot crowd out the transcript. */
export function renderBackgrounds(cards: BackgroundInput[] | undefined, maxPerCard = 1_600, maxTotal = 6_000): string {
  if (!cards?.length) return ''
  const parts: string[] = []
  let total = 0
  for (const card of cards) {
    const content = card.content.trim()
    if (!content) continue
    const clipped = content.length > maxPerCard ? `${content.slice(0, maxPerCard - 1)}…` : content
    const tags = card.tags?.length ? `（标签：${card.tags.join('、')}）` : ''
    const block = `### ${card.title}${tags}\n${clipped}`
    if (total + block.length > maxTotal) break
    parts.push(block)
    total += block.length
  }
  if (!parts.length) return ''
  return `背景资料（用户勾选；帮助理解人名、术语、项目语境，不要照抄）：\n${parts.join('\n\n')}`
}

export function buildPrompt(input: BuildPromptInput): { system: string; user: string } {
  const range = `${formatClock(input.range.start)}–${formatClock(input.range.end)}`
  const minutes = Math.max(1, Math.round(input.range.end - input.range.start))
  const background = renderBackgrounds(input.backgrounds)
  const user = [
    `日期：${input.day}`,
    `区间：${range}（共 ${minutes} 分钟）`,
    input.truncated ? '注意：转写较长，中间部分已省略；请只依据可见内容整理。' : '',
    background,
    '',
    '转写（[时间] 轨道：文本）：',
    input.transcript,
  ].filter(Boolean).join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/** Keep both ends of a long transcript; the tail usually holds decisions and todos. */
export function clipText(text: string, max = 30_000): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.68)
  const tail = max - head
  return {
    text: `${text.slice(0, head)}\n\n…（中间省略）…\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  }
}

const SWITCH_RE = /(下一个议题|下一个会|下个会|下一场|今天先到这|先到这|我们就到这里|换个会|另一个会|开另一个|散会|休息一下|进入下一个|先开个会)/

/** Whether the transcript itself contains an explicit session switch. */
export function hasSwitchMarker(transcript: string): boolean {
  return SWITCH_RE.test(transcript)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of value) {
    const text = asText(item).replace(/^[-*•\s]+/, '')
    if (!text || seen.has(text)) continue
    seen.add(text)
    list.push(text.length > 160 ? `${text.slice(0, 159)}…` : text)
    if (list.length >= limit) break
  }
  return list
}

function clampToRange(value: number, range: PromptRange): number {
  return Math.max(range.start, Math.min(range.end, value))
}

function parseMeeting(raw: unknown, range: PromptRange): ParsedMeeting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  let start: number
  let end: number
  try {
    start = typeof record.start === 'string'
      ? parseClock(record.start)
      : Number.isFinite(Number(record.start)) ? Number(record.start) : range.start
    end = typeof record.end === 'string'
      ? parseClock(record.end)
      : Number.isFinite(Number(record.end)) ? Number(record.end) : range.end
  } catch {
    start = range.start
    end = range.end
  }
  start = clampToRange(start, range)
  end = clampToRange(end, range)
  if (end <= start) {
    end = Math.min(range.end, start + 1)
    if (end <= start) start = Math.max(range.start, end - 1)
  }
  const topic = asText(record.topic).slice(0, 40) || '会议'
  const summary = asText(record.summary).slice(0, 400)
  const points = asList(record.points, 10)
  const todos = asList(record.todos, 8)
  if (!points.length && !summary && !todos.length) return null
  return { start, end, topic, summary, points, todos }
}

/** Coalesce an over-eager split into one meeting covering the whole selection. */
export function mergeMeetings(meetings: ParsedMeeting[], range: PromptRange): ParsedMeeting[] {
  if (meetings.length <= 1) {
    return [{ ...(meetings[0] ?? { topic: '会议', summary: '', points: [], todos: [] }), start: range.start, end: range.end }]
  }
  const seen = new Set<string>()
  const points: string[] = []
  const todos: string[] = []
  for (const meeting of meetings) {
    for (const point of meeting.points) {
      if (seen.has(point)) continue
      seen.add(point)
      points.push(point)
    }
    for (const todo of meeting.todos) {
      if (seen.has(todo)) continue
      seen.add(todo)
      todos.push(todo)
    }
  }
  return [{
    start: range.start,
    end: range.end,
    topic: meetings[0].topic,
    summary: meetings.map((meeting) => meeting.summary).filter(Boolean).slice(0, 2).join(' '),
    points: points.slice(0, 10),
    todos: todos.slice(0, 8),
  }]
}

/**
 * Parse the model reply into clamped meetings.
 * @param text raw model text (may contain a fenced block or prose)
 * @param range the user's selection; a single meeting always spans it
 * @param allowSplit whether the transcript showed an explicit switch
 */
export function parseMeetings(text: string, range: PromptRange, allowSplit: boolean): ParsedMeeting[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) throw new AiOutputError('模型没有返回 JSON 对象')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1))
  } catch {
    throw new AiOutputError('模型返回的 JSON 无法解析')
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.meetings) ? record.meetings : []
  const meetings = list
    .map((item) => parseMeeting(item, range))
    .filter((item): item is ParsedMeeting => item !== null)
    .sort((a, b) => a.start - b.start)
  if (!meetings.length) throw new AiOutputError('模型没有给出可用的会议内容')
  return allowSplit ? meetings : mergeMeetings(meetings, range)
}
