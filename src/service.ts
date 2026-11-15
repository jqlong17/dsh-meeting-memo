/**
 * Domain layer shared by the panel RPC and the Agent tools.
 *
 * Everything is read-only on the notta log root; minutes + selection state live
 * under the plugin's own `home` directory.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'

import { DAY_RE, detectLifelogRoot, listDayDirs } from './config.ts'
import type { MeetingConfig } from './config.ts'
import { listSources, readSelectedRoot, writeSelectedRoot } from './source.ts'
import { asrLogRoot } from './asr-log.ts'
import { dayStats, formatClock, hourlySummary, nowMinuteOfDay, parseClock, readDay, sliceRange, todayKey } from './lifelog.ts'
import type { DayData } from './lifelog.ts'
import {
  formatStamp,
  minutesDir,
  normalizeSession,
  paths,
  deriveLegacy,
  readDoc,
  readState,
  removeDoc,
  renderMarkdown,
  replaceRangeSessions,
  writeDoc,
  writeState,
} from './minutes.ts'
import type { MinutesDoc, MinutesSession, SessionSource } from './minutes.ts'
import { AiOutputError, buildPrompt, clipText, hasSwitchMarker, parseMeetings } from './ai.ts'
import { fetchFeishuNotes } from './feishu-context.ts'
import { builtinSkill } from './skills.ts'
import { deleteBackground, readBackgroundSelection, readBackgrounds, upsertBackground, writeBackgroundSelection } from './backgrounds.ts'
import type { BackgroundCard } from './backgrounds.ts'
import type { ParsedMeeting } from './ai.ts'
import type {
  BucketDTO,
  DayPayload,
  DayStatsDTO,
  HourDTO,
  MinutesOverview,
  MinutesPayload,
  RangePayload,
  SelectionDTO,
  SegmentDTO,
} from './types.ts'

export class MeetingError extends Error {
  code: string
  hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'MeetingError'
    this.code = code
    this.hint = hint
  }
}

const MAX_SEGMENTS = 4_000

function clampSelection(start: number, end: number, config: MeetingConfig): SelectionDTO {
  const min = config.windowStart
  const max = config.windowEnd
  let from = Number.isFinite(start) ? start : min
  let to = Number.isFinite(end) ? end : from + 120
  if (from > to) [from, to] = [to, from]
  from = Math.max(0, Math.min(1440, from))
  to = Math.max(0, Math.min(1440, to))
  if (to - from < 1) {
    to = Math.min(1440, from + 60)
    from = Math.max(0, to - 60)
  }
  return { start: Math.round(from * 10) / 10, end: Math.round(to * 10) / 10 }
}

function defaultSelection(day: string, today: string, timeZone: string, data: DayData, config: MeetingConfig): SelectionDTO {
  const lastBucket = data.buckets.length ? data.buckets[data.buckets.length - 1].m + 1 : 0
  const lastSegment = data.segments.length ? data.segments[data.segments.length - 1].e : 0
  const last = Math.max(lastBucket, lastSegment)
  const isToday = day === today
  let end: number
  if (isToday) end = Math.max(nowMinuteOfDay(timeZone), config.windowStart + 60)
  else if (last > 0) end = last
  else end = config.windowStart + 120
  end = Math.ceil(end / 5) * 5
  end = Math.max(config.windowStart + 60, Math.min(config.windowEnd, end))
  const start = Math.max(config.windowStart, end - 120)
  return clampSelection(start, end, config)
}

function toSegmentDTO(segment: { s: number; e: number; track: string; text: string; source?: string; line?: number }): SegmentDTO {
  return {
    s: Math.round(segment.s * 100) / 100,
    e: Math.round(segment.e * 100) / 100,
    track: segment.track,
    text: segment.text,
    ...(segment.source ? { source: segment.source } : {}),
    ...(typeof segment.line === 'number' ? { line: segment.line } : {}),
  }
}

function toBucketDTO(bucket: { m: number; s: number; c: number; n: number }): BucketDTO {
  return {
    m: bucket.m,
    s: Math.round(bucket.s * 100) / 100,
    c: bucket.c,
    n: bucket.n,
  }
}

export interface DayLoad {
  day: string
  data: DayData
  days: string[]
  root: string
  today: string
}

/** The tiny slice of the Host `llm` service this plugin uses; no value import. */
export interface LlmRuntimeLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string }>>
  currentSelection(): unknown
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function providerScore(id: string): number {
  if (/deepseek/i.test(id)) return 3
  if (/xai|grok|openai|anthropic|google/i.test(id)) return 2
  return 1
}

