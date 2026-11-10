/**
 * 「会议纪要」右侧栏面板：今日（VAD 密度时间轴 + 选区转写）与纪要（时间线）两个 tab。
 *
 * Every read goes through the injected `rpc` face; the bundle only requires
 * `react`. Styles use Host design tokens, so light/dark follow the app theme.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { BackgroundCardDTO, BackgroundsPayload, DayPayload, MinuteSessionDTO, MinutesOverview, MinutesPayload } from '../types.ts'
import type { RpcCall, RpcError } from './rpc.ts'
import { buildIndexCopy } from '../copy-index.ts'
import { TimelineChart } from './timeline.tsx'
import type { TimelineRange } from './timeline.tsx'

const FG = 'var(--dsw-alias-label-primary, inherit)'
const FG2 = 'var(--dsw-alias-label-secondary, inherit)'
const CAPTION = 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55))'
const BG = 'var(--dsw-alias-bg-base, transparent)'
const BG2 = 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))'
const CARD = 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.6))'
const BORDER = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1))'
const ACCENT = 'var(--dsw-alias-brand-primary, #4a63e7)'
const DANGER = 'var(--dsw-alias-state-error-primary, #d92d20)'
const WARN = 'var(--dsw-alias-state-warn-primary, #b54708)'
const SUCCESS = 'var(--dsw-alias-state-success-primary, #1a7f37)'
const RADIUS = 'var(--dsw-radius-md, 8px)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

const buttonStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: FG2,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: ACCENT,
  borderColor: ACCENT,
  color: '#fff',
  fontWeight: 600,
}

const chipStyle = (active: boolean): CSSProperties => ({
  font: 'inherit',
  fontSize: 10.5,
  padding: '1px 7px',
  borderRadius: 999,
  border: `1px solid ${active ? ACCENT : BORDER}`,
  background: active ? ACCENT : 'transparent',
  color: active ? '#fff' : FG2,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

const selectStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 11,
  padding: '2px 5px',
  borderRadius: 6,
  border: `1px solid ${BORDER}`,
  background: BG,
  color: FG,
  minWidth: 0,
  maxWidth: 132,
}

const cardStyle: CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS,
  background: CARD,
  padding: '8px 9px',
  marginBottom: 8,
}

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 11.5,
  padding: '3px 6px',
  borderRadius: 5,
  border: `1px solid ${BORDER}`,
  background: BG,
  color: FG,
  width: '100%',
  boxSizing: 'border-box',
}

function clock(minute: number, withSeconds = false): string {
  const total = Math.max(0, Math.round(minute * 60))
  const hh = Math.floor(total / 3600) % 24
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const base = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  return withSeconds ? `${base}:${String(ss).padStart(2, '0')}` : base
}

function parseClockInput(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null
}

function clockFromDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function clockNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function numberText(value: number): string {
  return value.toLocaleString('en-US')
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function lastDataMinute(data: DayPayload): number {
  const bucket = data.buckets.length ? data.buckets[data.buckets.length - 1].m + 1 : 0
  const segment = data.segments.length ? data.segments[data.segments.length - 1].e : 0
  return Math.max(bucket, segment)
}

export interface PanelProps {
  rpc: RpcCall
  t: (key: string) => string
  sessionId?: string
}

interface EditState {
  id?: string
  start: string
  end: string
  topic: string
  summary: string
  points: string
  todos: string
}

interface BackgroundEdit {
  id?: string
  title: string
  tags: string
  content: string
}

interface GenerationTask {
  id: string
  day: string
  start: number
  end: number
  startedAt: number
  phase: 'running' | 'done' | 'error'
  added?: number
  elapsedMs?: number
  model?: { provider: string; model: string }
  message?: string
  hint?: string
}

function sourceLabel(source: MinuteSessionDTO['source'], t: (key: string) => string): { label: string; color: string } {
  if (source === 'ai') return { label: t('panel.minutes.ai'), color: ACCENT }
  if (source === 'draft') return { label: t('panel.minutes.draft'), color: WARN }
  if (source === 'agent') return { label: t('panel.minutes.agent'), color: ACCENT }
  return { label: t('panel.minutes.manual'), color: SUCCESS }
}

export function Panel(props: PanelProps) {
  const { rpc, t } = props
  const [tab, setTab] = useState<'today' | 'minutes' | 'background'>('today')
  const [data, setData] = useState<DayPayload | null>(null)
  const [dataError, setDataError] = useState<RpcError | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [selection, setSelection] = useState<TimelineRange | null>(null)
  const [follow, setFollow] = useState(true)
  const [track, setTrack] = useState<'all' | 'mic' | 'system' | 'meeting'>('all')
  const [flash, setFlash] = useState('')
  const [minutes, setMinutes] = useState<MinutesPayload | null>(null)
  const [backgrounds, setBackgrounds] = useState<BackgroundCardDTO[]>([])
  const [bgSelection, setBgSelection] = useState<string[]>([])
  const [bgLoading, setBgLoading] = useState(false)
  const [bgError, setBgError] = useState<RpcError | null>(null)
  const [bgEditing, setBgEditing] = useState<BackgroundEdit | null>(null)
  const [bgConfirmId, setBgConfirmId] = useState('')
  const [bgFilterTags, setBgFilterTags] = useState<string[]>([])
  const [bgPickerOpen, setBgPickerOpen] = useState(false)
  const [minutesError, setMinutesError] = useState<RpcError | null>(null)
  const [minutesLoading, setMinutesLoading] = useState(false)
  const [tasks, setTasks] = useState<GenerationTask[]>([])
  const [, setTick] = useState(0)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [confirmId, setConfirmId] = useState('')
  const [notice, setNotice] = useState('')

  const followRef = useRef(true)
  const selectionRef = useRef<TimelineRange | null>(null)
  const dayRef = useRef('')
  const loadDayRef = useRef<(target?: string, forceServerSelection?: boolean) => Promise<void>>(async () => {})
  const listRef = useRef<HTMLDivElement | null>(null)
  const flashTimer = useRef<number | null>(null)
  const generationSeq = useRef(0)

  followRef.current = follow
  selectionRef.current = selection
  dayRef.current = data?.day ?? ''

  const showFlash = useCallback((key: string) => {
    setFlash(key)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(''), 1600)
  }, [])

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const anyRunning = tasks.some((task) => task.phase === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  const loadDay = useCallback(async (target?: string, forceServerSelection = false) => {
    setLoading(true)
    setDataError(null)
    const result = await rpc<DayPayload>('day', target ? { day: target } : {})
    setLoading(false)
    if (!result.ok) {
      setDataError(result.error)
      return
    }
    const payload = result.value
    setData(payload)
    setLastLoadedAt(Date.now())
    const reset = forceServerSelection || followRef.current || selectionRef.current === null
    if (reset) {
      setSelection(payload.selection)
      setFollow(payload.day === payload.today)
    } else if (payload.day !== dayRef.current) {
      setSelection(payload.selection)
      setFollow(payload.day === payload.today)
    }
  }, [rpc])

  loadDayRef.current = loadDay

  useEffect(() => {
    void loadDay(undefined, true)
  }, [loadDay])

  useEffect(() => {
    const refresh = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadDayRef.current(dayRef.current || undefined)
    }
    const timer = window.setInterval(refresh, 15_000)
    const onFocus = (): void => refresh()
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const applyMinutes = useCallback((payload: MinutesPayload) => {
    setMinutes((previous) => {
      if (previous && previous.updatedAt && payload.updatedAt && previous.updatedAt > payload.updatedAt) return previous
      return payload
    })
  }, [])

  const loadMinutes = useCallback(async (target: string) => {
    setMinutesLoading(true)
    setMinutesError(null)
    const result = await rpc<MinutesOverview>('minutes.list', { day: target })
    setMinutesLoading(false)
    if (!result.ok) {
      setMinutesError(result.error)
      return
    }
    applyMinutes(result.value.minutes)
  }, [rpc, applyMinutes])

  const loadBackgrounds = useCallback(async () => {
    setBgLoading(true)
    setBgError(null)
    const result = await rpc<BackgroundsPayload>('backgrounds.list')
    setBgLoading(false)
    if (!result.ok) {
      setBgError(result.error)
      return
    }
    setBackgrounds(result.value.items)
    setBgSelection(result.value.selection)
  }, [rpc])

  useEffect(() => {
    void loadBackgrounds()
  }, [loadBackgrounds])

  const toggleBgSelection = useCallback((id: string) => {
    setBgSelection((previous) => {
      const next = previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
      void rpc('backgrounds.select', { ids: next })
      return next
    })
  }, [rpc])

  const clearBgSelection = useCallback(() => {
    setBgSelection([])
    void rpc('backgrounds.select', { ids: [] })
  }, [rpc])

  const toggleBgFilterTag = (tag: string): void => {
    setBgFilterTags((previous) => (previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag]))
  }

  const startAddBackground = (): void => {
    setBgEditing({ title: '', tags: '', content: '' })
    setBgConfirmId('')
  }

  const startEditBackground = (card: BackgroundCardDTO): void => {
    setBgEditing({ id: card.id, title: card.title, tags: card.tags.join(', '), content: card.content })
    setBgConfirmId('')
  }

  const saveBackground = async (): Promise<void> => {
    if (!bgEditing) return
    if (!bgEditing.title.trim() || !bgEditing.content.trim()) {
      setNotice(t('panel.background.required'))
      return
    }
    const result = await rpc<{ item: BackgroundCardDTO; items: BackgroundCardDTO[]; selection: string[] }>('backgrounds.upsert', {
      item: {
        ...(bgEditing.id ? { id: bgEditing.id } : {}),
        title: bgEditing.title,
        tags: bgEditing.tags,
        content: bgEditing.content,
      },
    })
    if (!result.ok) {
      setNotice(result.error.message)
      return
    }
    setBackgrounds(result.value.items)
    setBgSelection(result.value.selection)
    setBgEditing(null)
    setNotice(t('panel.background.saved'))
  }

  const deleteBackground = async (id: string): Promise<void> => {
    if (bgConfirmId !== id) {
      setBgConfirmId(id)
      window.setTimeout(() => setBgConfirmId((current) => (current === id ? '' : current)), 4000)
      return
    }
    setBgConfirmId('')
    const result = await rpc<{ items: BackgroundCardDTO[]; selection: string[] }>('backgrounds.delete', { id })
    if (!result.ok) {
      setNotice(result.error.message)
      return
    }
    setBackgrounds(result.value.items)
    setBgSelection(result.value.selection)
    if (bgEditing?.id === id) setBgEditing(null)
  }

  useEffect(() => {
    const target = data?.day ?? ''
    if (!target) return
    void loadMinutes(target)
  }, [data?.day, tab, loadMinutes])

  useEffect(() => {
    setTasks((previous) => previous.filter((task) => task.day === data?.day))
  }, [data?.day])

  const windowRange = data?.window ?? { start: 360, end: 1440 }
  const activeSelection = useMemo<TimelineRange>(() => {
    const fallback = data?.selection ?? { start: windowRange.start, end: windowRange.start + 120 }
    const raw = selection ?? fallback
    const start = clamp(Math.min(raw.start, raw.end), windowRange.start, windowRange.end)
    const end = clamp(Math.max(raw.start, raw.end), windowRange.start, windowRange.end)
    return { start, end: end > start ? end : Math.min(windowRange.end, start + 5) }
  }, [selection, data?.selection, windowRange.start, windowRange.end])

  const persistSelection = useCallback((range: TimelineRange) => {
    const target = dayRef.current
    if (!target) return
    void rpc('selection', { day: target, start: range.start, end: range.end })
  }, [rpc])

  const handleDraft = useCallback((range: TimelineRange) => {
    setSelection(range)
    setFollow(false)
  }, [])

  const handleCommit = useCallback((range: TimelineRange) => {
    setSelection(range)
    setFollow(false)
    persistSelection(range)
  }, [persistSelection])

  const quickSelect = (kind: 'last2h' | 'all' | 'now') => {
    if (!data) return
    let range: TimelineRange
    if (kind === 'all') {
      range = { start: data.window.start, end: data.window.end }
      setFollow(false)
    } else {
      const end = data.day === data.today ? Math.max(clockNow(), data.window.start + 60) : lastDataMinute(data)
      const to = clamp(Math.ceil(end / 5) * 5, data.window.start + 60, data.window.end)
      const from = Math.max(data.window.start, to - 120)
      range = { start: from, end: to }
      setFollow(data.day === data.today)
    }
    setSelection(range)
    persistSelection(range)
  }

  const goDay = (delta: number) => {
    const days = data?.days ?? []
    const index = days.indexOf(data?.day ?? '')
    if (index < 0) return
    const next = days[index + delta]
    if (!next) return
    setMinutes(null)
    setEditing(null)
    void loadDay(next, true)
  }

  const segments = useMemo(() => {
    if (!data) return []
    return data.segments.filter((segment) => (
      segment.e > activeSelection.start
      && segment.s < activeSelection.end
      && (track === 'all' || segment.track === track)
    ))
  }, [data, activeSelection.start, activeSelection.end, track])

  const visibleSegments = segments.slice(0, 700)
  const segmentChars = segments.reduce((sum, segment) => sum + segment.text.length, 0)
  const selectionMinutes = Math.max(0, Math.round(activeSelection.end - activeSelection.start))

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [activeSelection.start, activeSelection.end, track])

  const transcriptText = useMemo(() => visibleSegments
    .map((segment) => `[${clock(segment.s, true)}] ${trackName(segment.track, t)}：${segment.text}`)
    .join('\n'), [visibleSegments, t])

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showFlash(key)
    } catch {
      showFlash('failed')
    }
  }

  const copyIndex = (): void => {
    if (!data) return
    const text = buildIndexCopy({
      day: data.day,
      file: data.filePaths?.snippets ?? `${data.root}/${data.day}/snippets.jsonl`,
      segments: segments.map((segment) => ({ s: segment.s, e: segment.e, ...(segment.line ? { line: segment.line } : {}) })),
      selection: activeSelection,
      trackLabel: track === 'all' ? t('panel.filter.all') : t(`panel.filter.${track}`),
      filtered: track !== 'all',
    })
    void copyText(text, 'index')
  }

  const generateDraft = async () => {
    if (!data) return
    const range = { start: activeSelection.start, end: activeSelection.end }
    const backgroundIds = bgSelection.filter((id) => backgrounds.some((card) => card.id === id))
    const duplicate = tasks.some((task) => task.phase === 'running'
      && task.day === data.day
      && Math.abs(task.start - range.start) < 0.5
      && Math.abs(task.end - range.end) < 0.5)
    if (duplicate) return
    generationSeq.current += 1
    const id = `${Date.now()}-${generationSeq.current}`
    const task: GenerationTask = {
      id,
      day: data.day,
      start: range.start,
      end: range.end,
      startedAt: Date.now(),
      phase: 'running',
    }
    setTasks((previous) => [...previous.filter((item) => item.day === data.day), task].slice(-5))
    const result = await rpc<MinutesPayload & { added: number; elapsedMs?: number; model?: { provider: string; model: string } }>('minutes.generate', {
      day: data.day,
      start: range.start,
      end: range.end,
      ...(backgroundIds.length ? { backgroundIds } : {}),
      ...(typeof props.sessionId === 'string' ? { sessionId: props.sessionId } : {}),
    })
    const value = result.ok ? result.value : null
    const incomplete = result.ok && (!value || !Array.isArray(value.sessions) || typeof value.added !== 'number')
    if (!result.ok || !value || incomplete) {
      const message = !result.ok ? result.error.message : '服务返回不完整（Host 可能还是旧版本）'
      const hint = !result.ok
        ? result.error.hint
        : '刷新页面重试；若仍出现，重启 DSH 让新的 Host 代码生效。'
      setTasks((previous) => previous.map((item) => (item.id === id
        ? { ...item, phase: 'error', elapsedMs: Date.now() - item.startedAt, message, ...(hint ? { hint } : {}) }
        : item)))
      return
    }
    setTasks((previous) => previous.map((item) => (item.id === id
      ? {
          ...item,
          phase: 'done',
          added: value.added,
          elapsedMs: value.elapsedMs ?? Date.now() - item.startedAt,
          ...(value.model ? { model: value.model } : {}),
        }
      : item)))
    if (dayRef.current === data.day) {
      applyMinutes(value)
      setMinutesError(null)
    }
  }

  const saveSession = async () => {
    if (!data || !editing) return
    const start = parseClockInput(editing.start)
    const end = parseClockInput(editing.end)
    if (start === null || end === null) {
      setNotice(`${t('panel.minutes.start')} / ${t('panel.minutes.end')} 用 HH:mm`)
      return
    }
    const session = {
      id: editing.id,
      start: Math.min(start, end),
      end: Math.max(start, end),
      topic: editing.topic.trim(),
      summary: editing.summary.trim(),
      points: editing.points.split('\n').map((line) => line.trim()).filter(Boolean),
      todos: editing.todos.split('\n').map((line) => line.trim()).filter(Boolean),
    }
    const result = await rpc<MinutesPayload>('minutes.upsert', { day: data.day, session })
    if (!result.ok) {
      setNotice(result.error.message)
      return
    }
    setMinutes(result.value)
    setMinutesError(null)
    setEditing(null)
    setNotice(t('panel.minutes.saved'))
  }

  const deleteSession = async (id: string) => {
    if (!data) return
    if (confirmId !== id) {
      setConfirmId(id)
      window.setTimeout(() => setConfirmId((current) => (current === id ? '' : current)), 4000)
      return
    }
    setConfirmId('')
    const result = await rpc<MinutesPayload>('minutes.delete', { day: data.day, id })
    if (!result.ok) {
      setNotice(result.error.message)
      return
    }
    setMinutes(result.value)
    if (editing?.id === id) setEditing(null)
  }

  const startEdit = (session: MinuteSessionDTO) => {
    setEditing({
      id: session.id,
      start: clock(session.start),
      end: clock(session.end),
      topic: session.topic,
      summary: session.summary,
      points: session.points.join('\n'),
      todos: session.todos.join('\n'),
    })
    setConfirmId('')
  }

  const startAdd = () => {
    setEditing({
      start: clock(activeSelection.start),
      end: clock(activeSelection.end),
      topic: '',
      summary: '',
      points: '',
      todos: '',
    })
    setConfirmId('')
  }

  const renderError = (error: RpcError, retry: () => void) => (
    <div style={{ ...cardStyle, borderColor: DANGER }}>
      <div style={{ color: DANGER, fontWeight: 600, fontSize: 12, marginBottom: 3 }}>{t('panel.error')}</div>
      <div style={{ fontSize: 11, lineHeight: 1.5 }}>{error.message}</div>
      {error.hint ? <div style={{ ...smallStyle, marginTop: 3 }}>{error.hint}</div> : null}
      <button type="button" style={{ ...buttonStyle, marginTop: 6 }} onClick={retry}>{t('panel.retry')}</button>
    </div>
  )

  const renderEditor = (state: EditState) => (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
        <span style={{ ...smallStyle, whiteSpace: 'nowrap' }}>{t('panel.minutes.start')}</span>
        <input
          style={{ ...inputStyle, width: 64 }}
          value={state.start}
          placeholder="09:00"
          onChange={(event) => setEditing({ ...state, start: event.target.value })}
        />
        <span style={{ ...smallStyle, whiteSpace: 'nowrap' }}>{t('panel.minutes.end')}</span>
        <input
          style={{ ...inputStyle, width: 64 }}
          value={state.end}
          placeholder="10:00"
          onChange={(event) => setEditing({ ...state, end: event.target.value })}
        />
      </div>
      <input
        style={{ ...inputStyle, marginBottom: 5, fontWeight: 600 }}
        value={state.topic}
        placeholder={t('panel.minutes.topic')}
        onChange={(event) => setEditing({ ...state, topic: event.target.value })}
      />
      <input
        style={{ ...inputStyle, marginBottom: 5 }}
        value={state.summary}
        placeholder={t('panel.minutes.summary')}
        onChange={(event) => setEditing({ ...state, summary: event.target.value })}
      />
      <textarea
        style={{ ...inputStyle, marginBottom: 5, resize: 'vertical', lineHeight: 1.5 }}
        rows={4}
        value={state.points}
        placeholder={t('panel.minutes.content')}
        onChange={(event) => setEditing({ ...state, points: event.target.value })}
      />
      <textarea
        style={{ ...inputStyle, marginBottom: 6, resize: 'vertical', lineHeight: 1.5 }}
        rows={2}
        value={state.todos}
        placeholder={t('panel.minutes.todo')}
        onChange={(event) => setEditing({ ...state, todos: event.target.value })}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" style={buttonStyle} onClick={() => setEditing(null)}>{t('panel.minutes.cancel')}</button>
        <button type="button" style={primaryButtonStyle} onClick={() => void saveSession()}>{t('panel.minutes.save')}</button>
      </div>
    </div>
  )

  const renderBackgroundEditor = (state: BackgroundEdit) => (
    <div style={cardStyle}>
      <input
        style={{ ...inputStyle, fontWeight: 600, marginBottom: 5 }}
        value={state.title}
        placeholder={t('panel.background.title')}
        onChange={(event) => setBgEditing({ ...state, title: event.target.value })}
      />
      <input
        style={{ ...inputStyle, marginBottom: 5 }}
        value={state.tags}
        placeholder={t('panel.background.tags')}
        onChange={(event) => setBgEditing({ ...state, tags: event.target.value })}
      />
      <textarea
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.55, marginBottom: 6 }}
        rows={7}
        value={state.content}
        placeholder={t('panel.background.content')}
        onChange={(event) => setBgEditing({ ...state, content: event.target.value })}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" style={buttonStyle} onClick={() => setBgEditing(null)}>{t('panel.background.cancel')}</button>
        <button type="button" style={primaryButtonStyle} onClick={() => void saveBackground()}>{t('panel.background.save')}</button>
      </div>
    </div>
  )

  const renderBackground = () => {
    const allTags = [...new Set(backgrounds.flatMap((card) => card.tags))].sort((a, b) => a.localeCompare(b))
    const visible = backgrounds.filter((card) => bgFilterTags.length === 0 || bgFilterTags.some((tag) => card.tags.includes(tag)))
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: '8px 10px 18px' }}>
        <div style={{ ...smallStyle, lineHeight: 1.55, marginBottom: 6 }}>{t('panel.background.hint')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7, flexWrap: 'wrap' }}>
          <button type="button" style={primaryButtonStyle} onClick={startAddBackground}>{t('panel.background.add')}</button>
          {bgLoading ? <span style={smallStyle}>{t('panel.loading')}</span> : null}
          <span style={{ flex: '1 1 auto' }} />
          {bgSelection.length ? (
            <span style={{ ...smallStyle, color: ACCENT }}>{t('panel.generate.count').replace('{n}', String(bgSelection.length))}</span>
          ) : null}
        </div>
        {bgError ? renderError(bgError, () => void loadBackgrounds()) : null}
        {notice ? <div style={{ ...smallStyle, color: ACCENT, marginBottom: 6 }}>{notice}</div> : null}
        {bgEditing && !bgEditing.id ? renderBackgroundEditor(bgEditing) : null}
        {allTags.length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 7 }}>
            <span style={{ ...smallStyle, alignSelf: 'center' }}>{t('panel.background.filter')}</span>
            <button type="button" style={chipStyle(bgFilterTags.length === 0)} onClick={() => setBgFilterTags([])}>
              {t('panel.background.allTags')}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                style={chipStyle(bgFilterTags.includes(tag))}
                onClick={() => toggleBgFilterTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}
        {visible.length === 0 ? (
          <div style={{ ...smallStyle, lineHeight: 1.6, padding: '6px 0' }}>
            {backgrounds.length ? t('panel.background.none') : t('panel.background.empty')}
          </div>
        ) : visible.map((card) => {
          if (bgEditing && bgEditing.id === card.id) return <div key={card.id}>{renderBackgroundEditor(bgEditing)}</div>
          return (
            <div key={card.id} style={cardStyle}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={bgSelection.includes(card.id)}
                  onChange={() => toggleBgSelection(card.id)}
                  title={t('panel.generate.background')}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, wordBreak: 'break-word' }}>{card.title}</div>
                  {card.tags.length ? (
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
                      {card.tags.map((tag) => (
                        <span
                          key={tag}
                          style={{ fontSize: 9.5, padding: '0 5px', borderRadius: 999, border: `1px solid ${BORDER}`, color: CAPTION }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button type="button" style={buttonStyle} onClick={() => startEditBackground(card)}>{t('panel.background.edit')}</button>
                  <button
                    type="button"
                    style={{ ...buttonStyle, color: bgConfirmId === card.id ? DANGER : FG2, borderColor: bgConfirmId === card.id ? DANGER : BORDER }}
                    onClick={() => void deleteBackground(card.id)}
                  >
                    {bgConfirmId === card.id ? t('panel.background.confirmDelete') : t('panel.background.delete')}
                  </button>
                </div>
              </div>
              <div style={{
                marginTop: 5,
                fontSize: 11.5,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 150,
                overflowY: 'auto',
                opacity: 0.9,
              }}>
                {card.content}
              </div>
              <div style={{ ...smallStyle, marginTop: 4 }}>
                {t('panel.background.updated')} {new Date(card.updatedAt).toLocaleString()}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const renderToday = () => {
    if (loading && !data) {
      return <div style={{ ...smallStyle, padding: '18px 12px' }}>{t('panel.loading')}</div>
    }
    if (dataError && !data) {
      return <div style={{ padding: '10px 12px' }}>{renderError(dataError, () => void loadDay(undefined, true))}</div>
    }
    if (!data) return null
    const today = data.day === data.today
    const now = today ? clockNow() : null
    const runningTasks = tasks.filter((task) => task.phase === 'running' && task.day === data.day)
    const currentTask = runningTasks.find((task) => (
      Math.abs(task.start - activeSelection.start) < 0.5 && Math.abs(task.end - activeSelection.end) < 0.5
    ))
    const dayMinutes = minutes && minutes.day === data.day ? minutes : null
    const minuteIntervals = (dayMinutes?.sessions ?? [])
      .map((session) => ({
        start: Math.max(session.start, data.window.start),
        end: Math.min(session.end, data.window.end),
        label: session.topic,
      }))
      .filter((interval) => interval.end > interval.start)
      .sort((a, b) => a.start - b.start)
    const overlapping = (dayMinutes?.sessions ?? []).filter((session) => (
      session.end > activeSelection.start && session.start < activeSelection.end
    ))
    const latestMinute = lastDataMinute(data)
    const selectionBuckets = data.buckets.filter((bucket) => (
      bucket.m >= Math.floor(activeSelection.start) && bucket.m < Math.ceil(activeSelection.end)
    ))
    const selectionCapture = selectionBuckets.length
    const selectionSpeech = selectionBuckets.reduce((sum, bucket) => sum + Math.max(0, bucket.s), 0) / 60
    const capturedInSelection = selectionCapture > 0
    const pendingRange = latestMinute > 0 && activeSelection.end > latestMinute + 1
    const emptyText = segments.length > 0
      ? ''
      : pendingRange
        ? t('panel.transcript.pending').replace('{time}', clock(latestMinute))
        : capturedInSelection && selectionSpeech < 0.5
          ? t('panel.transcript.silent').replace('{n}', String(selectionCapture))
          : capturedInSelection
            ? t('panel.transcript.noSpeech')
            : t('panel.transcript.empty')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ flex: '0 0 auto', padding: '6px 10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ ...smallStyle, color: FG2 }}>
              {t('panel.selection')}
              {' '}
              <span style={{ fontFamily: MONO, color: FG }}>{clock(activeSelection.start)}–{clock(activeSelection.end)}</span>
              {' '}
              · {selectionMinutes} {t('unit.min')}
              {' '}
              · {t('panel.captured')} {selectionCapture} {t('unit.min')}
              {' '}
              · {t('panel.speech')} {selectionSpeech.toFixed(1)} {t('unit.min')}
            </span>
            <span style={{ flex: '1 1 auto' }} />
            <button type="button" style={buttonStyle} onClick={() => quickSelect('last2h')}>{t('panel.last2h')}</button>
            <button type="button" style={buttonStyle} onClick={() => quickSelect('all')}>{t('panel.allDay')}</button>
          </div>
          <TimelineChart
            buckets={data.buckets}
            start={data.window.start}
            end={data.window.end}
            selection={activeSelection}
            now={now}
            labels={{
              density: t('panel.density'),
              hint: t('panel.densityHint'),
              gap: t('panel.legend.gap'),
              speech: t('panel.legend.speech'),
              now: t('panel.now'),
            }}
            intervals={minuteIntervals}
            intervalsLabel={t('panel.today.minutesLane')}
            formatTime={(minute) => clock(minute)}
            onDraft={handleDraft}
            onCommit={handleCommit}
          />
          <div style={{ ...smallStyle, display: 'flex', gap: 8, flexWrap: 'wrap', padding: '2px 0 6px' }}>
            <span style={{ fontWeight: 600 }}>{t('panel.todayStats')}</span>
            <span>{data.stats.segments} 段</span>
            <span>{numberText(data.stats.chars)} 字</span>
            <span>语音 {data.stats.speechMinutes} {t('unit.min')}</span>
            <span>{t('panel.captured')} {data.stats.captureMinutes} 分钟</span>
            {lastLoadedAt ? <span>{t('panel.updated')} {clockFromDate(lastLoadedAt)}</span> : null}
            <span>{t('panel.autoRefresh')}</span>
            {data.truncated ? <span style={{ color: WARN }}>{t('panel.transcript.truncated').replace('{n}', String(data.segments.length))}</span> : null}
            {data.warnings.map((warning) => <span key={warning} style={{ color: WARN }}>{warning}</span>)}
          </div>

          <div style={{
            border: `1px solid ${BORDER}`,
            borderRadius: RADIUS,
            background: BG2,
            padding: '6px 8px',
            margin: '0 0 7px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={{ ...primaryButtonStyle, opacity: currentTask ? 0.75 : 1 }}
                disabled={Boolean(currentTask) || !data}
                onClick={() => void generateDraft()}
              >
                {currentTask
                  ? `${t('panel.minutes.generating')}… ${Math.max(0, Math.floor((Date.now() - currentTask.startedAt) / 1000))}s`
                  : t('panel.minutes.generate')}
              </button>
              <div aria-live="polite" style={{ flex: '1 1 150px', minWidth: 0, fontSize: 10.5, lineHeight: 1.5, color: CAPTION }}>
                {runningTasks.length > 0 ? (
                  <span>{runningTasks.length} 个生成中 · {t('panel.today.concurrent')}</span>
                ) : overlapping.length > 0 ? (
                  <span style={{ color: WARN }}>
                    {t('panel.today.overlap')} · {clock(overlapping[0].start)}–{clock(overlapping[0].end)} · {overlapping[0].topic}
                  </span>
                ) : dayMinutes && dayMinutes.sessions.length ? (
                  <span>
                    {t('panel.today.existing')} · {clock(dayMinutes.sessions[0].start)}–{clock(dayMinutes.sessions[0].end)} · {dayMinutes.sessions[0].topic}
                    <br />
                    {t('panel.today.viewInMinutes')}
                  </span>
                ) : (
                  <span>{t('panel.today.generateHint')}</span>
                )}
              </div>
              {(tasks.some((task) => task.phase === 'done') || (!tasks.length && dayMinutes && dayMinutes.sessions.length > 0)) ? (
                <button type="button" style={buttonStyle} onClick={() => setTab('minutes')}>{t('panel.today.viewMinutes')}</button>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600 }}>{t('panel.generate.background')}</span>
              <span style={{ fontSize: 10.5, color: bgSelection.length ? ACCENT : CAPTION }}>
                {bgSelection.length
                  ? t('panel.generate.count').replace('{n}', String(bgSelection.length))
                  : t('panel.generate.none')}
              </span>
              <button type="button" style={buttonStyle} onClick={() => setBgPickerOpen((open) => !open)}>
                {bgPickerOpen ? t('panel.generate.pickClose') : t('panel.generate.pick')}
              </button>
              {bgSelection.length ? (
                <button type="button" style={buttonStyle} onClick={clearBgSelection}>{t('panel.generate.clear')}</button>
              ) : null}
              {backgrounds.length === 0 ? (
                <button type="button" style={buttonStyle} onClick={() => setTab('background')}>{t('panel.generate.goBackground')}</button>
              ) : null}
            </div>
            {bgPickerOpen ? (
              <div style={{
                marginTop: 4,
                paddingTop: 4,
                borderTop: `1px dashed ${BORDER}`,
                maxHeight: 120,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}>
                {backgrounds.length === 0 ? (
                  <span style={smallStyle}>{t('panel.generate.noBackgrounds')} · {t('panel.generate.backgroundHint')}</span>
                ) : backgrounds.map((card) => (
                  <label key={card.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 10.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={bgSelection.includes(card.id)}
                      onChange={() => toggleBgSelection(card.id)}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{card.title}</span>
                      {card.tags.length ? <span style={{ opacity: 0.7 }}> · {card.tags.join('、')}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {tasks.length > 0 ? (
              <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px dashed ${BORDER}`, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 92, overflowY: 'auto' }}>
                {[...tasks].reverse().map((task) => (
                  <div
                    key={task.id}
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'baseline',
                      fontSize: 10.5,
                      minWidth: 0,
                      color: task.phase === 'error' ? DANGER : CAPTION,
                    }}
                  >
                    <span style={{ flex: '0 0 auto', fontFamily: MONO }}>{clock(task.start)}–{clock(task.end)}</span>
                    {task.phase === 'running' ? (
                      <>
                        <span style={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: ACCENT, animation: 'mm-pulse 1.1s ease-in-out infinite' }} />
                        <span>{t('panel.today.running')}… {Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))}s</span>
                      </>
                    ) : task.phase === 'done' ? (
                      <>
                        <span style={{ color: SUCCESS, flex: '0 0 auto' }}>✓</span>
                        <span>
                          <span style={{ color: SUCCESS, fontWeight: 600 }}>{t('panel.today.generated')}</span>
                          {' '}· {task.added ?? 0} 场 · {((task.elapsedMs ?? 0) / 1000).toFixed(1)}s
                        </span>
                      </>
                    ) : (
                      <>
                        <span style={{ color: DANGER, flex: '0 0 auto' }}>!</span>
                        <span
                          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={`${task.message ?? ''}${task.hint ? ` · ${task.hint}` : ''}`}
                        >
                          {t('panel.today.failed')}：{task.message}{task.hint ? ` · ${task.hint}` : ''}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: `1px solid ${BORDER}` }}>
          <div style={{ flex: '0 0 auto', padding: '6px 10px 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{t('panel.transcript')}</span>
              <span style={smallStyle}>
                {t('panel.transcript.count').replace('{n}', String(segments.length)).replace('{chars}', numberText(segmentChars))}
              </span>
              <span style={{ flex: '1 1 auto' }} />
              <button type="button" style={buttonStyle} onClick={() => void loadDay(data.day, false)}>
                {t('panel.refresh')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={segments.length === 0}
                onClick={copyIndex}
              >
                {flash === 'index' ? t('panel.transcript.indexCopied') : t('panel.transcript.copyIndex')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={!transcriptText}
                onClick={() => void copyText(transcriptText, 'transcript')}
              >
                {flash === 'transcript' ? t('panel.transcript.copied') : t('panel.transcript.copy')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, margin: '4px 0 2px', flexWrap: 'wrap' }}>
              {(['all', 'mic', 'system', 'meeting'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  style={chipStyle(track === key)}
                  onClick={() => setTrack(key)}
                >
                  {t(`panel.filter.${key}`)}
                </button>
              ))}
              {segments.length > visibleSegments.length
                ? <span style={{ ...smallStyle, alignSelf: 'center' }}>{t('panel.transcript.capped').replace('{n}', String(visibleSegments.length))}</span>
                : null}
            </div>
          </div>
          <div ref={listRef} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '2px 10px 12px' }}>
            {visibleSegments.length === 0
              ? <div style={{ ...smallStyle, lineHeight: 1.6, padding: '10px 0' }}>{emptyText || t('panel.transcript.empty')}</div>
              : visibleSegments.map((segment, index) => (
                <div
                  key={`${segment.s}-${index}`}
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'baseline',
                    padding: '4px 0',
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 10, color: CAPTION, flex: '0 0 auto', width: 52 }}>
                    {clock(segment.s, true)}
                  </span>
                  <span style={{
                    flex: '0 0 auto',
                    fontSize: 9.5,
                    padding: '0 4px',
                    borderRadius: 4,
                    border: `1px solid ${BORDER}`,
                    color: trackColor(segment.track),
                    whiteSpace: 'nowrap',
                  }}>
                    {trackName(segment.track, t)}
                  </span>
                  <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: 1.55, wordBreak: 'break-word' }}>
                    {segment.text}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>
    )
  }

  const renderMinutes = () => {
    const sessions = minutes?.sessions ?? []
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: '8px 10px 18px' }}>
        <div style={{ ...smallStyle, lineHeight: 1.55, marginBottom: 6 }}>{t('panel.minutes.hint')}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <button type="button" style={buttonStyle} disabled={!data} onClick={startAdd}>{t('panel.minutes.add')}</button>
          <span style={{ ...smallStyle, minWidth: 0 }}>{t('panel.minutes.generateInToday')}</span>
        </div>
        {notice ? <div style={{ ...smallStyle, color: ACCENT, marginBottom: 6 }}>{notice}</div> : null}
        {minutesError ? renderError(minutesError, () => { if (data) void loadMinutes(data.day) }) : null}
        {minutesLoading && !minutes ? <div style={{ ...smallStyle, padding: '6px 0' }}>{t('panel.loading')}</div> : null}
        {!minutesLoading && minutes && sessions.length === 0 && !editing
          ? <div style={{ ...smallStyle, lineHeight: 1.6, padding: '6px 0' }}>{t('panel.minutes.empty')}</div>
          : null}
        {editing && !editing.id ? renderEditor(editing) : null}
        {sessions.map((session) => {
          if (editing && editing.id === session.id) return <div key={session.id}>{renderEditor(editing)}</div>
          const badge = sourceLabel(session.source, t)
          return (
            <div key={session.id} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: ACCENT, whiteSpace: 'nowrap' }}>
                  {clock(session.start)}–{clock(session.end)}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' }}>
                  {session.topic}
                </span>
                <span style={{ fontSize: 9.5, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}>
                  {badge.label}
                </span>
              </div>
              {session.summary ? <div style={{ ...smallStyle, marginTop: 3 }}>{session.summary}</div> : null}
              {session.backgrounds?.length ? (
                <div style={{ ...smallStyle, marginTop: 3 }}>{t('panel.minutes.backgrounds')}：{session.backgrounds.join('、')}</div>
              ) : null}
              {session.points.length ? (
                <ul style={{ margin: '4px 0 0', paddingLeft: 15, fontSize: 11.5, lineHeight: 1.6 }}>
                  {session.points.map((point, index) => <li key={index}>{point}</li>)}
                </ul>
              ) : null}
              {session.todos.length ? (
                <div style={{ marginTop: 5 }}>
                  <div style={{ ...smallStyle, color: WARN, fontWeight: 600 }}>TODO</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: 15, fontSize: 11.5, lineHeight: 1.6 }}>
                    {session.todos.map((todo, index) => <li key={index}>{todo}</li>)}
                  </ul>
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                <button type="button" style={buttonStyle} onClick={() => startEdit(session)}>{t('panel.minutes.edit')}</button>
                <button
                  type="button"
                  style={{ ...buttonStyle, color: confirmId === session.id ? DANGER : FG2, borderColor: confirmId === session.id ? DANGER : BORDER }}
                  onClick={() => void deleteSession(session.id)}
                >
                  {confirmId === session.id ? t('panel.minutes.confirmDelete') : t('panel.minutes.delete')}
                </button>
              </div>
            </div>
          )
        })}
        {minutes ? (
          <div style={{ marginTop: 10, borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
            <div style={{ ...smallStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={minutes.mdPath}>
                {t('panel.minutes.file')}：{minutes.mdPath}
              </span>
              <button type="button" style={buttonStyle} disabled={!minutes.markdown} onClick={() => void copyText(minutes.markdown, 'markdown')}>
                {flash === 'markdown' ? t('panel.minutes.copied') : t('panel.minutes.copyMd')}
              </button>
            </div>
            {minutes.updatedAt ? (
              <div style={{ ...smallStyle, marginTop: 2 }}>
                {t('panel.updated')} {new Date(minutes.updatedAt).toLocaleString()}
                {minutes.model ? ` · ${t('panel.minutes.model')} ${minutes.model}` : ''}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const days = data?.days ?? []
  const currentIndex = days.indexOf(data?.day ?? '')
  const refreshing = loading

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13, color: FG, background: BG }}>
      <style>{'@keyframes mm-pulse{0%,100%{opacity:.25}50%{opacity:1}}'}</style>
      <div style={{ flex: '0 0 auto', padding: '10px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('panel.title')}</div>
          <button
            type="button"
            style={buttonStyle}
            disabled={refreshing}
            onClick={() => { void loadDay(data?.day, false); if (data) void loadMinutes(data.day); void loadBackgrounds() }}
          >
            {refreshing ? t('panel.refreshing') : t('panel.refresh')}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }}>
          <button type="button" style={buttonStyle} disabled={currentIndex <= 0} onClick={() => goDay(-1)} title={t('panel.prevDay')}>‹</button>
          <select
            style={selectStyle}
            value={data?.day ?? ''}
            disabled={!days.length}
            onChange={(event) => { setMinutes(null); setEditing(null); void loadDay(event.target.value, true) }}
          >
            {days.length === 0 ? <option value="">—</option> : [...days].reverse().map((entry) => (
              <option key={entry} value={entry}>{entry}{entry === data?.today ? ` · ${t('panel.today')}` : ''}</option>
            ))}
          </select>
          <button type="button" style={buttonStyle} disabled={currentIndex < 0 || currentIndex >= days.length - 1} onClick={() => goDay(1)} title={t('panel.nextDay')}>›</button>
          <button type="button" style={buttonStyle} onClick={() => { setMinutes(null); void loadDay(undefined, true) }}>{t('panel.today')}</button>
          <span style={{ ...smallStyle, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={data?.root ?? ''}>
            {data?.root ?? ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, borderBottom: `1px solid ${BORDER}` }}>
          {(['today', 'minutes', 'background'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: '6px 0 8px',
                fontSize: 13,
                fontWeight: tab === key ? 600 : 400,
                color: tab === key ? FG : CAPTION,
                borderBottom: `2px solid ${tab === key ? ACCENT : 'transparent'}`,
                cursor: 'pointer',
              }}
            >
              {t(key === 'today' ? 'panel.tab.today' : key === 'minutes' ? 'panel.tab.minutes' : 'panel.tab.background')}
            </button>
          ))}
          {follow && data?.day === data?.today
            ? <span style={{ ...smallStyle, alignSelf: 'center', marginLeft: 'auto' }}>{t('panel.now')} · {t('panel.last2h')}</span>
            : null}
        </div>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'today' ? renderToday() : tab === 'minutes' ? renderMinutes() : renderBackground()}
      </div>
      <div style={{ flex: '0 0 auto', padding: '4px 12px 6px', borderTop: `1px solid ${BORDER}`, ...smallStyle }}>
        {t('panel.footer')}
      </div>
    </div>
  )
}

const smallStyle: CSSProperties = { fontSize: 10.5, color: CAPTION }

function trackName(track: string, t: (key: string) => string): string {
  if (track === 'system') return t('panel.filter.system')
  if (track === 'meeting') return t('panel.filter.meeting')
  return t('panel.filter.mic')
}

function trackColor(track: string): string {
  if (track === 'system') return ACCENT
  if (track === 'meeting') return SUCCESS
  return FG2
}
