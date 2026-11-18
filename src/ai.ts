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
  /** Overrides the built-in writing skill when the user picked another one. */
  system?: string
  /** Extra notes for this meeting, including fetched Feishu pages. */
  supplements?: string
}

export interface ParsedMeeting {
  start: number
  end: number
  topic: string
  /** 整场会议的正文，一段 Markdown。 */
  content: string
}

export class AiOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiOutputError'
  }
}

export const SYSTEM_PROMPT = `你是会议纪要助手。用户会给你一段本地 ASR 转写（可能有错别字、口语、重复和填充词）。
把它整理成按时间线的记录。粒度要细：没在场的人只看记录，也要知道谈了什么、定了什么、谁去做什么。不限于会议。

规则：
1. 默认整段是同一段：只输出 1 条 meeting，start/end 用给定区间。不要因为有停顿、切换话题词或换发言人而拆分。
2. 只有转写里出现明确的换段标志（「下一个议题」「今天先到这」「先到这里」）时，才拆成多条。
3. 只依据转写和背景资料，不编造。数字、版本号、日期、人名、系统名、接口名一律沿用转写里的说法；ASR 明显听错但你能从上下文确定原意的，按原意写。
4. 忽略「嗯、啊、喂、对」等无信息内容，合并重复表达。

每条 meeting 只有三个字段：时间、主题、正文。
- topic：不超过 20 字，写清这段在谈什么。不要写「会议」「讨论」这类空词。
- content：这段的全部正文，一段 Markdown。固定骨架如下，没有内容的小节整节省略：
  「> 💡 **本场背景与目标**」+ 一段话（2–4 句：为什么开、要解决什么、得出什么）
  「### 核心结论」+ 3–5 条，每条「**短标题**：一到两句具体说明」，带关键数字、字段、接口名
  「### TODO」+ 0–10 条「- [ ] 具体动作」，知道谁负责就写「 — 负责人」；负责人**只能是人名**，〔麦克风〕〔系统〕是采集设备，绝对不能写进负责人，也不要在正文里提设备
  「### 相关链接与资源」+ 0–8 条，外链写成「[标题](https://…)」，本地文件写成「标题：反引号包住的绝对路径」
- 正文要能直接当文档读：不要复述转写过程，不要把讨论细节堆成清单。

5. 如果提供了「背景资料」，用它消除人名、项目名、术语的歧义，让要点落在背景的项目语境里；不要照抄背景，也不要把背景里没发生的事写成结论。
6. 严格输出 JSON，不要 Markdown 代码块，不要解释：
{"meetings":[{"start":"HH:mm","end":"HH:mm","topic":"…","content":"> 💡 **本场背景与目标**\n> …\n\n### 核心结论\n- **短标题**：说明…"}]}`

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
    input.supplements ? `补充资料（含背景卡和本次补充里的飞书链接读出的正文；用来核对名词、数字和范围，不要把没在会上发生的事写成结论）：\n${input.supplements}` : '',
    background,
    '',
    '转写（[时间] 说话人(相似度)：文本；方括号里的〔麦克风〕〔系统〕是采集设备，不是人名）：',
    input.transcript,
  ].filter(Boolean).join('\n')
  return { system: input.system?.trim() || SYSTEM_PROMPT, user }
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

/** Strip a leading list bullet, but keep markdown bold markers at the start. */
function stripBullet(text: string): string {
  if (text.startsWith('**')) return text
  return text.replace(/^[-*•]\s+/, '').replace(/^[-•]\s*/, '')
}

function asList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of value) {
    const text = stripBullet(asText(item))
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
  const topic = asText(record.topic).slice(0, 40) || '记录'
  const content = asText(record.content).slice(0, 12_000)
  if (!content) return null
  return { start, end, topic, content }
}

/** Coalesce an over-eager split into one meeting covering the whole selection. */
export function mergeMeetings(meetings: ParsedMeeting[], range: PromptRange): ParsedMeeting[] {
  const empty: ParsedMeeting = { start: range.start, end: range.end, topic: '记录', content: '' }
  if (meetings.length <= 1) {
    return [{ ...(meetings[0] ?? empty), start: range.start, end: range.end }]
  }
  const bodies = meetings.map((meeting) => meeting.content.trim()).filter(Boolean)
  return [{
    start: range.start,
    end: range.end,
    topic: meetings[0].topic,
    content: bodies.join('\n\n'),
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
  if (!meetings.length) throw new AiOutputError('模型没有给出可用的记录')
  return allowSplit ? meetings : mergeMeetings(meetings, range)
}