export class MeetingService {
  readonly config: MeetingConfig
  private llm: LlmRuntimeLike | null = null

  constructor(config: MeetingConfig) {
    this.config = config
  }

  /** Wired by the plugin entry once the Host `llm` service is available. */
  attachLlm(llm: LlmRuntimeLike): void {
    this.llm = llm
  }

  /**
   * The panel only reads the plugin's own ASR log. An explicit `lifelogRoot` in
   * the plugin config still wins, so tests and advanced setups can point elsewhere.
   */
  private detectRoot(): ReturnType<typeof detectLifelogRoot> {
    if (this.config.lifelogRoot) {
      return detectLifelogRoot({ ...this.config, lifelogRoot: this.config.lifelogRoot })
    }
    const root = asrLogRoot(this.config.home)
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      // Read-only home: fall through and let the day loader report an empty state.
    }
    return detectLifelogRoot({ ...this.config, lifelogRoot: root })
  }

  private loadDay(dayRequest?: string): DayLoad {
    const detection = this.detectRoot()
    if (!detection.root) {
      throw new MeetingError(
        'NO_SOURCE',
        '找不到 notta 生活日志目录',
        `已尝试：${detection.inspected.map((entry) => entry.root).join('、')}。可在插件配置里设置 lifelogRoot，或设置环境变量 MEETING_MINUTES_LIFELOG。`,
      )
    }
    const days = listDayDirs(detection.root)
    const today = todayKey(this.config.timeZone)
    if (!days.length && existsSync(detection.root)) {
      const data = readDay(detection.root, today, this.config.timeZone)
      return { day: today, data, days: [today], root: detection.root, today }
    }
    if (!days.length) {
      throw new MeetingError(
        'NO_DAYS',
        `还没有任何录音转写：${detection.root}`,
        '在「录音」页开启转写后，当天的转写会按日期归档到这里。',
      )
    }
    const requested = typeof dayRequest === 'string' ? dayRequest.trim() : ''
    const day = DAY_RE.test(requested) ? requested : (days[days.length - 1] ?? today)
    const data = readDay(detection.root, day, this.config.timeZone)
    return { day, data, days, root: detection.root, today }
  }

  private readSelection(day: string, today: string, data: DayData): SelectionDTO {
    const state = readState(this.config.home)
    if (state && state.day === day) return clampSelection(state.start, state.end, this.config)
    return defaultSelection(day, today, this.config.timeZone, data, this.config)
  }

  dayPayload(dayRequest?: string): DayPayload {
    const detection = this.detectRoot()
    const { day, data, days, root, today } = this.loadDay(dayRequest)
    const stats = dayStats(data)
    const selection = this.readSelection(day, today, data)
    const segmentsTotal = data.segments.length
    const segments = data.segments.slice(0, MAX_SEGMENTS)
    return {
      day,
      today,
      days,
      root,
      files: {
        activity: existsSync(path.join(root, day, 'activity.jsonl')),
        snippets: existsSync(path.join(root, day, 'snippets.jsonl')),
      },
      filePaths: {
        activity: path.join(root, day, 'activity.jsonl'),
        snippets: path.join(root, day, 'snippets.jsonl'),
      },
      window: { start: this.config.windowStart, end: this.config.windowEnd },
      buckets: data.buckets.map(toBucketDTO),
      segments: segments.map(toSegmentDTO),
      segmentsTotal,
      truncated: segmentsTotal > segments.length,
      stats: stats as DayStatsDTO,
      hourly: hourlySummary(data, 6, 24) as HourDTO[],
      selection,
      warnings: data.warnings,
      inspected: detection.inspected,
      home: this.config.home,
      sources: listSources(this.config, root),
    }
  }

  status(): Record<string, unknown> {
    const detection = this.detectRoot()
    const today = todayKey(this.config.timeZone)
    return {
      root: detection.root,
      today,
      days: detection.root ? listDayDirs(detection.root) : [],
      home: this.config.home,
      minutesRoot: minutesDir(this.config.home),
      timeZone: this.config.timeZone,
      inspected: detection.inspected,
      window: { start: this.config.windowStart, end: this.config.windowEnd },
    }
  }

  sources(): { sources: ReturnType<typeof listSources> } {
    const detection = this.detectRoot()
    return { sources: listSources(this.config, detection.root) }
  }

  saveSelection(day: string, start: number, end: number): SelectionDTO {
    if (!DAY_RE.test(day)) throw new MeetingError('BAD_DAY', `非法日期：${day}`)
    const selection = clampSelection(start, end, this.config)
    writeState(this.config.home, {
      day,
      start: selection.start,
      end: selection.end,
      updatedAt: new Date().toISOString(),
    })
    return selection
  }

  private minutesPayload(doc: MinutesDoc): MinutesPayload {
    const { jsonPath, mdPath } = paths(this.config.home, doc.day)
    return {
      day: doc.day,
      title: doc.title,
      note: doc.note,
      updatedAt: doc.updatedAt,
      ...(doc.model ? { model: doc.model } : {}),
      sessions: doc.sessions.map((session) => ({
        ...session,
        // 过渡期：旧客户端只认 summary/decisions/todos/relatedDocs，这里从正文派生一份。
        ...deriveLegacy(session.content ?? ''),
      })),
      jsonPath,
      mdPath,
      markdown: renderMarkdown(doc, this.config.timeZone),
    }
  }

  minutes(dayRequest?: string): MinutesOverview {
    const { day, days, root, today } = this.loadDay(dayRequest)
    const doc = readDoc(this.config.home, day)
    return { day, today, days, root, minutes: this.minutesPayload(doc) }
  }

  minutesForDay(day: string): MinutesPayload {
    const doc = readDoc(this.config.home, day)
    return this.minutesPayload(doc)
  }

  backgrounds(): { items: BackgroundCard[]; selection: string[] } {
    const items = readBackgrounds(this.config.home)
    const ids = new Set(items.map((item) => item.id))
    const selection = readBackgroundSelection(this.config.home).filter((id) => ids.has(id))
    return { items, selection }
  }

  saveBackground(raw: unknown): { item: BackgroundCard; items: BackgroundCard[]; selection: string[] } {
    const result = upsertBackground(this.config.home, raw)
    const selection = readBackgroundSelection(this.config.home).filter((id) => result.items.some((item) => item.id === id))
    return { ...result, selection }
  }

  deleteBackground(id: string): { items: BackgroundCard[]; selection: string[] } {
    return deleteBackground(this.config.home, id)
  }

  selectBackgrounds(ids: unknown): { selection: string[] } {
    const items = readBackgrounds(this.config.home)
    const valid = new Set(items.map((item) => item.id))
    const wanted = Array.isArray(ids) ? ids.map((id) => String(id ?? '')) : []
    return { selection: writeBackgroundSelection(this.config.home, wanted.filter((id) => valid.has(id))) }
  }

  private selectedBackgroundCards(ids: unknown): BackgroundCard[] {
    if (!Array.isArray(ids) || !ids.length) return []
    const wanted = new Set(ids.map((id) => String(id ?? '')))
    return readBackgrounds(this.config.home).filter((item) => wanted.has(item.id)).slice(0, 12)
  }

  private async resolveRoute(): Promise<{ provider: string; model: string }> {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model }
    }
    if (!this.llm) {
      throw new MeetingError('NO_LLM', '还没有可用的模型通道', 'Host 没有提供 llm 服务；重启 DSH 后再试。')
    }
    try {
      const selection = this.llm.currentSelection()
      const record = selection && typeof selection === 'object' ? selection as Record<string, unknown> : {}
      const route = record.route && typeof record.route === 'object' ? record.route as Record<string, unknown> : {}
      const provider = firstString(record.provider, record.providerId, route.provider)
      const model = firstString(record.model, record.modelId, route.model)
      if (provider && model) return { provider, model }
    } catch {
      // Fall through to discovery.
    }
    try {
      const providers = [...this.llm.listProviders()].sort((a, b) => providerScore(b.id) - providerScore(a.id))
      for (const provider of providers) {
        const models = await this.llm.listModels(provider.id).catch(() => [])
        const chosen = models.find((model) => /flash/i.test(model.id))
          ?? models.find((model) => /chat/i.test(model.id))
          ?? models[0]
        if (chosen) return { provider: provider.id, model: chosen.id }
      }
    } catch {
      // Report the uniform error below.
    }
    throw new MeetingError('NO_MODEL', '没有可用的模型路由', '在设置里选择默认模型，或在插件配置里填 provider / model。')
  }

  /**
   * Ask the Host model to turn the selected transcript into minutes.
   * Default: exactly one meeting covering the whole selection; splits only when
   * the transcript itself contains an explicit session switch.
   */
  async generateMinutes(
    dayRequest: string | undefined,
    startValue: unknown,
    endValue: unknown,
    sessionId?: string,
    backgroundIds?: unknown,
    signal?: AbortSignal,
    skillId?: string,
    supplements?: string,
  ): Promise<MinutesPayload & { added: number; model: { provider: string; model: string }; elapsedMs: number }> {
    const { day, data } = this.loadDay(dayRequest)
    if (!this.llm) {
      throw new MeetingError('NO_LLM', '还没有可用的模型通道', 'Host 没有提供 llm 服务；重启 DSH 后再试。')
    }
    const start = parseClock(startValue, this.config.windowStart)
    const end = parseClock(endValue, this.config.windowEnd)
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    if (to - from < 1) throw new MeetingError('BAD_RANGE', '选区太短，至少 1 分钟')
    const slice = sliceRange(data, from, to, { maxChars: 40_000, withText: true })
    if (!slice.segments.length) {
      throw new MeetingError(
        'EMPTY_RANGE',
        `${day} ${formatClock(from)}–${formatClock(to)} 没有转写内容`,
        '换一段有密度条的区间，或先把区间放宽到「全天」。',
      )
    }
    const clipped = clipText(slice.text, 30_000)
    const allowSplit = hasSwitchMarker(clipped.text)
    const cards = this.selectedBackgroundCards(backgroundIds)
    // 内置提示词：不再支持多套写法，生成口径统一在 ai.ts 的 SYSTEM_PROMPT。
    const skill = builtinSkill()
    const extra = (supplements || '').trim()
    const linked = [extra, ...cards.map((card) => card.content)].filter(Boolean).join('\n')
    const fetched = linked ? await fetchFeishuNotes(linked) : ''
    const supplementText = [extra, fetched].filter(Boolean).join('\n\n').slice(0, 24_000)
    const prompt = buildPrompt({
      day,
      range: { start: from, end: to },
      transcript: clipped.text,
      truncated: clipped.truncated,
      backgrounds: cards.map((card) => ({ title: card.title, tags: card.tags, content: card.content })),
      system: skill.prompt,
      ...(supplementText ? { supplements: supplementText } : {}),
    })
    if (signal?.aborted) throw new MeetingError('CANCELLED', '已取消')
    const route = await this.resolveRoute()
    const startedAt = Date.now()
    let text = ''
    const blockTexts: string[] = []
    const timeout = AbortSignal.timeout(360_000)
    const callSignal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const sentenceStream = this.llm.stream({
        provider: route.provider,
        model: route.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        maxTokens: 8_000,
        temperature: 0.3,
        signal: callSignal,
        purpose: 'meeting-minutes',
        ...(sessionId ? { sessionId } : {}),
      })
      for await (const chunk of sentenceStream) {
        if (!chunk || typeof chunk !== 'object') continue
        const record = chunk as Record<string, unknown>
        if (record.type === 'text-delta' && typeof record.text === 'string') {
          text += record.text
          continue
        }
        if (record.type === 'block-end') {
          const block = record.block && typeof record.block === 'object' ? record.block as Record<string, unknown> : {}
          if (block.type === 'text' && typeof block.text === 'string') blockTexts.push(block.text)
          continue
        }
        if (record.type === 'finish') {
          const reason = record.reason as { kind?: unknown } | string | undefined
          const kind = typeof reason === 'string' ? reason : (reason && typeof reason.kind === 'string' ? reason.kind : undefined)
          if (kind === 'aborted' || callSignal.aborted) {
            throw new MeetingError('LLM_TIMEOUT', '生成超过 6 分钟，已停止等待', '选区或补充资料太长时会变慢。可以重试，或把区间缩短。')
          }
          if (kind !== undefined && kind !== 'stop') {
            throw new MeetingError('LLM_FINISHED', `模型提前结束（${kind}）`, '可以重试；若总是被截断，换一个模型。')
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new MeetingError('CANCELLED', '已取消')
      if (error instanceof MeetingError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MeetingError('LLM_TIMEOUT', '模型调用超时（90 秒）', '缩小选区，或在插件配置里换一个更快的 model。')
      }
      throw new MeetingError(
        'LLM_FAILED',
        `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        `模型路由 ${route.provider}/${route.model}；可在插件配置里指定 provider / model。`,
      )
    }
    if (signal?.aborted) throw new MeetingError('CANCELLED', '已取消')
    const output = blockTexts.length ? blockTexts.join('') : text
    if (!output.trim()) throw new MeetingError('LLM_EMPTY', '模型没有返回内容', '重试；或换一个模型。')
    let meetings: ParsedMeeting[]
    try {
      meetings = parseMeetings(output, { start: from, end: to }, allowSplit)
    } catch (error) {
      const detail = error instanceof AiOutputError ? error.message : '模型输出无法解析'
      throw new MeetingError('AI_OUTPUT', detail, '可以重试；若连续失败，换一个模型或在插件配置里指定 provider / model。')
    }
    const now = new Date().toISOString()
    const sourceNote = `本地 ASR 转写（${formatClock(from)}–${formatClock(to)}）`
    const sessions: MinutesSession[] = meetings.map((meeting, index) => ({
      id: `ai-${day}-${Math.round(meeting.start * 60)}-${Math.round(meeting.end * 60)}${meetings.length > 1 ? `-${index}` : ''}`,
      start: meeting.start,
      end: meeting.end,
      topic: meeting.topic,
      // 整场就是一段 Markdown；来源、参考背景这类元信息直接写进正文，不再拆字段。
      content: [
        meeting.content.trim(),
        '',
        `> 来源：${sourceNote}${cards.length ? ` · 参考背景：${cards.map((card) => card.title).join('、')}` : ''}${extra.trim() ? `\n> 补充：${extra.trim()}` : ''}`,
      ].join('\n').trim(),
      source: 'ai',
      updatedAt: now,
    }))
    const doc = readDoc(this.config.home, day)
    const title = meetings.length === 1
      ? `${formatClock(from)}–${formatClock(to)} · ${meetings[0].topic}`
      : `${day} 会议纪要`
    const stored = writeDoc(
      this.config.home,
      day,
      {
        ...replaceRangeSessions(doc, from, to, sessions),
        title,
        model: `${route.provider}/${route.model}`,
      },
      this.config.timeZone,
    )
    return {
      ...this.minutesPayload(stored.doc),
      added: sessions.length,
      model: route,
      elapsedMs: Date.now() - startedAt,
    }
  }


  /**
   * 在访达（或系统文件管理器）里打开一个本地资源：
   * 文件定位到它（open -R），目录直接打开。
   * 只允许打开存在且位于用户目录或 /tmp 下的绝对路径。
   */
  revealPath(target: unknown): { opened: string; kind: 'file' | 'folder' } {
    const raw = String(target ?? '').trim()
    if (!raw.startsWith('/')) throw new MeetingError('BAD_PATH', '只支持本地绝对路径')
    const resolved = path.resolve(raw)
    const home = this.config.home.startsWith('/') ? this.config.home : ''
    const allowed = resolved.startsWith(process.env.HOME ?? '/Users')
      || resolved.startsWith(home)
      || resolved.startsWith('/tmp')
      || resolved.startsWith('/Volumes')
    if (!allowed) throw new MeetingError('BAD_PATH', `不允许打开这个路径：${resolved}`)
    if (!existsSync(resolved)) throw new MeetingError('NOT_FOUND', `路径不存在：${resolved}`)
    const isDir = statSync(resolved).isDirectory()
    const args = isDir ? [resolved] : ['-R', resolved]
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', args, (error) => {
      if (error) throw error
    })
    return { opened: resolved, kind: isDir ? 'folder' : 'file' }
  }

  upsertSession(day: string, raw: Record<string, unknown>): MinutesPayload {
    if (!DAY_RE.test(day)) throw new MeetingError('BAD_DAY', `非法日期：${day}`)
    const doc = readDoc(this.config.home, day)
    const normalized = normalizeSession(raw, day, 'manual')
    if (!normalized) throw new MeetingError('BAD_SESSION', '时段缺少有效的开始/结束时间')
    const before = doc.sessions.find((session) => session.id === normalized.id)
    // 正文是一段 Markdown：编辑器没动它就保留原内容，不会被空值覆盖。
    const stamped: MinutesSession = {
      ...normalized,
      content: normalized.content || before?.content || '',
      source: 'manual',
      updatedAt: new Date().toISOString(),
    }
    const existing = doc.sessions.findIndex((session) => session.id === stamped.id)
    const sessions = existing >= 0
      ? doc.sessions.map((session) => (session.id === stamped.id ? stamped : session))
      : [...doc.sessions, stamped]
    const stored = writeDoc(this.config.home, day, { ...doc, sessions }, this.config.timeZone)
    return this.minutesPayload(stored.doc)
  }

  deleteSession(day: string, id: string): MinutesPayload {
    const doc = readDoc(this.config.home, day)
    const sessions = doc.sessions.filter((session) => session.id !== id)
    const stored = writeDoc(this.config.home, day, { ...doc, sessions }, this.config.timeZone)
    return this.minutesPayload(stored.doc)
  }

  clearDay(day: string): MinutesPayload {
    removeDoc(this.config.home, day)
    return this.minutesPayload(readDoc(this.config.home, day))
  }

  /** Agent-facing: replace/merge timeline sessions authored from a transcript. */
  saveSessions(
    dayRequest: string | undefined,
    items: unknown,
    options: { mode?: 'merge' | 'replace'; title?: string; source?: SessionSource } = {},
  ): { day: string; mdPath: string; jsonPath: string; sessions: MinutesSession[] } {
    const { day } = this.loadDay(dayRequest)
    if (!Array.isArray(items) || !items.length) throw new MeetingError('BAD_SESSIONS', 'sessions 不能为空')
    const source: SessionSource = options.source === 'draft' ? 'draft' : options.source === 'manual' ? 'manual' : 'agent'
    const parsed: MinutesSession[] = []
    for (const item of items) {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const start = parseClock(record.start)
      const end = parseClock(record.end, Math.min(1440, start + 30))
      const normalized = normalizeSession(
        {
          ...record,
          start: Math.min(start, end),
          end: Math.max(start, end),
        },
        day,
        source,
      )
      if (!normalized) continue
      parsed.push({ ...normalized, source, updatedAt: new Date().toISOString() })
    }
    if (!parsed.length) throw new MeetingError('BAD_SESSIONS', '没有可写入的时段（检查 start/end）')
    const doc = readDoc(this.config.home, day)
    let sessions: MinutesSession[]
    if (options.mode === 'replace') {
      sessions = parsed
    } else {
      const kept = doc.sessions.filter((session) => !parsed.some((item) => item.end > session.start && item.start < session.end))
      sessions = [...kept, ...parsed]
    }
    const stored = writeDoc(
      this.config.home,
      day,
      { ...doc, title: options.title?.trim() || doc.title, sessions },
      this.config.timeZone,
    )
    return { day, mdPath: stored.mdPath, jsonPath: stored.jsonPath, sessions: stored.doc.sessions }
  }

  range(dayRequest: string | undefined, startValue: unknown, endValue: unknown, options: { maxChars?: number } = {}): RangePayload {
    const { day, data } = this.loadDay(dayRequest)
    const start = parseClock(startValue, this.config.windowStart)
    const end = parseClock(endValue, this.config.windowEnd)
    const slice = sliceRange(data, start, end, { maxChars: options.maxChars, withText: true })
    return {
      day,
      start: slice.start,
      end: slice.end,
      segments: slice.segments.map(toSegmentDTO),
      chars: slice.chars,
      speechMinutes: Math.round((slice.speechSeconds / 60) * 10) / 10,
      text: slice.text,
      truncated: slice.truncated,
    }
  }

  /** Compact snapshot for the Agent: hourly density, no raw transcript. */
  summary(dayRequest?: string): Record<string, unknown> {
    const payload = this.dayPayload(dayRequest)
    const minutes = readDoc(this.config.home, payload.day)
    return {
      day: payload.day,
      today: payload.today,
      days: payload.days,
      root: payload.root,
      window: payload.window,
      selection: { start: payload.selection.start, end: payload.selection.end, label: `${formatClock(payload.selection.start)}–${formatClock(payload.selection.end)}` },
      stats: payload.stats,
      hourly: payload.hourly,
      warnings: payload.warnings,
      minutes: {
        count: minutes.sessions.length,
        updatedAt: minutes.updatedAt,
        path: paths(this.config.home, payload.day).mdPath,
      },
      backgrounds: {
        selected: readBackgroundSelection(this.config.home),
        items: readBackgrounds(this.config.home).map((item) => ({ id: item.id, title: item.title, tags: item.tags })),
      },
      storage: { home: this.config.home, minutesDir: minutesDir(this.config.home) },
    }
  }

  transcript(dayRequest: string | undefined, startValue: unknown, endValue: unknown, maxChars = 24_000): Record<string, unknown> {
    const payload = this.range(dayRequest, startValue, endValue, { maxChars })
    return {
      day: payload.day,
      range: { start: formatClock(payload.start), end: formatClock(payload.end) },
      segments: payload.segments.length,
      chars: payload.chars,
      speechMinutes: payload.speechMinutes,
      truncated: payload.truncated,
      text: payload.text,
    }
  }

  readMinutes(dayRequest?: string): Record<string, unknown> {
    const { day } = this.loadDay(dayRequest)
    return this.minutesForDay(day)
  }

  describePaths(day: string): { jsonPath: string; mdPath: string } {
    return paths(this.config.home, day)
  }

  stamp(iso: string): string {
    return formatStamp(iso, this.config.timeZone)
  }
}
