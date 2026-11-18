/**
 * 「会议纪要」右侧栏面板：今日（VAD 密度时间轴 + 选区转写）与纪要（时间线）两个 tab。
 *
 * Every read goes through the injected `rpc` face; the bundle only requires
 * `react`. Styles use Host design tokens, so light/dark follow the app theme.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { isDemoActive, setDemoActive } from './demo.ts'
import type { AsrModelsPayload, AsrStatusDTO, MinutesRangeDTO, UpdateStatusDTO, SpeakerPayload, BackgroundCardDTO, BackgroundsPayload, DayPayload, JobDTO, MemorySampleDTO, MinuteSessionDTO, MinutesOverview, MinutesPayload, ModelOfferDTO, SkillsPayload } from '../types.ts'
import type { RpcCall, RpcError } from './rpc.ts'
import { buildIndexCopy } from '../copy-index.ts'
import { PLUGIN_VERSION } from '../version.ts'
import { INTRO_EN, INTRO_ZH, PACKAGE_NAME, buildSharePrompt, buildSharePromptEn } from '../about.ts'
import { zh as ZH_DICT } from './labels.ts'
import { TimelineChart } from './timeline.tsx'
import type { TimelineRange } from './timeline.tsx'

/**
 * 尺寸只从根节点的 `--pl-*` 变量取，颜色只从 `--dsw-alias-*` 取。
 * 这样换主题时整块面板跟着变，也不会有写死的字号和色值漏出来。
 */
const FG = 'var(--dsw-alias-label-primary)'
const FG2 = 'var(--dsw-alias-label-secondary)'
const CAPTION = 'var(--dsw-alias-label-secondary)'
const BG = 'var(--dsw-alias-bg-base)'
const BG2 = 'var(--dsw-alias-bg-layer-2)'
const CARD = 'var(--dsw-alias-bg-layer-1)'
/** 区域内分隔线。卡片轮廓用 CARD_BORDER，别拿这条去画卡片。 */
const BORDER = 'var(--dsw-alias-border-l1)'
/** 卡片、提示条、独立块的轮廓，必须是 l2，否则和背景糊在一起。 */
const CARD_BORDER = 'var(--dsw-alias-border-l2)'
// 交互蓝走 state-business-*；brand-primary 是「最强对比前景色」（近黑/近白），
// 拿它当强调色会得到一屏近黑块。想要固定品牌色时把 --pl-brand 换成
// var(--dsw-static-deepseek-450) 即可，只有这一处要改。
const ACCENT = 'var(--pl-brand)'
const ACCENT_SOFT = 'var(--pl-brand-soft)'
const SURFACE_SOFT = 'var(--dsw-alias-bg-layer-2)'
const DANGER = 'var(--dsw-alias-state-error-primary)'
const WARN = 'var(--dsw-alias-state-warn-label)'
const SUCCESS = 'var(--dsw-alias-state-success-primary)'
const ON_ACCENT = 'var(--dsw-alias-label-on-color)'
const RADIUS = 'var(--pl-radius-card)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

const FS = {
  xs: 'var(--pl-fs-xs)',
  sm: 'var(--pl-fs-sm)',
  md: 'var(--pl-fs-md)',
  lg: 'var(--pl-fs-lg)',
  title: 'var(--pl-fs-title)',
  num: 'var(--pl-fs-num)',
} as const

const RADIUS_CHIP = 'var(--pl-radius-chip)'
const RADIUS_PILL = 'var(--pl-radius-pill)'

/** 面板根节点定义一次，子元素全部继承。 */
const tokenVars = {
  '--pl-fs-xs': '11px',
  '--pl-fs-sm': '12px',
  '--pl-fs-md': '13px',
  '--pl-fs-lg': '14px',
  '--pl-fs-title': '16px',
  '--pl-fs-num': '18px',
  '--pl-gap-1': '4px',
  '--pl-gap-2': '8px',
  '--pl-gap-3': '12px',
  '--pl-radius-card': '16px',
  '--pl-radius-chip': '10px',
  '--pl-radius-pill': '7px',
  '--pl-pad': '12px',
  // 交互蓝：跟随主题的官方蓝；淡蓝用于未选中数据与浅底。
  '--pl-brand': 'var(--dsw-alias-state-business-primary)',
  '--pl-brand-soft': 'var(--dsw-alias-state-business-tertiary)',
} as CSSProperties

const controlHeight = 24

const buttonStyle: CSSProperties = {
  font: 'inherit',
  fontSize: FS.xs,
  lineHeight: '16px',
  height: controlHeight,
  padding: '0 8px',
  borderRadius: RADIUS_CHIP,
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: FG2,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  boxSizing: 'border-box',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: ACCENT,
  borderColor: ACCENT,
  color: ON_ACCENT,
  fontWeight: 600,
}

const chipStyle = (active: boolean): CSSProperties => ({
  font: 'inherit',
  fontSize: FS.xs,
  padding: '1px 7px',
  borderRadius: RADIUS_PILL,
  border: `1px solid ${active ? ACCENT : BORDER}`,
  background: active ? ACCENT_SOFT : 'transparent',
  color: active ? ACCENT : FG2,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

const selectStyle: CSSProperties = {
  font: 'inherit',
  fontSize: FS.xs,
  lineHeight: '16px',
  height: controlHeight,
  padding: '0 6px',
  borderRadius: RADIUS_CHIP,
  border: `1px solid ${BORDER}`,
  background: BG,
  color: FG,
  boxSizing: 'border-box',
  minWidth: 0,
  maxWidth: 132,
}

const cardStyle: CSSProperties = {
  border: `1px solid ${CARD_BORDER}`,
  borderRadius: RADIUS,
  background: CARD,
  padding: '10px 12px',
  marginBottom: 8,
}

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: FS.sm,
  padding: '3px 6px',
  borderRadius: RADIUS_CHIP,
  border: `1px solid ${BORDER}`,
  background: BG,
  color: FG,
  width: '100%',
  boxSizing: 'border-box',
}

/** ISO 时间 → 当天第几分钟（本地时区）。 */
function minuteOfDay(iso: string): number {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 0
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
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
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(match[3]) / 60 : 0)
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null
}

function clockFromDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function liveWindow(windowRange: { start: number; end: number }): TimelineRange {
  const end = clamp(Math.max(clockNow(), windowRange.start + 1), windowRange.start + 1, windowRange.end)
  return { start: Math.max(windowRange.start, end - 120), end }
}

function clockNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
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

const TAB_KEY = 'dsh-mm-tab'
type PanelTab = 'today' | 'minutes' | 'background' | 'jobs' | 'asr' | 'speaker' | 'import' | 'about'
const TABS: PanelTab[] = ['today', 'minutes', 'background', 'jobs', 'asr', 'speaker', 'import', 'about']

/** 插件重载会让面板重建，把上次停留的标签页读回来，避免每次都跳回「今日」。 */
function readTab(): PanelTab {
  try {
    const saved = window.localStorage.getItem(TAB_KEY)
    if (saved && (TABS as string[]).includes(saved)) return saved as PanelTab
  } catch {
    // 隐私模式下读不到就用默认
  }
  return 'today'
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
  content: string
}

interface BackgroundEdit {
  id?: string
  title: string
  tags: string
  content: string
}

function sourceLabel(source: MinuteSessionDTO['source'], t: (key: string) => string): { label: string; color: string } {
  if (source === 'draft') return { label: t('panel.minutes.draft'), color: WARN }
  if (source === 'ai') return { label: t('panel.minutes.ai'), color: FG2 }
  if (source === 'agent') return { label: t('panel.minutes.agent'), color: FG2 }
  return { label: t('panel.minutes.manual'), color: FG2 }
}

export function Panel(props: PanelProps) {
  const { rpc, t } = props
  const [tab, setTab] = useState<PanelTab>(() => readTab())
  const [data, setData] = useState<DayPayload | null>(null)
  const [dataError, setDataError] = useState<RpcError | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [selection, setSelection] = useState<TimelineRange | null>(null)
  const [follow, setFollow] = useState(true)
  const [track, setTrack] = useState<'all' | 'mic' | 'system'>('all')
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
  const [skills, setSkills] = useState<SkillsPayload | null>(null)
  const [skillDraft, setSkillDraft] = useState<{ id?: string; name: string; description: string; prompt: string } | null>(null)
  const [minutesError, setMinutesError] = useState<RpcError | null>(null)
  const [minutesLoading, setMinutesLoading] = useState(false)
  const [jobs, setJobs] = useState<JobDTO[]>([])
  const [models, setModels] = useState<AsrModelsPayload | null>(null)
  const [modelPath, setModelPath] = useState('')
  const [asr, setAsr] = useState<AsrStatusDTO | null>(null)
  const [minutesMode, setMinutesMode] = useState<'week' | 'all' | 'day'>('week')
  const [minutesRange, setMinutesRange] = useState<MinutesRangeDTO | null>(null)
  const [expandedMinute, setExpandedMinute] = useState<string | null>(null)
  const [speaker, setSpeaker] = useState<SpeakerPayload | null>(null)
  const [spkStart, setSpkStart] = useState<number | null>(null)
  const [spkEnd, setSpkEnd] = useState<number | null>(null)
  const [spkLabel, setSpkLabel] = useState('')
  const [spkNote, setSpkNote] = useState('')
  const [spkView, setSpkView] = useState<'tag' | 'saved'>('tag')
  const [spkPicked, setSpkPicked] = useState<string[]>([])
  const [openLabel, setOpenLabel] = useState<string | null>(null)
  const [labelLines, setLabelLines] = useState<Record<string, Array<{ line: number; startAt: string; track: string; text: string; speaker?: string }>>>({})
  const [linePicked, setLinePicked] = useState<number[]>([])
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNote, setEditNote] = useState('')

  const toggleLabel = async (item: { id: string; day: string }) => {
    if (openLabel === item.id) {
      setOpenLabel(null)
      return
    }
    setOpenLabel(item.id)
    setLinePicked([])
    const result = await rpc<{ lines: Array<{ line: number; startAt: string; track: string; text: string; speaker?: string }> }>(
      'speaker.labelLines', { day: item.day, labelId: item.id },
    )
    if (result.ok) setLabelLines((previous) => ({ ...previous, [item.id]: result.value.lines }))
  }

  const saveLabelEdit = async (item: { id: string; day: string; label: string; note?: string }) => {
    const name = editName.trim()
    if (!name) {
      setNoticeError(t('panel.speaker.needLabel'))
      return
    }
    const result = await rpc<{ item: { label: string }; linesRenamed: number }>(
      'speaker.labelUpdate', { labelId: item.id, label: name, note: editNote },
    )
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setEditingLabel(null)
    setNotice(t('panel.speaker.labelUpdated'))
    void loadSpeaker()
    if (result.value.linesRenamed) void loadAssign(item.day)
  }

  const removePickedLines = async (item: { id: string; day: string }) => {
    if (!linePicked.length) return
    const result = await rpc<{ removed: number; cleared: number; remaining: number; deleted: boolean }>(
      'speaker.labelRemoveLines', { day: item.day, labelId: item.id, lines: linePicked },
    )
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    const dropped = new Set(linePicked)
    setLabelLines((previous) => ({
      ...previous,
      [item.id]: (previous[item.id] ?? []).filter((row) => !dropped.has(row.line)),
    }))
    setLinePicked([])
    setNotice(t('panel.speaker.linesRemoved').replace('{n}', String(result.value.removed)))
    void loadSpeaker()
    void loadAssign(item.day)
    if (result.value.deleted) setOpenLabel(null)
  }

  const removeLine = async (item: { id: string; day: string }, line: number) => {
    const result = await rpc<{ remaining: number; deleted: boolean }>('speaker.labelRemoveLine', { day: item.day, labelId: item.id, line })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setLabelLines((previous) => ({
      ...previous,
      [item.id]: (previous[item.id] ?? []).filter((row) => row.line !== line),
    }))
    setNotice(t('panel.speaker.lineRemoved'))
    void loadSpeaker()
    void loadAssign(item.day)
    if (result.value.deleted) setOpenLabel(null)
  }

  const [spkTrack, setSpkTrack] = useState<'all' | 'mic' | 'system'>('all')
  const [assign, setAssign] = useState<Record<string, { speaker: string; name?: string; track: string }>>({})
  const loadAssignRef = useRef<(day: string) => Promise<void>>(async () => {})
  const [, setTick] = useState(0)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [confirmId, setConfirmId] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [panelWidth, setPanelWidth] = useState(0)

  const followRef = useRef(true)
  const selectionRef = useRef<TimelineRange | null>(null)
  const dayRef = useRef('')
  const loadDayRef = useRef<(target?: string, forceServerSelection?: boolean) => Promise<void>>(async () => {})
  const listRef = useRef<HTMLDivElement | null>(null)
  // 用户手动往上翻之后就不再自动跳到最新
  const [followLatest, setFollowLatest] = useState(true)
  const [chartHeight, setChartHeight] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('dsh-mm-chart-height'))
      if (Number.isFinite(saved) && saved >= 80 && saved <= 420) return Math.round(saved)
    } catch {
      // 隐私模式下拿不到 localStorage
    }
    return 150
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, tab)
    } catch {
      // 存不下来就只在本次会话生效
    }
  }, [tab])

  const [demoMode, setDemoMode] = useState(() => isDemoActive())
  const [memoryDay, setMemoryDay] = useState<{ minute: number; occupied: number; heap: number; audio: number; fixed: number; mapped: number }[]>([])
  const [storage, setStorage] = useState<{ audio: { files: number; bytes: number; days: Array<{ day: string; files: number; bytes: number }> }; backups: { files: number; bytes: number } } | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const [importItems, setImportItems] = useState<Array<{ id: string; name: string; durationSec: number; status: string; snippets: number; processedSec: number; error?: string; minutesAt?: string }>>([])
  const [importSel, setImportSel] = useState<string | null>(null)
  const [importDetail, setImportDetail] = useState<{ meta: { id: string; name: string; durationSec: number; status: string; snippets: number; error?: string }; snippets: Array<{ startSec: number; endSec: number; text: string }>; buckets: Array<{ m: number; s: number }>; minutes: string | null } | null>(null)
  const [importPath, setImportPath] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importGenerating, setImportGenerating] = useState(false)
  const [importRange, setImportRange] = useState<{ start: number; end: number } | null>(null)

  const loadImports = useCallback(async () => {
    const result = await rpc<{ items: typeof importItems }>('imports.list')
    if (result.ok) setImportItems(result.value.items)
  }, [rpc])

  const loadImportDetail = useCallback(async (id: string) => {
    const result = await rpc<NonNullable<typeof importDetail>>('imports.get', { id })
    if (result.ok) setImportDetail(result.value)
  }, [rpc])

  useEffect(() => {
    if (tab !== 'import') return
    void loadImports()
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadImports()
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [tab, loadImports])

  // 详情单独轮询：任务转写中要能实时看到新句子
  useEffect(() => {
    if (tab !== 'import' || !importSel) return
    void loadImportDetail(importSel)
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadImportDetail(importSel)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [tab, importSel, loadImportDetail])

  /** 弹系统选择框，选中的文件依次入队转写。 */
  const pickAndImport = async () => {
    setImportBusy(true)
    setNoticeError('')
    try {
      const picked = await rpc<{ paths: string[] }>('imports.pick', {})
      if (!picked.ok) {
        setNoticeError(picked.error.message)
        return
      }
      const paths = picked.value.paths
      if (!paths.length) return
      let duplicated = 0
      let lastId: string | null = null
      for (const file of paths) {
        const result = await rpc<{ meta: { id: string }; duplicated: boolean }>('imports.start', { path: file })
        if (!result.ok) {
          setNoticeError(result.error.message)
          continue
        }
        if (result.value.duplicated) duplicated += 1
        lastId = result.value.meta.id
      }
      await loadImports()
      if (lastId) {
        setImportSel(lastId)
        await loadImportDetail(lastId)
      }
      if (duplicated) setNotice(t('panel.import.duplicatedCount').replace('{n}', String(duplicated)))
    } finally {
      setImportBusy(false)
    }
  }

  const startImport = async () => {
    const file = importPath.trim()
    if (!file) {
      setNoticeError(t('panel.import.needPath'))
      return
    }
    setImportBusy(true)
    setNoticeError('')
    try {
      const result = await rpc<{ meta: { id: string }; duplicated: boolean }>('imports.start', { path: file })
      if (!result.ok) {
        setNoticeError(result.error.hint ? `${result.error.message} · ${result.error.hint}` : result.error.message)
        return
      }
      if (result.value.duplicated) setNotice(t('panel.import.duplicated'))
      setImportPath('')
      await loadImports()
      setImportSel(result.value.meta.id)
      setImportRange(null)
      await loadImportDetail(result.value.meta.id)
    } finally {
      setImportBusy(false)
    }
  }

  const cancelImport = async (id: string) => {
    await rpc('imports.cancel', { id })
    await loadImports()
  }

  const deleteImport = async (id: string) => {
    const result = await rpc<{ deleted: boolean }>('imports.delete', { id })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    if (importSel === id) {
      setImportSel(null)
      setImportDetail(null)
    }
    await loadImports()
  }

  const generateImportMinutes = async () => {
    if (!importSel) return
    setImportGenerating(true)
    setNoticeError('')
    try {
      const range = importRange
      const result = await rpc<{ markdown: string }>('imports.generate', {
        id: importSel,
        ...(range ? { startSec: range.start, endSec: range.end } : {}),
      })
      if (!result.ok) {
        setNoticeError(result.error.message)
        return
      }
      setNotice(t('panel.import.generated'))
      await loadImportDetail(importSel)
      await loadImports()
    } finally {
      setImportGenerating(false)
    }
  }

  const loadStorage = useCallback(async () => {
    const result = await rpc<{ audio: { files: number; bytes: number; days: Array<{ day: string; files: number; bytes: number }> }; backups: { files: number; bytes: number } }>('asr.storage', {})
    if (result.ok) setStorage(result.value)
  }, [rpc])

  const cleanAudio = async (olderThanDays: number) => {
    setCleaning(true)
    setNoticeError('')
    try {
      const result = await rpc<{ removed: number; freed: number }>('asr.cleanup', { olderThanDays })
      if (!result.ok) {
        setNoticeError(result.error.message)
        return
      }
      setNotice(t('panel.asr.storage.cleaned')
        .replace('{n}', String(result.value.removed))
        .replace('{s}', formatBytes(result.value.freed, true)))
      await loadStorage()
    } finally {
      setCleaning(false)
    }
  }

  const [hbRange, setHbRange] = useState<'minute' | 'hour' | 'day'>('hour')
  const [hbDay, setHbDay] = useState<{ points: Array<{ minute: number; state: 'ok' | 'idle' | 'gap'; speech: number; snippets: number }>; summary: { total: number; ok: number; idle: number; gap: number } } | null>(null)

  const loadHeartbeatDay = useCallback(async (range: 'minute' | 'hour' | 'day') => {
    const result = await rpc<{ points: Array<{ minute: number; state: 'ok' | 'idle' | 'gap'; speech: number; snippets: number }>; summary: { total: number; ok: number; idle: number; gap: number } }>('asr.heartbeat', { range })
    if (result.ok) setHbDay({ points: result.value.points, summary: result.value.summary })
  }, [rpc])

  useEffect(() => {
    if (tab !== 'asr') return
    void loadStorage()
    void loadHeartbeatDay(hbRange)
    const timer = window.setInterval(() => { void loadHeartbeatDay(hbRange) }, 60_000)
    return () => window.clearInterval(timer)
  }, [tab, loadHeartbeatDay, hbRange])
  const [memoryRange, setMemoryRange] = useState<'minute' | 'hour' | 'day'>('hour')

  const loadMemoryDay = useCallback(async (range: 'minute' | 'hour' | 'day') => {
    const result = await rpc<{ day: string; samples: Array<{ minute: number; occupied: number; heap: number; audio: number; fixed: number; mapped: number }> }>('asr.memory', { range })
    if (result.ok) setMemoryDay(result.value.samples)
  }, [rpc])

  useEffect(() => {
    if (tab !== 'asr') return
    void loadMemoryDay(memoryRange)
    const timer = window.setInterval(() => { void loadMemoryDay(memoryRange) }, 60_000)
    return () => window.clearInterval(timer)
  }, [tab, loadMemoryDay, memoryRange])

  const [update, setUpdate] = useState<UpdateStatusDTO | null>(null)
  const [updateHidden, setUpdateHidden] = useState(false)
  const [updating, setUpdating] = useState(false)
  const flashTimer = useRef<number | null>(null)
  const seenDoneJobs = useRef<Set<string>>(new Set())
  const jobsSeeded = useRef(false)
  const minutesModeRef = useRef<'week' | 'all' | 'day'>('week')
  const refreshRangeRef = useRef<(mode: 'week' | 'all') => Promise<void>>(async () => {})

  followRef.current = follow
  minutesModeRef.current = minutesMode
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
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const anyActive = jobs.some((job) => job.status === 'queued' || job.status === 'running')
  useEffect(() => {
    if (!anyActive) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [anyActive])

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
    const reset = forceServerSelection || selectionRef.current === null
    if (followRef.current && payload.day === payload.today) {
      setSelection(liveWindow(payload.window))
      setFollow(true)
    } else if (reset) {
      setSelection(payload.selection)
      setFollow(payload.day === payload.today)
    } else if (payload.day !== dayRef.current) {
      setSelection(payload.selection)
      setFollow(payload.day === payload.today)
    } else if (payload.day === payload.today && selectionRef.current) {
      const now = clockNow()
      const end = selectionRef.current.end
      if (end >= now - 3) {
        setSelection({ start: selectionRef.current.start, end: Math.max(end, Math.min(payload.window.end, now + 1)) })
      }
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
      // 实时说话人识别是后台写文件的，刷新时把分配表一起拉一次
      const day = dayRef.current
      if (day) void loadAssignRef.current(day)
    }
    const timer = window.setInterval(refresh, 5_000)
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
      setNoticeError(t('panel.background.required'))
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
      setNoticeError(result.error.message)
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
      setNoticeError(result.error.message)
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
    if (tab !== 'minutes') return
    const timer = window.setInterval(() => {
      const target = dayRef.current
      if (!target) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadMinutes(target)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [tab, loadMinutes])

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
    if (kind === 'all') {
      const range = { start: data.window.start, end: data.window.end }
      setFollow(false)
      setSelection(range)
      persistSelection(range)
      return
    }
    const following = data.day === data.today
    const range = following ? liveWindow(data.window) : { start: Math.max(data.window.start, lastDataMinute(data) - 120), end: lastDataMinute(data) }
    setFollow(following)
    setSelection(range)
    persistSelection(range)
  }

  useEffect(() => {
    if (!follow || data?.day !== data?.today) return
    const slide = (): void => {
      if (!followRef.current) return
      setSelection(liveWindow(windowRange))
    }
    slide()
    const timer = window.setInterval(slide, 1_000)
    return () => window.clearInterval(timer)
  }, [follow, data?.day, data?.today, windowRange])

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const measure = (): void => setPanelWidth(Math.round(element.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

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

  // 最新的在最上面：取最近 700 条再倒序
  const visibleSegments = segments.slice(-700).reverse()
  const segmentChars = segments.reduce((sum, segment) => sum + segment.text.length, 0)
  const selectionMinutes = Math.max(0, Math.round(activeSelection.end - activeSelection.start))

  useEffect(() => {
    const list = listRef.current
    if (!list || !followLatest) return
    // 倒序展示后新内容出现在顶部；只有跟随时才自动回到顶部
    list.scrollTop = 0
  }, [activeSelection.start, activeSelection.end, track, segments.length, data?.day, data?.today, followLatest])

  // 换天或换选区时重新跟随
  useEffect(() => {
    setFollowLatest(true)
  }, [data?.day])

  // 复制出去仍按时间正序，方便阅读和喂给模型
  const transcriptText = useMemo(() => segments.slice(-700)
    .map((segment) => `[${clock(segment.s, true)}] ${trackName(segment.track, t)}：${segment.text}`)
    .join('\n'), [segments, t])

  /** 本地资源：交给主进程在访达里打开（file:// 在 http 页面里会被拦截）。 */
  const revealPath = async (target: string) => {
    const result = await rpc<{ opened: string; kind: string }>('system.reveal', { path: target })
    if (!result.ok) setNoticeError(result.error.message)
  }

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
    const source = (data.sources ?? []).find((item) => item.root === data.root)
    const text = buildIndexCopy({
      day: data.day,
      file: data.filePaths?.snippets ?? `${data.root}/${data.day}/snippets.jsonl`,
      sourceLabel: source?.label ?? '当前日志',
      segments: segments.map((segment) => ({ s: segment.s, e: segment.e, ...(segment.line ? { line: segment.line } : {}), ...(segment.lines?.length ? { lines: segment.lines } : {}) })),
      selection: activeSelection,
      trackLabel: track === 'all' ? t('panel.filter.all') : t(`panel.filter.${track}`),
      filtered: track !== 'all',
      backgrounds: backgrounds
        .filter((card) => bgSelection.includes(card.id))
        .map((card) => ({ title: card.title, tags: card.tags, content: card.content })),
    })
    void copyText(text, 'index')
  }

  const applyJobs = useCallback((next: JobDTO[]) => {
    if (!jobsSeeded.current) {
      for (const job of next) {
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') seenDoneJobs.current.add(job.id)
      }
      jobsSeeded.current = true
      setJobs(next)
      return
    }
    setJobs(next)
    const finished = next.filter((job) => job.status === 'done' && !seenDoneJobs.current.has(job.id))
    for (const job of next) {
      if (job.status !== 'queued' && job.status !== 'running') seenDoneJobs.current.add(job.id)
    }
    if (finished.length) {
      // 不管是谁触发的（面板按钮 / 别的会话的 agent），生成完都刷新：
      // 当天的纪要 + 今日页 + 「最近一周 / 全部」那份列表都要重新拉
      const target = finished[0].day || dayRef.current
      if (target) void loadMinutes(target)
      if (target && target !== dayRef.current) void loadDay(target)
      const mode = minutesModeRef.current
      if (mode !== 'day') void refreshRangeRef.current(mode)
    }
  }, [loadMinutes, loadDay])

  useEffect(() => {
    try {
      window.localStorage.setItem('dsh-mm-chart-height', String(chartHeight))
    } catch {
      // 存不下来就只在本次会话生效
    }
  }, [chartHeight])

  useEffect(() => {
    let alive = true
    void rpc<UpdateStatusDTO>('update.check', {}).then((result) => {
      if (!alive || !result.ok) return
      setUpdate(result.value)
    })
    return () => { alive = false }
  }, [rpc])

  const applyUpdateNow = async () => {
    setUpdating(true)
    setNoticeError('')
    try {
      const result = await rpc<{ ok: boolean; output: string }>('update.apply', {})
      if (!result.ok) {
        setNoticeError(result.error.message)
        return
      }
      if (!result.value.ok) {
        setNoticeError(result.value.output || t('panel.update.failed'))
        return
      }
      setNotice(t('panel.update.done'))
      setUpdateHidden(true)
      void rpc<UpdateStatusDTO>('update.check', { force: true }).then((next) => {
        if (next.ok) setUpdate(next.value)
      })
    } finally {
      setUpdating(false)
    }
  }

  const loadJobs = useCallback(async () => {
    const result = await rpc<{ jobs: JobDTO[] }>('jobs.list')
    if (!result.ok) return
    applyJobs(result.value.jobs)
  }, [rpc, applyJobs])

  useEffect(() => {
    void loadJobs()
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadJobs()
    }, anyActive ? 2_000 : 15_000)
    return () => window.clearInterval(timer)
  }, [loadJobs, anyActive])

  const loadSkills = useCallback(async () => {
    const result = await rpc<SkillsPayload>('skills.list')
    if (result.ok) setSkills(result.value)
  }, [rpc])

  useEffect(() => { void loadSkills() }, [loadSkills])

  const loadAssign = useCallback(async (day: string) => {
    const result = await rpc<{ day: string; map: Record<string, { speaker: string; name?: string; track: string }> }>(
      'speaker.assignments', { day },
    )
    if (result.ok) setAssign(result.value.map ?? {})
  }, [rpc])

  useEffect(() => {
    loadAssignRef.current = loadAssign
  }, [loadAssign])

  useEffect(() => {
    if (!data?.day) return
    void loadAssign(data.day)
  }, [data?.day, loadAssign])

  const loadRange = useCallback(async (mode: 'week' | 'all') => {
    const result = await rpc<MinutesRangeDTO>('minutes.range', { mode })
    if (result.ok) setMinutesRange(result.value)
  }, [rpc])
  refreshRangeRef.current = loadRange


  useEffect(() => {
    if (tab !== 'minutes' || minutesMode === 'day') return
    void loadRange(minutesMode)
  }, [tab, minutesMode, loadRange])

  const loadSpeaker = useCallback(async () => {
    const result = await rpc<SpeakerPayload>('speaker.list')
    if (result.ok) setSpeaker(result.value)
  }, [rpc])

  useEffect(() => {
    if (tab !== 'speaker') return
    void loadSpeaker()
    // 定时刷新：打标、重算、采样数变化都靠它自愈，不用手动切标签
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadSpeaker()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [tab, loadSpeaker])

  /** 选区范围；没点「开始」时用最近 10 分钟做默认。 */
  /**
   * 说话人页的默认区间：跟着「最后一条数据」走，而不是跟着当前时钟。
   * 否则看历史日期、或者演示数据不在当前时段时，页面会一片空白。
   */
  const speakerRange = () => {
    const now = clockNow()
    const last = data ? Math.max(lastDataMinute(data), data.window.start) : now
    const isToday = Boolean(data && data.day === data.today)
    const windowStart = data?.window.start ?? 0
    const windowEnd = data?.window.end ?? 1440
    // 默认跟「今日」一致：整天；当天还没到中午时先给最近 2 小时（那会儿数据太少）
    const early = isToday && now < 12 * 60
    const fallbackStart = early ? Math.max(windowStart, last - 120) : windowStart
    const fallbackEnd = early ? Math.max(now, last, fallbackStart + 1) : windowEnd
    return {
      start: spkStart ?? fallbackStart,
      end: spkEnd ?? fallbackEnd,
    }
  }

  /** 选区内的转写行；勾选打标用。 */
  const speakerRows = () => {
    const range = speakerRange()
    return (data?.segments ?? [])
      .filter((segment) => segment.e > range.start && segment.s < range.end)
      .filter((segment) => spkTrack === 'all' || segment.track === spkTrack)
      .reverse()
  }

  // 不依赖数组下标：拖选时算出来的 key 必须和渲染出来的对得上
  const rowKey = (segment: { line?: number; lines?: number[]; s: number; e: number }): string =>
    String(segment.line ?? segment.lines?.[0] ?? `${segment.s}-${segment.e}`)

  /**
   * 选区内的句子默认全选，但只勾当前轨道筛选下看得到的那些：
   * 选「麦克风」时就不会把同时段的系统声音（别人说话）一起勾进来。
   */
  const pickRowsInRange = (start: number, end: number) => {
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    const rows = (data?.segments ?? []).filter((segment) => (
      segment.e > from && segment.s < to && (spkTrack === 'all' || segment.track === spkTrack)
    ))
    setSpkPicked(rows.map((segment) => rowKey(segment)))
  }

  const togglePick = (key: string) => {
    setSpkPicked((previous) => (previous.includes(key)
      ? previous.filter((item) => item !== key)
      : [...previous, key]))
  }

  const saveSpeaker = async () => {
    if (!data) return
    const label = spkLabel.trim()
    if (!label) {
      setNoticeError(t('panel.speaker.needLabel'))
      return
    }
    const rows = speakerRows()
    const picked = spkPicked.length
      ? rows.filter((segment) => spkPicked.includes(rowKey(segment)))
      : []
    let start: number
    let end: number
    let lines: number[] = []
    if (picked.length) {
      start = Math.min(...picked.map((segment) => segment.s))
      end = Math.max(...picked.map((segment) => segment.e))
      lines = [...new Set(picked.flatMap((segment) => segment.lines ?? (segment.line ? [segment.line] : [])))].sort((a, b) => a - b)
    } else if (spkStart !== null && spkEnd !== null) {
      start = Math.min(spkStart, spkEnd)
      end = Math.max(spkStart, spkEnd)
    } else {
      setNoticeError(t('panel.speaker.needRange'))
      return
    }
    const result = await rpc<{ item: unknown; total: number; applied?: number }>('speaker.add', {
      item: {
        day: data.day,
        start,
        end,
        label,
        note: spkNote.trim(),
        ...(lines.length ? { lines } : {}),
      },
    })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setNoticeError('')
    setSpkStart(null)
    setSpkEnd(null)
    setSpkPicked([])
    setSpkLabel('')
    setSpkNote('')
    const applied = result.ok ? (result.value.applied ?? 0) : 0
    setNotice(applied > 0 ? `已保存标签，并把这 ${applied} 句标记为「${label}」` : t('panel.speaker.saved'))
    void loadSpeaker()
    // 标签回填会写分配表：重新拉分配表 + 当天数据，刚打标的行立刻显示名字
    if (data?.day) void loadAssignRef.current(data.day)
    void loadDayRef.current(dayRef.current || undefined)
  }

  const [rebuilding, setRebuilding] = useState(false)

  /** 用已登记的声纹把当天整天的转写重判一遍；今日页读同一份分配，所以一起生效。 */
  const rebuildSpeakers = async () => {
    if (!data) return
    setRebuilding(true)
    setNoticeError('')
    try {
      const result = await rpc<{ day: string; withEmbedding: number; matched: number; names: Record<string, number>; enrolled: number }>(
        'speaker.rebuild', { day: data.day },
      )
      if (!result.ok) {
        setNoticeError(result.error.hint ? `${result.error.message} · ${result.error.hint}` : result.error.message)
        return
      }
      const value = result.value
      const parts = Object.entries(value.names).map(([name, count]) => `${name} ${count}`).join('、')
      setNotice(t('panel.speaker.rebuilt')
        .replace('{m}', String(value.matched))
        .replace('{t}', String(value.withEmbedding))
        .replace('{e}', String(value.enrolled))
        + (parts ? ` · ${parts}` : ''))
      void loadAssign(value.day)
      void loadSpeaker()
    } finally {
      setRebuilding(false)
    }
  }

  const enrollRecent = async () => {
    const name = spkLabel.trim()
    if (!name) {
      setNoticeError(t('panel.speaker.needLabel'))
      return
    }
    const result = await rpc<{ samples: number }>('speaker.enrollRecent', {
      day: data?.day,
      label: name,
      count: 3,
    })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setNoticeError('')
    setNotice(t('panel.speaker.enrolled').replace('{n}', String(result.value.samples)))
    setSpkLabel('')
    void loadSpeaker()
  }

  /** 复制纪要时连带原文索引（文件 + 行号），方便回头查原话。 */
  const copySession = async (session: MinuteSessionDTO, day: string, key: string) => {
    const body = sessionBody(session as unknown as Record<string, unknown>)
    const head = `## ${clock(session.start)}–${clock(session.end)} · ${session.topic}\n\n${body}\n`
    const index = await rpc<{ text: string }>('minutes.index', { day, start: session.start, end: session.end })
    const text = index.ok && index.value.text ? `${head}\n---\n${index.value.text}\n` : head
    void copyText(text, key)
  }

  const deleteSpeaker = async (id: string) => {
    const result = await rpc('speaker.delete', { id })
    if (!result.ok) setNoticeError(result.error.message)
    else void loadSpeaker()
  }

  const generateDraft = async () => {
    if (!data) return
    if (!skills?.selectedId) {
      setNoticeError(t('panel.skill.required'))
      return
    }
    const range = { start: activeSelection.start, end: activeSelection.end }
    const backgroundIds = bgSelection.filter((id) => backgrounds.some((card) => card.id === id))
    const result = await rpc<{ job: JobDTO }>('jobs.start', {
      day: data.day,
      start: range.start,
      end: range.end,
      skillId: skills.selectedId,
      ...(backgroundIds.length ? { backgroundIds } : {}),
    })
    if (!result.ok) {
      setNoticeError(result.error.hint ? `${result.error.message} · ${result.error.hint}` : result.error.message)
      return
    }
    setJobs((previous) => [result.value.job, ...previous.filter((job) => job.id !== result.value.job.id)].slice(0, 40))
    // 立刻给一句反馈，别等轮询
    setNoticeError('')
    setNotice(t('panel.jobs.started'))
    void loadJobs()
  }

  const saveSkillDraft = async () => {
    if (!skillDraft) return
    const result = await rpc<SkillsPayload>('skills.save', { ...skillDraft, select: true })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setSkills(result.value)
    setSkillDraft(null)
  }

  const removeSkill = async (id: string) => {
    const result = await rpc<SkillsPayload>('skills.delete', { id })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setSkills(result.value)
  }

  const cancelJob = async (id: string) => {
    const result = await rpc<{ job: JobDTO }>('jobs.cancel', { id })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setJobs((previous) => previous.map((job) => (job.id === id ? result.value.job : job)))
  }

  const loadModels = useCallback(async () => {
    const result = await rpc<AsrModelsPayload>('models.list')
    if (result.ok) setModels(result.value)
  }, [rpc])

  const loadAsr = useCallback(async () => {
    const result = await rpc<AsrStatusDTO>('asr.status')
    if (result.ok) setAsr(result.value)
  }, [rpc])

  useEffect(() => {
    void loadModels()
    void loadAsr()
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadAsr()
      void loadModels()
    }, 4_000)
    return () => window.clearInterval(timer)
  }, [loadModels, loadAsr])


  const addModel = async (modelPathValue: string) => {
    const trimmed = modelPathValue.trim()
    if (!trimmed) return
    const result = await rpc<AsrModelsPayload>('models.add', { path: trimmed })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setModels(result.value)
    setModelPath('')
    void loadAsr()
  }

  const selectModel = async (id: string) => {
    const result = await rpc<AsrModelsPayload>('models.select', { id })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setModels(result.value)
    void loadAsr()
  }

  // 下载完成后，如果下的是 SenseVoice int8，就顺手切过去。
  useEffect(() => {
    const job = (models?.downloads ?? []).find((item) => item.id === 'sensevoice-small')
    if (!job || job.status !== 'done') return
    const target = (models?.models ?? []).find((item) => /sensevoice/i.test(item.name) && item.kind !== 'coreml-sensevoice')
    if (target && target.id !== models?.selectedId && target.usable) void selectModel(target.id)
  }, [models, selectModel])

  const downloadModel = async (id: string) => {
    const result = await rpc<AsrModelsPayload>('models.download', { id })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setModels(result.value)
  }




  const setAsrEnabled = async (enabled: boolean) => {
    const result = await rpc<AsrStatusDTO>('asr.set', { enabled })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setAsr(result.value)
  }

  const setAsrLanguage = async (language: 'zhen' | 'zh' | 'en' | 'auto') => {
    const result = await rpc<AsrStatusDTO>('asr.set', { language })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setAsr(result.value)
  }

  const [restartingAsr, setRestartingAsr] = useState(false)

  const restartAsr = async () => {
    setRestartingAsr(true)
    setNoticeError('')
    try {
      const result = await rpc<AsrStatusDTO>('asr.restart', {})
      if (!result.ok) {
        setNoticeError(result.error.message)
        return
      }
      setAsr(result.value)
      setNotice(t('panel.asr.hb.restarted'))
    } finally {
      setRestartingAsr(false)
    }
  }

  const setAsrInput = async (uid: string) => {
    const result = await rpc<AsrStatusDTO>('asr.set', { input: uid })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setAsr(result.value)
  }

  const setAsrMode = async (mode: AsrStatusDTO['mode']) => {
    const result = await rpc<AsrStatusDTO>('asr.set', { mode })
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setAsr(result.value)
  }

  const clearFinishedJobs = async () => {
    const result = await rpc<{ jobs: JobDTO[] }>('jobs.clear')
    if (!result.ok) {
      setNoticeError(result.error.message)
      return
    }
    setJobs(result.value.jobs)
  }

  const saveSession = async () => {
    if (!data || !editing) return
    const start = parseClockInput(editing.start)
    const end = parseClockInput(editing.end)
    if (start === null || end === null) {
      setNoticeError(`${t('panel.minutes.start')} / ${t('panel.minutes.end')} 用 HH:mm`)
      return
    }
    const session = {
      id: editing.id,
      start: Math.min(start, end),
      end: Math.max(start, end),
      topic: editing.topic.trim(),
      content: editing.content,
    }
    const result = await rpc<MinutesPayload>('minutes.upsert', { day: data.day, session })
    if (!result.ok) {
      setNoticeError(result.error.message)
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
      setNoticeError(result.error.message)
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
      content: session.content ?? '',
    })
    setConfirmId('')
  }

  const startAdd = () => {
    setEditing({
      start: clock(activeSelection.start),
      end: clock(activeSelection.end),
      topic: '',
      content: '',
    })
    setConfirmId('')
  }

  const renderError = (error: RpcError, retry: () => void) => (
    <div style={cardStyle}>
      <div style={{ color: DANGER, fontWeight: 600, fontSize: FS.sm, marginBottom: 3 }}>{t('panel.error')}</div>
      <div style={{ fontSize: FS.xs, lineHeight: 1.5 }}>{error.message}</div>
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
      <textarea
        style={{ ...inputStyle, marginBottom: 6, resize: 'vertical', lineHeight: 1.6, minHeight: 320, fontFamily: MONO, fontSize: FS.xs }}
        rows={Math.max(14, state.content.split('\n').length)}
        value={state.content}
        placeholder={t('panel.minutes.contentHint')}
        onChange={(event) => setEditing({ ...state, content: event.target.value })}
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
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        <PageHeader
          title={t('panel.tab.background')}
          meta={bgSelection.length
            ? `${t('panel.generate.count').replace('{n}', String(bgSelection.length))} · ${t('panel.background.total').replace('{n}', String(backgrounds.length))}`
            : t('panel.background.total').replace('{n}', String(backgrounds.length))}
          hint={t('panel.background.hint')}
          actions={(
            <>
              {bgLoading ? <span style={smallStyle}>{t('panel.loading')}</span> : null}
              <button type="button" style={primaryButtonStyle} onClick={startAddBackground}>{t('panel.background.add')}</button>
            </>
          )}
        />
        {bgError ? renderError(bgError, () => void loadBackgrounds()) : null}
        {renderNotices()}
        {bgEditing && !bgEditing.id ? renderBackgroundEditor(bgEditing) : null}
        {allTags.length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginBottom: 7 }}>
            <span style={smallStyle}>{t('panel.background.filter')}</span>
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
              <div style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr) auto', columnGap: 8, alignItems: 'start' }}>
                <input
                  type="checkbox"
                  checked={bgSelection.includes(card.id)}
                  onChange={() => toggleBgSelection(card.id)}
                  title={t('panel.generate.background')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: FS.sm, fontWeight: 600, wordBreak: 'break-word' }}>{card.title}</div>
                  {card.tags.length ? (
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
                      {card.tags.map((tag) => (
                        <span
                          key={tag}
                          style={{ fontSize: FS.xs, padding: '0 5px', borderRadius: RADIUS_PILL, border: `1px solid ${BORDER}`, color: CAPTION }}
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
                fontSize: FS.xs,
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

  const renderSpeaker = () => {
    const onToday = Boolean(data && data.day === data.today)
    const now = clockNow()
    // 默认区间必须和 speakerRange() 一致：整天；12 点前先给最近 2 小时
    const range = speakerRange()
    const minutes = Math.max(0, Math.round(range.end - range.start))
    const bucketsInRange = (data?.buckets ?? []).filter((bucket) => (
      bucket.m >= Math.floor(range.start) && bucket.m < Math.ceil(range.end)
    ))
    const capturedMinutes = bucketsInRange.length
    const speechMinutes = bucketsInRange.reduce((sum, bucket) => sum + Math.max(0, bucket.s), 0) / 60
    // 渲染走这里，必须和 speakerRows() 用同一个轨道筛选，否则按钮点了列表不变
    const rows = (data?.segments ?? [])
      .filter((segment) => segment.e > range.start && segment.s < range.end)
      .filter((segment) => spkTrack === 'all' || segment.track === spkTrack)
      .reverse()
    const groups = speaker?.groups ?? []
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: '0 0 auto', padding: '6px 10px 0' }}>
          <RangeSelector
            t={t}
            buckets={data?.buckets ?? []}
            windowStart={data?.window.start ?? 0}
            windowEnd={data?.window.end ?? 1440}
            selection={range}
            now={onToday ? now : null}
            minutes={minutes}
            captureMinutes={capturedMinutes}
            speechMinutes={speechMinutes}
            onDraft={(next) => { setSpkStart(next.start); setSpkEnd(next.end) }}
            onCommit={(next) => {
              setSpkStart(next.start)
              setSpkEnd(next.end)
              // 拖完选区，范围内的句子默认全选——打标通常就是「这段都是这个人」
              pickRowsInRange(next.start, next.end)
            }}
            onLast2h={() => {
              setSpkStart(Math.max(data?.window.start ?? 0, clockNow() - 120))
              setSpkEnd(clockNow())
            }}
            onAll={() => {
              if (!data) return
              setSpkStart(data.window.start)
              setSpkEnd(data.window.end)
            }}
            last2hDisabled={!onToday}
            allDisabled={!data}
            height={chartHeight}
            onResize={setChartHeight}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={!onToday}
              onClick={() => { setSpkStart(clockNow()); setSpkEnd(null) }}
            >{t('panel.speaker.markStart')}</button>
            <button
              type="button"
              style={buttonStyle}
              disabled={!onToday || spkStart === null}
              onClick={() => {
                const end = clockNow()
                setSpkEnd(end)
                if (spkStart !== null) pickRowsInRange(spkStart, end)
              }}
            >{t('panel.speaker.markEnd')}</button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => { setSpkStart(null); setSpkEnd(null) }}
            >{t('panel.speaker.reset')}</button>
            <span style={{ flex: '1 1 auto' }} />
            <button
              type="button"
              style={{ ...buttonStyle, borderColor: ACCENT, color: ACCENT }}
              disabled={rebuilding}
              title={t('panel.speaker.rebuildHint')}
              onClick={() => void rebuildSpeakers()}
            >
              {rebuilding ? t('panel.speaker.rebuilding') : t('panel.speaker.rebuild')}
            </button>
          </div>
          <div style={{ ...smallStyle, marginBottom: 6, lineHeight: 1.5 }}>{t('panel.speaker.rebuildHint')}</div>
        </div>

        <div style={{ flex: '0 0 auto', padding: '0 10px 6px', display: 'flex', gap: 6, alignItems: 'center', borderBottom: `1px solid ${BORDER}` }}>
          <button type="button" style={chipStyle(spkView === 'tag')} onClick={() => setSpkView('tag')}>{t('panel.speaker.viewTag')}</button>
          <button type="button" style={chipStyle(spkView === 'saved')} onClick={() => setSpkView('saved')}>
            {t('panel.speaker.viewSaved')} {speaker?.total ? ` ${speaker.total}` : ''}
          </button>
        </div>

        {spkView === 'tag' ? (
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px 16px' }}>
            <div style={{ ...cardStyle }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ ...smallStyle, fontWeight: 600 }}>{t('panel.speaker.label')}</span>
                <input
                  style={{ ...inputStyle, flex: '1 1 140px', minWidth: 0 }}
                  value={spkLabel}
                  placeholder={t('panel.speaker.labelHint')}
                  onChange={(event) => setSpkLabel(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void saveSpeaker() }}
                />
                <input
                  style={{ ...inputStyle, flex: '1 1 120px', minWidth: 0 }}
                  value={spkNote}
                  placeholder={t('panel.speaker.note')}
                  onChange={(event) => setSpkNote(event.target.value)}
                />
                <button type="button" style={primaryButtonStyle} onClick={() => void saveSpeaker()}>
                  {t('panel.speaker.save')}
                </button>
                <button type="button" style={buttonStyle} onClick={() => void enrollRecent()}>
                  {t('panel.speaker.enrollRecent')}
                </button>
              </div>
              {/* 勾选工具：常驻，全选只作用于当前筛选下看得见的行 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <span style={{ ...smallStyle, color: spkPicked.length ? ACCENT : CAPTION }}>
                  {t('panel.speaker.picked').replace('{n}', String(spkPicked.length))}
                </span>
                <button type="button" style={buttonStyle} onClick={() => setSpkPicked(rows.map((segment) => rowKey(segment)))}>
                  {t('panel.speaker.pickAll')}
                </button>
                <button type="button" style={buttonStyle} disabled={!spkPicked.length} onClick={() => setSpkPicked([])}>
                  {t('panel.speaker.pickNone')}
                </button>
              </div>
              {renderNotices()}
              <div style={{ ...smallStyle, marginTop: 6, lineHeight: 1.5 }}>{t('panel.speaker.hint')}</div>
            </div>

            {/* 轨道筛选：放在打标模块下方，紧贴要筛选的列表 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0 2px' }}>
              {(['all', 'mic', 'system'] as const).map((key) => (
                <button key={key} type="button" style={chipStyle(spkTrack === key)} onClick={() => setSpkTrack(key)}>
                  {t(`panel.speaker.trackFilter.${key}`)}
                </button>
              ))}
              <span style={{ ...smallStyle, marginLeft: 4 }}>{rows.length} {t('panel.speaker.trackCount')}</span>
            </div>

            {rows.length === 0 ? (
              <div style={{ ...smallStyle, lineHeight: 1.6, padding: '10px 0' }}>{t('panel.speaker.emptyRange')}</div>
            ) : rows.map((segment, index) => {
              const key = rowKey(segment)
              const picked = spkPicked.includes(key)
              const assigned = segment.line ? assign[String(segment.line)] : undefined
              const spokeName = assigned?.name ?? (assigned ? assigned.speaker.replace('speaker_', 'S') : '')
              return (
              <div
                key={key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '18px 62px 48px 116px minmax(0, 1fr)',
                  columnGap: 8,
                  alignItems: 'start',
                  padding: '5px 0',
                  borderBottom: `1px solid ${BORDER}`,
                  background: picked ? 'var(--pl-brand-soft)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={() => togglePick(key)}
                  style={{ marginTop: 3 }}
                  aria-label={t('panel.speaker.pick')}
                />
                <span style={{ fontFamily: MONO, fontSize: FS.xs, lineHeight: '18px', color: CAPTION, fontVariantNumeric: 'tabular-nums' }}>
                  {clock(segment.s, true)}
                </span>
                <span style={{ fontSize: FS.xs, lineHeight: '16px', color: trackColor(segment.track), whiteSpace: 'nowrap' }}>
                  {trackName(segment.track, t)}
                </span>
                <SpeakerChip name={spokeName} score={assigned?.score ?? segment.speakerScore} />
                <span style={{ fontSize: FS.sm, lineHeight: '18px', wordBreak: 'break-word' }}>{segment.text}</span>
              </div>
              )
            })}
          </div>
        ) : (
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px 16px' }}>
            {groups.length === 0 ? (
              <div style={{ ...smallStyle, lineHeight: 1.6 }}>{t('panel.speaker.empty')}</div>
            ) : groups.map((group) => (
              <div key={group.day}>
                <div style={{ ...smallStyle, fontWeight: 600, margin: '10px 0 4px' }}>{group.day}</div>
                {group.items.map((item) => (
                  <div key={item.id} style={{ ...cardStyle, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2, fontVariantNumeric: 'tabular-nums' }}>
                        {clock(item.start, true)}–{clock(item.end, true)}
                      </span>
                      <span style={{ fontSize: FS.sm, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.label}
                      </span>
                      <span style={{ flex: '1 1 auto' }} />
                      <span style={smallStyle}>
                        {(item.samples ?? 0) > 0
                          ? t('panel.speaker.samples').replace('{n}', String(item.samples))
                          : t('panel.speaker.audioCount').replace('{n}', String(item.audioCount ?? 0))}
                      </span>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => {
                          if (editingLabel === item.id) {
                            setEditingLabel(null)
                            return
                          }
                          setEditingLabel(item.id)
                          setEditName(item.label)
                          setEditNote(item.note ?? '')
                        }}
                      >
                        {editingLabel === item.id ? t('panel.speaker.cancel') : t('panel.speaker.edit')}
                      </button>
                      <button type="button" style={{ ...buttonStyle, color: DANGER }} onClick={() => void deleteSpeaker(item.id)}>
                        {t('panel.speaker.delete')}
                      </button>
                    </div>
                    {editingLabel === item.id ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                        <input
                          style={{ ...inputStyle, flex: '1 1 120px', minWidth: 0 }}
                          value={editName}
                          placeholder={t('panel.speaker.labelHint')}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter') void saveLabelEdit(item) }}
                        />
                        <input
                          style={{ ...inputStyle, flex: '2 1 160px', minWidth: 0 }}
                          value={editNote}
                          placeholder={t('panel.speaker.note')}
                          onChange={(event) => setEditNote(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter') void saveLabelEdit(item) }}
                        />
                        <button type="button" style={primaryButtonStyle} onClick={() => void saveLabelEdit(item)}>
                          {t('panel.speaker.saveEdit')}
                        </button>
                      </div>
                    ) : null}
                    {editingLabel === item.id ? null : (item.note ? <div style={{ ...smallStyle, marginTop: 3 }}>{item.note}</div> : null)}
                    <div style={{ ...smallStyle, marginTop: 4 }}>
                      <button type="button" style={{ ...buttonStyle, padding: '1px 6px' }} onClick={() => void toggleLabel(item)}>
                        {openLabel === item.id ? t('panel.speaker.collapseLines') : t('panel.speaker.expandLines')}
                      </button>
                    </div>
                    {openLabel === item.id ? (
                      <div style={{ marginTop: 6, borderTop: `1px solid ${BORDER}`, paddingTop: 4 }}>
                        {/* 批量：全选 / 全不选 / 删选中的句子 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ ...smallStyle, color: linePicked.length ? ACCENT : CAPTION }}>
                            {t('panel.speaker.picked').replace('{n}', String(linePicked.length))}
                          </span>
                          <button
                            type="button"
                            style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs }}
                            onClick={() => setLinePicked((labelLines[item.id] ?? []).map((row) => row.line))}
                          >
                            {t('panel.speaker.pickAll')}
                          </button>
                          <button
                            type="button"
                            style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs }}
                            disabled={!linePicked.length}
                            onClick={() => setLinePicked([])}
                          >
                            {t('panel.speaker.pickNone')}
                          </button>
                          <button
                            type="button"
                            style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs, color: DANGER }}
                            disabled={!linePicked.length}
                            onClick={() => void removePickedLines(item)}
                          >
                            {t('panel.speaker.deletePicked').replace('{n}', String(linePicked.length))}
                          </button>
                        </div>
                        {(labelLines[item.id] ?? []).length === 0 ? (
                          <div style={smallStyle}>{t('panel.speaker.noLines')}</div>
                        ) : (labelLines[item.id] ?? []).map((row) => {
                          const picked = linePicked.includes(row.line)
                          return (
                          <div key={row.line} style={{ display: 'grid', gridTemplateColumns: '16px 62px 44px minmax(0, 1fr) auto', columnGap: 8, padding: '3px 0', borderBottom: `1px solid ${BORDER}`, alignItems: 'start', background: picked ? 'var(--pl-brand-soft)' : 'transparent' }}>
                            <input
                              type="checkbox"
                              checked={picked}
                              onChange={() => setLinePicked((previous) => (
                                previous.includes(row.line) ? previous.filter((value) => value !== row.line) : [...previous, row.line]
                              ))}
                              style={{ marginTop: 2 }}
                              aria-label={t('panel.speaker.pick')}
                            />
                            <span style={{ fontFamily: MONO, fontSize: FS.xs, color: CAPTION, fontVariantNumeric: 'tabular-nums' }}>
                              {clock(minuteOfDay(row.startAt), true)}
                            </span>
                            <span style={{ fontSize: FS.xs, color: trackColor(row.track) }}>{trackName(row.track, t)}</span>
                            <span style={{ fontSize: FS.xs, lineHeight: '17px', wordBreak: 'break-word' }}>{row.text}</span>
                            <button
                              type="button"
                              style={{ ...buttonStyle, padding: '0 6px', fontSize: FS.xs, color: DANGER }}
                              onClick={() => void removeLine(item, row.line)}
                            >
                              {t('panel.speaker.deleteLine')}
                            </button>
                          </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }





/** 把片段转成 SRT：序号、`HH:MM:SS,mmm --> HH:MM:SS,mmm`、正文，空行分隔。 */
function toSrt(rows: Array<{ startSec: number; endSec: number; text: string }>): string {
  const stamp = (sec: number): string => {
    const ms = Math.max(0, Math.round(sec * 1000))
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))},${pad(ms % 1000, 3)}`
  }
  return rows
    .map((row, index) => `${index + 1}\n${stamp(row.startSec)} --> ${stamp(Math.max(row.endSec, row.startSec + 0.2))}\n${row.text}`)
    .join('\n\n')
}

/** 可以手输的秒级时间点（m:ss / h:mm:ss），回车或失焦时提交。 */
function ImportTimeInput({ value, max, onCommit }: {
  value: number
  max: number
  onCommit: (sec: number) => void
}): ReactElement {
  const [text, setText] = useState(clock(value))
  useEffect(() => setText(clock(value)), [value])
  const commit = () => {
    const parts = text.trim().split(':').map((item) => Number(item))
    if (parts.some((item) => !Number.isFinite(item) || item < 0)) {
      setText(clock(value))
      return
    }
    const sec = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] ?? 0
    onCommit(Math.max(0, Math.min(max, sec)))
  }
  return (
    <input
      style={{ ...inputStyle, width: 62, padding: '1px 6px', fontFamily: MONO, fontSize: FS.xs, textAlign: 'center' }}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      aria-label="time"
    />
  )
}

/**
 * 离线导入的时间轴：横轴按**秒**，不是分钟。
 *
 * 导入的文件可能只有几十秒，用分钟刻度会出现「一格 1 分钟、根本选不动」的问题。
 * 密度按「总时长 / 60 格」聚合，拖动框选返回秒。
 */
function ImportTimeline({ snippets, durationSec, selection, onSelect, t }: {
  snippets: Array<{ startSec: number; endSec: number; text: string }>
  durationSec: number
  selection: { start: number; end: number }
  onSelect: (range: { start: number; end: number }) => void
  t: (key: string) => string
}): ReactElement {
  const width = 560
  const height = 72
  const pad = 6
  const total = Math.max(1, durationSec)
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; sec: number; speech: number } | null>(null)

  // 60 格密度：每格覆盖 total/60 秒
  const slot = total / 60
  const bins = Array.from({ length: 60 }, () => 0)
  for (const item of snippets) {
    const from = Math.max(0, Math.floor(item.startSec / slot))
    const to = Math.min(59, Math.floor(Math.max(item.startSec, item.endSec - 0.01) / slot))
    const seconds = Math.max(0.2, item.endSec - item.startSec)
    for (let index = from; index <= to; index += 1) {
      bins[index] += seconds / (to - from + 1)
    }
  }
  const maxBin = Math.max(1, ...bins)
  const xAt = (sec: number): number => (Math.min(total, Math.max(0, sec)) / total) * width
  const secAt = (px: number): number => (Math.min(width, Math.max(0, px)) / width) * total
  const yAt = (value: number): number => height - pad - (value / maxBin) * (height - pad * 2)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * total)
  const selLeft = xAt(Math.min(selection.start, selection.end))
  const selRight = xAt(Math.max(selection.start, selection.end))

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${width} ${height + 14}`}
          width="100%"
          height={height + 14}
          role="img"
          style={{ display: 'block', background: SURFACE_SOFT, borderRadius: RADIUS_CHIP, cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(event) => {
            if (!event.isPrimary) return
            const rect = event.currentTarget.getBoundingClientRect()
            const sec = secAt(((event.clientX - rect.left) / rect.width) * width)
            setDrag({ anchor: sec, current: sec })
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
            const sec = secAt(ratio * width)
            if (drag) setDrag({ ...drag, current: sec })
            const bin = Math.min(59, Math.floor(sec / slot))
            setHover({ x: ratio * 100, sec, speech: bins[bin] ?? 0 })
          }}
          onPointerUp={(event) => {
            if (!drag) return
            const from = Math.min(drag.anchor, drag.current)
            const to = Math.max(drag.anchor, drag.current)
            setDrag(null)
            try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
            // 太短的框选当成单击：选到这一刻之后的一小段
            if (to - from < Math.max(0.5, total / 200)) {
              onSelect({ start: from, end: total })
              return
            }
            onSelect({ start: from, end: to })
          }}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => setHover(null)}
        >
          <rect x={selLeft} y={0} width={Math.max(0, selRight - selLeft)} height={height} fill={ACCENT} opacity={0.16} />
          {bins.map((value, index) => {
            if (value <= 0) return null
            const x = (index / 60) * width
            const w = Math.max(1, width / 60 - 1)
            const y = yAt(value)
            return <rect key={index} x={x} y={y} width={w} height={height - pad - y} fill={ACCENT} opacity={0.55} rx={1} />
          })}
          {drag && Math.abs(drag.current - drag.anchor) > 0.2 ? (
            <rect
              x={xAt(Math.min(drag.anchor, drag.current))}
              y={0}
              width={Math.abs(xAt(drag.current) - xAt(drag.anchor))}
              height={height}
              fill={ACCENT}
              opacity={0.14}
            />
          ) : null}
          {ticks.map((sec, index) => (
            <text
              key={index}
              x={xAt(sec)}
              y={height + 11}
              fontSize={9}
              fill={CAPTION}
              textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}
            >
              {clock(sec)}
            </text>
          ))}
        </svg>
        {hover ? (
          <div
            style={{
              position: 'absolute', top: 4,
              left: `calc(${hover.x}% + ${hover.x > 55 ? -12 : 12}px)`,
              transform: hover.x > 55 ? 'translateX(-100%)' : 'none',
              pointerEvents: 'none', background: 'Canvas', color: 'CanvasText',
              border: `1px solid ${CARD_BORDER}`, borderRadius: RADIUS,
              boxShadow: '0 8px 24px rgba(16,24,40,.22)', padding: '4px 8px',
              fontSize: FS.xs, whiteSpace: 'nowrap', zIndex: 2,
            }}
          >
            <div style={{ fontFamily: MONO, fontWeight: 600 }}>{clock(hover.sec)}</div>
            <div style={{ color: FG2 }}>{t('panel.import.speech')} {hover.speech.toFixed(1)}s</div>
          </div>
        ) : null}
      </div>
      <div style={{ ...smallStyle, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{t('panel.import.selected')}</span>
        <ImportTimeInput
          value={selection.start}
          max={total}
          onCommit={(sec) => onSelect({ start: Math.min(sec, selection.end), end: selection.end })}
        />
        <span>–</span>
        <ImportTimeInput
          value={selection.end}
          max={total}
          onCommit={(sec) => onSelect({ start: selection.start, end: Math.max(sec, selection.start) })}
        />
        <button
          type="button"
          style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs }}
          onClick={() => onSelect({ start: 0, end: total })}
        >
          {t('panel.import.selectAll')}
        </button>
        <span style={{ color: CAPTION }}>{t('panel.import.dragHint')}</span>
      </div>
    </div>
  )
}

  const renderImport = () => {
    const durationSec = importDetail ? Math.max(1, importDetail.meta.durationSec) : 1
    const selection = importRange ?? { start: 0, end: durationSec }
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        {renderNotices()}
        <div style={{ ...cardStyle }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600, marginBottom: 6 }}>{t('panel.import.title')}</div>
          <div style={{ ...smallStyle, marginBottom: 6, lineHeight: 1.5 }}>{t('panel.import.hint')}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={primaryButtonStyle} disabled={importBusy} onClick={() => void pickAndImport()}>
              {importBusy ? t('panel.import.starting') : t('panel.import.pick')}
            </button>
            <span style={{ ...smallStyle }}>{t('panel.import.formats')}</span>
          </div>
          <details style={{ marginTop: 6 }}>
            <summary style={{ ...smallStyle, cursor: 'pointer' }}>{t('panel.import.manual')}</summary>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
              <input
                style={{ ...inputStyle, flex: '1 1 auto', minWidth: 0, fontFamily: MONO }}
                value={importPath}
                placeholder={t('panel.import.pathPlaceholder')}
                onChange={(event) => setImportPath(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void startImport() }}
              />
              <button type="button" style={buttonStyle} disabled={importBusy} onClick={() => void startImport()}>
                {t('panel.import.start')}
              </button>
            </div>
          </details>
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.import.tasks')}</span>
            <span style={{ flex: '1 1 auto' }} />
            <button type="button" style={buttonStyle} onClick={() => { void loadImports(); if (importSel) void loadImportDetail(importSel) }}>
              {t('panel.import.refresh')}
            </button>
          </div>
          {importItems.length === 0 ? (
            <div style={{ ...smallStyle, lineHeight: 1.6 }}>{t('panel.import.empty')}</div>
          ) : importItems.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginTop: 4,
                borderRadius: RADIUS_CHIP, cursor: 'pointer',
                border: `1px solid ${importSel === item.id ? ACCENT : BORDER}`,
                background: importSel === item.id ? ACCENT_SOFT : 'transparent',
              }}
              onClick={() => {
                if (importSel === item.id) {
                  // 再点一次同一个任务就收起，省得一直占着下半屏
                  setImportSel(null)
                  setImportDetail(null)
                  setImportRange(null)
                  return
                }
                setImportSel(item.id)
                setImportRange(null)
                void loadImportDetail(item.id)
              }}
            >
              <span style={{ fontSize: FS.sm, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
                {item.name}
              </span>
              <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2, fontVariantNumeric: 'tabular-nums' }}>
                {clock(item.durationSec / 60)}
              </span>
              <span style={{ fontSize: FS.xs, color: item.status === 'done' ? SUCCESS : item.status === 'failed' ? DANGER : CAPTION }}>
                {item.status === 'running'
                  ? `${t('panel.import.status.running')} ${Math.round((item.processedSec / Math.max(1, item.durationSec)) * 100)}%`
                  : t(`panel.import.status.${item.status}`)}
              </span>
              <span style={{ fontSize: FS.xs, color: CAPTION }}>{item.snippets} {t('panel.import.rows')}</span>
              {item.status === 'running' ? (
                <button type="button" style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs }} onClick={(event) => { event.stopPropagation(); void cancelImport(item.id) }}>
                  {t('panel.import.cancel')}
                </button>
              ) : (
                <button type="button" style={{ ...buttonStyle, padding: '1px 6px', fontSize: FS.xs, color: DANGER }} onClick={(event) => { event.stopPropagation(); void deleteImport(item.id) }}>
                  {t('panel.import.delete')}
                </button>
              )}
            </div>
          ))}
          {importItems.some((item) => item.status === 'failed' && item.error) ? (
            <div style={{ ...smallStyle, marginTop: 6, color: DANGER }}>
              {importItems.filter((item) => item.status === 'failed' && item.error).map((item) => `${item.name}: ${item.error}`).join('；')}
            </div>
          ) : null}
        </div>

        {importDetail ? (
          <div style={{ ...cardStyle }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{importDetail.meta.name}</span>
              <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2 }}>{clock(importDetail.meta.durationSec / 60)}</span>
              <span style={{ flex: '1 1 auto' }} />
              <button type="button" style={primaryButtonStyle} disabled={importGenerating || importDetail.snippets.length === 0} onClick={() => void generateImportMinutes()}>
                {importGenerating ? t('panel.import.generating') : t('panel.import.generate')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => { setImportSel(null); setImportDetail(null); setImportRange(null) }}
              >
                {t('panel.import.collapse')}
              </button>
            </div>
            <ImportTimeline
              snippets={importDetail.snippets}
              durationSec={importDetail.meta.durationSec}
              selection={selection}
              onSelect={(range) => setImportRange(range)}
              t={t}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.import.transcript')}</span>
              <span style={{ ...smallStyle }}>{importDetail.snippets.length} {t('panel.import.rows')}</span>
              <span style={{ flex: '1 1 auto' }} />
              <button
                type="button"
                style={buttonStyle}
                disabled={importDetail.snippets.length === 0}
                onClick={() => void copyText(toSrt(importDetail.snippets), 'srt')}
              >
                {t('panel.import.copySrt')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={importDetail.snippets.length === 0}
                onClick={() => void copyText(importDetail.snippets.map((row) => row.text).join('\n'), 'plain')}
              >
                {t('panel.import.copyText')}
              </button>
            </div>
            {importDetail.snippets.length === 0 ? (
              <div style={{ ...smallStyle, lineHeight: 1.6, marginTop: 6 }}>{t('panel.import.noRows')}</div>
            ) : (
              <div style={{ marginTop: 6, borderTop: `1px solid ${BORDER}` }}>
                {importDetail.snippets.map((row, index) => (
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', columnGap: 8, padding: '4px 0', borderBottom: `1px solid ${BORDER}` }}>
                    <span style={{ fontFamily: MONO, fontSize: FS.xs, color: CAPTION, fontVariantNumeric: 'tabular-nums' }}>{clock(row.startSec)}</span>
                    <span style={{ fontSize: FS.sm, lineHeight: '18px', wordBreak: 'break-word' }}>{row.text}</span>
                  </div>
                ))}
              </div>
            )}
            {importDetail.minutes ? (
              <div style={{ marginTop: 10, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.import.minutes')}</span>
                  <button type="button" style={buttonStyle} onClick={() => void copyText(importDetail.minutes ?? '', 'import')}>
                    {t('panel.copy')}
                  </button>
                </div>
                <div style={{ marginTop: 4 }}>{renderMarkdownLite(importDetail.minutes ?? '')}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const renderAbout = () => {
    // 用字典回读判断当前语言，避免依赖 slot 是否透传 locale。
    const isEn = t('panel.tab.today') !== ZH_DICT['panel.tab.today']
    const intro = isEn ? INTRO_EN : INTRO_ZH
    const share = isEn ? buildSharePromptEn() : buildSharePrompt()
    const rows: Array<{ key: string; value: string }> = [
      { key: t('panel.about.pkg'), value: PACKAGE_NAME },
      { key: t('panel.version'), value: PLUGIN_VERSION },
      { key: t('panel.about.license'), value: 'MIT' },
      ...(asr?.logRoot ? [{ key: t('panel.about.home'), value: asr.logRoot }] : []),
    ]
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        <div style={{ ...cardStyle }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600, marginBottom: 6 }}>{t('panel.about.intro')}</div>
          {intro.map((line, index) => (
            <p key={index} style={{ margin: index === 0 ? 0 : '8px 0 0', fontSize: FS.sm, lineHeight: 1.75, color: FG2 }}>
              {line}
            </p>
          ))}
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.demo.title')}</span>
            <span style={{ flex: '1 1 auto' }} />
            <button
              type="button"
              style={demoMode ? { ...buttonStyle, borderColor: WARN, color: WARN } : primaryButtonStyle}
              onClick={() => {
                const next = !demoMode
                setDemoActive(next)
                setDemoMode(next)
                // 切换后清掉缓存，让六个页面重新取数（演示模式取夹具）
                setData(null)
                setMinutes(null)
                setMinutesRange(null)
                setExpandedMinute(null)
                void loadDay(undefined, true)
                void loadJobs()
                void loadSkills()
                if (next) void loadSpeaker()
              }}
            >
              {demoMode ? t('panel.demo.exit') : t('panel.demo.enter')}
            </button>
          </div>
          <div style={{ ...smallStyle, lineHeight: 1.6 }}>{t('panel.demo.hint')}</div>
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600, marginBottom: 6 }}>{t('panel.about.meta')}</div>
          {rows.map((row) => (
            <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', columnGap: 8, marginTop: 5, fontSize: FS.xs, lineHeight: 1.5 }}>
              <span style={{ color: CAPTION }}>{row.key}</span>
              <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>{row.value}</span>
            </div>
          ))}
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600, marginBottom: 4 }}>{t('panel.about.share')}</div>
          <div style={{ ...smallStyle, lineHeight: 1.55, marginBottom: 6 }}>{t('panel.about.shareHint')}</div>
          <textarea
            readOnly
            value={share}
            rows={10}
            style={{
              ...inputStyle,
              fontFamily: MONO,
              fontSize: FS.xs,
              lineHeight: 1.6,
              resize: 'vertical',
              minHeight: 160,
              color: FG2,
              background: BG2,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" style={primaryButtonStyle} onClick={() => void copyText(share, 'share')}>
              {flash === 'share' ? t('panel.about.copied') : t('panel.about.copy')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const lastGap = (() => {
    const gap = asr?.interruptions?.[0]
    if (!gap) return t('panel.asr.hb.noGap')
    const cause = t(`panel.asr.hb.cause.${gap.cause}`)
    const when = new Date(gap.at)
    const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    const length = gap.seconds >= 60
      ? t('panel.asr.hb.minutes').replace('{s}', String(Math.round(gap.seconds / 60)))
      : (gap.seconds > 0 ? t('panel.asr.hb.seconds').replace('{s}', String(gap.seconds)) : '')
    return `${hhmm} ${cause}${length ? ` ${length}` : ''}`
  })()

  const heartbeat = asr?.heartbeat
  const hbState = (() => {
    const event = heartbeat?.eventAgeSec
    const snippet = heartbeat?.snippetAgeSec
    if (typeof event === 'number' && event > 60) return 'stalled'
    if (typeof snippet === 'number' && snippet > 600) return 'quiet'
    if (typeof event === 'number' && event > 15) return 'warn'
    return 'ok'
  })()
  const hbColor = hbState === 'stalled' ? DANGER : hbState === 'ok' ? SUCCESS : WARN
  const hbLabel = t(`panel.asr.hb.state.${hbState}`)
  const ageText = (seconds: number | null | undefined): string => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return t('panel.asr.hb.none')
    if (seconds < 60) return t('panel.asr.hb.secondsAgo').replace('{s}', String(Math.max(0, Math.round(seconds))))
    if (seconds < 3600) return t('panel.asr.hb.minutesAgo').replace('{s}', String(Math.round(seconds / 60)))
    return t('panel.asr.hb.hoursAgo').replace('{s}', String(Math.round(seconds / 3600)))
  }

  const renderAsr = () => {
    const phase = asr?.phase ?? 'idle'
    const phaseColor = phase === 'running' ? SUCCESS : phase === 'failed' ? DANGER : CAPTION
    const current = models?.models.find((item) => item.id === models?.selectedId) ?? null
    const ready = Boolean(current?.usable)
    const offer = (models?.offers ?? []).find((item) => item.id === 'sensevoice-small') ?? null
    const download = (models?.downloads ?? []).find((item) => item.id === 'sensevoice-small') ?? null
    const localSenseVoice = (models?.models ?? []).find((item) => item.kind === 'onnx-sensevoice') ?? null
    const coreml = (models?.models ?? []).find((item) => item.kind === 'coreml-sensevoice') ?? null
    const coremlSuggestion = models?.suggestion?.kind === 'coreml-sensevoice' && models.suggestion.ok ? models.suggestion : null
    const coremlOffer = (models?.offers ?? []).find((item) => item.id === 'sensevoice-coreml-int8') ?? null
    const coremlDownload = (models?.downloads ?? []).find((item) => item.id === 'sensevoice-coreml-int8') ?? null
    const coremlReady = Boolean(coreml?.usable || coremlSuggestion || coremlOffer?.present)
    const coremlPending = Boolean(coremlDownload && coremlDownload.status === 'running' && !coreml)
    const onnxReady = Boolean(localSenseVoice?.usable || offer?.present)
    const onnxPending = Boolean(download && download.status === 'running' && !localSenseVoice)
    const modelChoices: Array<{
      key: string
      id?: string
      offerId?: string
      addPath?: string
      name: string
      meta: string
      badge: string
      tone: string
    }> = [
      {
        key: 'onnx-fp32',
        id: localSenseVoice?.id,
        offerId: localSenseVoice ? undefined : 'sensevoice-small',
        name: 'sensevoice-small ONNX fp32',
        meta: `${t('panel.asr.metaCross')} · ${offer ? formatBytes(offer.bytesHint, true) : ''}`.trim(),
        badge: localSenseVoice?.id === models?.selectedId
          ? t('panel.asr.metaActive')
          : onnxPending
            ? t('panel.asr.downloading')
            : onnxReady
              ? t('panel.asr.metaReady')
              : t('panel.asr.metaDownload'),
        tone: onnxReady || localSenseVoice?.id === models?.selectedId ? FG2 : WARN,
      },
      {
        key: 'coreml-int8',
        id: coreml?.id,
        ...(coreml ? {} : coremlSuggestion ? { addPath: coremlSuggestion.path } : { offerId: 'sensevoice-coreml-int8' }),
        name: 'SenseVoiceSmall_int8 苹果 Core ML',
        meta: `${t('panel.asr.metaDefault')} · ${coremlOffer ? formatBytes(coremlOffer.bytesHint, true) : ''}`.trim(),
        badge: coreml?.id === models?.selectedId
          ? t('panel.asr.metaActive')
          : coremlPending
            ? t('panel.asr.downloading')
            : coremlReady
              ? t('panel.asr.metaReady')
              : t('panel.asr.metaDownload'),
        tone: coremlReady || coreml?.id === models?.selectedId ? FG2 : WARN,
      },
    ]
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        <div style={{ ...cardStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.running')}</span>
            <span style={{ fontSize: FS.xs, color: phaseColor, fontWeight: 600 }}>{t(`panel.asr.phase.${phase}`)}</span>
            <span style={{ flex: '1 1 auto' }} />
            <button
              type="button"
              style={buttonStyle}
              onClick={() => void setAsrEnabled(!(asr?.enabled ?? false))}
            >
              {asr?.enabled ? t('panel.asr.pause') : t('panel.asr.resume')}
            </button>
          </div>
          <div style={{ ...smallStyle, marginTop: 4, lineHeight: 1.5 }}>{asr?.message || t('panel.asr.hint')}</div>
        </div>

        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.health')}</span>
            <span style={{ flex: '1 1 auto' }} />
            {asr?.audioRestarts ? (
              <span style={{ ...smallStyle }}>{t('panel.asr.health.restarts')} {asr.audioRestarts}</span>
            ) : null}
          </div>
          {([
            { key: 'mic' as const, label: t('panel.asr.health.mic'), idleKey: 'silent' },
            { key: 'system' as const, label: t('panel.asr.health.system'), idleKey: 'idle' },
          ]).map((row) => {
            const state = asr?.audio?.[row.key] ?? 'off'
            // 系统声音没有播放是常态，不该报红；收不到音频帧才是故障。
            const bad = state === 'dead' || (state === 'silent' && row.key === 'mic')
            const calm = state === 'ok' || state === 'silent'
            const color = bad ? DANGER : calm ? (state === 'ok' ? SUCCESS : CAPTION) : CAPTION
            const textColor = bad ? DANGER : FG2
            const textKey = state === 'silent' ? row.idleKey : state
            return (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, fontSize: FS.xs }}>
                <span style={{ width: 8, height: 8, borderRadius: RADIUS_CHIP, background: color, flex: '0 0 auto' }} />
                <span style={{ minWidth: 0 }}>{row.label}</span>
                <span style={{ flex: '1 1 auto' }} />
                <span style={{ color: textColor }}>{t(`panel.asr.health.${textKey}`)}</span>
              </div>
            )
          })}
          {(asr?.inputs?.length ?? 0) > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: FS.xs, fontWeight: 600 }}>{t('panel.asr.input')}</span>
              <select
                style={{ ...selectStyle, maxWidth: '100%', flex: '1 1 160px' }}
                value={asr?.inputUID ?? ''}
                onChange={(event) => void setAsrInput(event.target.value)}
              >
                <option value="">{t('panel.asr.inputAuto')}</option>
                {(asr?.inputs ?? []).map((device) => (
                  <option key={device.uid} value={device.uid}>{device.name}</option>
                ))}
              </select>
              {asr?.input ? <span style={smallStyle}>{t('panel.asr.inputUsing')} {asr.input}</span> : null}
            </div>
          ) : null}
          <div style={{ ...smallStyle, marginTop: 6, lineHeight: 1.45 }}>{t('panel.asr.health.hint')}</div>
        </div>

        {/* 链路心跳：区分「没说话」和「链路断了」 */}
        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.hb.title')}</span>
            <span style={{ ...smallStyle, color: hbColor }}>{hbLabel}</span>
            <span style={{ flex: '1 1 auto' }} />
            {(['minute', 'hour', 'day'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                style={{
                  ...buttonStyle,
                  ...(hbRange === mode ? { borderColor: ACCENT, color: ACCENT, background: ACCENT_SOFT } : {}),
                }}
                onClick={() => setHbRange(mode)}
              >
                {t(`panel.asr.mem.range.${mode}`)}
              </button>
            ))}
            <button
              type="button"
              style={buttonStyle}
              disabled={restartingAsr}
              onClick={() => void restartAsr()}
            >
              {restartingAsr ? t('panel.asr.hb.restarting') : t('panel.asr.hb.restart')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', columnGap: 8, marginTop: 6, fontSize: FS.xs, lineHeight: 1.7 }}>
            <span style={{ color: CAPTION }}>{t('panel.asr.hb.event')}</span>
            <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>{ageText(heartbeat?.eventAgeSec)}</span>
            <span style={{ color: CAPTION }}>{t('panel.asr.hb.snippet')}</span>
            <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>{ageText(heartbeat?.snippetAgeSec)}</span>
            <span style={{ color: CAPTION }}>{t('panel.asr.hb.produced')}</span>
            <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
              {heartbeat?.snippetsSinceStart ?? 0} {t('panel.asr.hb.rows')}
              {(heartbeat?.speechWithoutSnippetSec ?? 0) > 0
                ? ` · ${t('panel.asr.hb.pendingSpeech').replace('{s}', String(Math.round(heartbeat?.speechWithoutSnippetSec ?? 0)))}`
                : ''}
            </span>
            <span style={{ color: CAPTION }}>{t('panel.asr.hb.recover')}</span>
            <span>{heartbeat?.restarts ?? 0} {t('panel.asr.hb.times')}{heartbeat?.lastReason ? ` · ${heartbeat.lastReason}` : ''}</span>
            <span style={{ color: CAPTION }}>{t('panel.asr.hb.lastGap')}</span>
            <span style={{ color: lastGap ? WARN : FG2 }}>{lastGap}</span>
          </div>
          {asr?.notice ? (
            <div style={{ ...smallStyle, marginTop: 6, color: WARN, lineHeight: 1.5 }}>{asr.notice}</div>
          ) : null}
          {hbDay && hbDay.points.length ? (
            <HeartbeatChart
              points={hbDay.points}
              summary={hbDay.summary}
              range={hbRange}
              t={t}
            />
          ) : null}
          <div style={{ ...smallStyle, marginTop: 6, lineHeight: 1.45 }}>{t('panel.asr.hb.hint')}</div>
        </div>

        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.modelTitle')}</span>
            <span style={{ flex: '1 1 auto' }} />
            <span style={{
              fontSize: FS.xs,
              lineHeight: '16px',
              padding: '0 5px',
              borderRadius: RADIUS_CHIP,
              color: ready ? FG2 : WARN,
              border: `1px solid ${BORDER}`,
              background: BG2,
            }}>
              {ready ? t('panel.asr.ready') : t('panel.asr.notReady')}
            </span>
          </div>
          <div style={{ ...smallStyle, marginTop: 3, lineHeight: 1.45 }}>{t('panel.asr.modelHint')}</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {modelChoices.map((choice) => {
              const active = choice.id ? current?.id === choice.id : false
              const pending = Boolean(download && download.status === 'running' && !choice.id)
              return (
                <label
                  key={choice.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '16px minmax(0, 1fr) auto',
                    columnGap: 8,
                    alignItems: 'start',
                    padding: '6px 8px',
                    borderRadius: RADIUS,
                    border: `1px solid ${active ? ACCENT : BORDER}`,
                    background: active ? ACCENT_SOFT : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    checked={active}
                    disabled={!choice.id && pending}
                    onChange={() => {
                      if (choice.id) void selectModel(choice.id)
                      else if (choice.addPath) void addModel(choice.addPath)
                      else if (choice.offerId) void downloadModel(choice.offerId)
                      // 没有可下载的 offer 时宁可什么都不做，也绝不替用户下另一个模型。
                      else setNoticeError(t('panel.asr.noDownload'))
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: FS.sm, fontWeight: 600, wordBreak: 'break-all' }}>{choice.name}</span>
                    <span style={{ display: 'block', fontSize: FS.xs, color: CAPTION, marginTop: 2, lineHeight: 1.45 }}>
                      {choice.meta}
                    </span>
                  </span>
                  <span style={{ fontSize: FS.xs, lineHeight: '16px', color: choice.tone, border: `1px solid ${BORDER}`, background: BG2, borderRadius: RADIUS_CHIP, padding: '0 5px', whiteSpace: 'nowrap' }}>
                    {choice.badge}
                  </span>
                </label>
              )
            })}
          </div>

          {(models?.downloads ?? []).filter((item) => item.status === 'running').map((item) => (
            <div key={item.id} style={{ ...smallStyle, marginTop: 6 }}>
              {t('panel.asr.downloading')} {item.name}
              {' · '}
              {formatBytes(item.received)}
              {item.total ? ` / ${formatBytes(item.total)}` : ''}
            </div>
          ))}

        </div>

        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.mode')}</div>
          {(asr?.mode ? (['tracks', 'merged', 'raw'] as const) : (['tracks'] as const)).map((mode) => (
            <label key={mode} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr)', columnGap: 8, alignItems: 'start', marginTop: 6, fontSize: FS.sm }}>
              <input type="radio" checked={asr?.mode === mode} onChange={() => void setAsrMode(mode)} />
              <span>
                <span style={{ fontWeight: 600 }}>{t(`panel.asr.mode.${mode}`)}</span>
                <span style={{ display: 'block', color: CAPTION, fontSize: FS.xs }}>{t(`panel.asr.mode.${mode}Hint`)}</span>
              </span>
            </label>
          ))}

          {/* 原音占用与清理：放在「保存内容」里，离配置最近 */}
          {storage ? (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: FS.xs }}>
                <span style={{ fontWeight: 600 }}>{t('panel.asr.storage.audio')}</span>
                <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
                  {formatBytes(storage.audio.bytes, true)} · {storage.audio.files} {t('panel.asr.storage.files')}
                </span>
                {storage.audio.days.length ? (
                  <span style={{ color: CAPTION }}>
                    {t('panel.asr.storage.oldest').replace('{d}', storage.audio.days[0].day)}
                  </span>
                ) : (
                  <span style={{ color: CAPTION }}>{t('panel.asr.storage.empty')}</span>
                )}
                <span style={{ flex: '1 1 auto' }} />
                <button type="button" style={buttonStyle} disabled={cleaning || !storage.audio.files} onClick={() => void cleanAudio(7)}>
                  {t('panel.asr.storage.clean7')}
                </button>
                <button type="button" style={buttonStyle} disabled={cleaning || !storage.audio.files} onClick={() => void cleanAudio(0)}>
                  {t('panel.asr.storage.cleanAll')}
                </button>
              </div>
              {storage.backups.files ? (
                <div style={{ ...smallStyle, marginTop: 4 }}>
                  {t('panel.asr.storage.backup')
                    .replace('{n}', String(storage.backups.files))
                    .replace('{s}', formatBytes(storage.backups.bytes, true))}
                </div>
              ) : null}
              <div style={{ ...smallStyle, marginTop: 4, lineHeight: 1.45 }}>{t('panel.asr.storage.hint')}</div>
            </div>
          ) : null}
        </div>

        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.language')}</div>
          {(['zhen', 'zh', 'en', 'auto'] as const).map((language) => (
            <label key={language} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, fontSize: FS.xs }}>
              <input type="radio" checked={(asr?.language ?? 'zhen') === language} onChange={() => void setAsrLanguage(language)} />
              <span>{t(`panel.asr.language.${language}`)}</span>
            </label>
          ))}
        </div>

        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ ...smallStyle, marginTop: 0 }}>
            {t('panel.asr.foot')} {asr?.memory?.length ? formatBytes(asr.memory.at(-1)?.occupied ?? asr.memory.at(-1)?.footprint) : (asr?.running ? formatBytes(asr?.rssBytes) : t('panel.asr.rssIdle'))}
          </div>
          <MemoryTimeline
            samples={asr?.memory ?? []}
            day={memoryDay}
            range={memoryRange}
            onRange={(next) => setMemoryRange(next)}
            t={t}
          />
          <div style={{ ...smallStyle, marginTop: 6, lineHeight: 1.45 }}>{t('panel.asr.memoryHint')}</div>
        </div>
      </div>
    )
  }

  const renderJobs = () => {
    const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
    const finished = jobs.some((job) => job.status !== 'queued' && job.status !== 'running')
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        <PageHeader
          title={t('panel.jobs.title')}
          meta={active ? `${active} ${t('panel.jobs.active')}` : t('panel.jobs.idle')}
          hint={t('panel.jobs.hint')}
          actions={(
            <button type="button" style={buttonStyle} disabled={!finished} onClick={() => void clearFinishedJobs()}>
              {t('panel.jobs.clear')}
            </button>
          )}
        />
        {jobs.length === 0 ? (
          <div style={{ ...smallStyle, lineHeight: 1.6 }}>{t('panel.jobs.empty')}</div>
        ) : jobs.map((job) => (
          <div key={job.id} style={cardStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', columnGap: 8, alignItems: 'center' }}>
              <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2, fontVariantNumeric: 'tabular-nums' }}>{clock(job.start)}–{clock(job.end)}</span>
              <span style={{ fontSize: FS.sm, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.topic || job.day}</span>
              <JobBadge job={job} t={t} />
            </div>
            <div style={{ ...smallStyle, marginTop: 4 }}>
              {job.day}
              {job.backgroundIds.length ? ` · ${t('panel.generate.background')} ${job.backgroundIds.length}` : ''}
              {job.model ? ` · ${job.model}` : ''}
            </div>
            <div style={{ marginTop: 4, fontSize: FS.xs }}>
              <JobDetail job={job} t={t} />
            </div>
            {(job.status === 'queued' || job.status === 'running') ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button type="button" style={{ ...buttonStyle, color: DANGER }} onClick={() => void cancelJob(job.id)}>
                  {t('panel.jobs.cancel')}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    )
  }

  const runningJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running')

  /** 三类提示：确认（3 秒消失）、错误（常驻）、进行中（常驻 + 去哪看）。 */
  const renderNotices = () => (
    <>
      {noticeError ? <div style={{ ...smallStyle, color: DANGER, marginBottom: 6, lineHeight: 1.5 }}>{noticeError}</div> : null}
      {runningJobs.length ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          marginBottom: 6,
          border: `1px solid ${CARD_BORDER}`,
          borderRadius: RADIUS,
          background: CARD,
          fontSize: FS.xs,
          color: FG2,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: RADIUS_PILL, background: ACCENT, flex: '0 0 auto', animation: 'mm-pulse 1.1s ease-in-out infinite' }} />
          <span style={{ minWidth: 0 }}>{t('panel.notice.running').replace('{n}', String(runningJobs.length))}</span>
          <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => setTab('jobs')}>{t('panel.notice.where')}</button>
        </div>
      ) : null}
      {notice ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          marginBottom: 6,
          border: `1px solid ${CARD_BORDER}`,
          borderRadius: RADIUS,
          background: CARD,
          fontSize: FS.xs,
          color: FG2,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: RADIUS_PILL, background: SUCCESS, flex: '0 0 auto' }} />
          <span>{notice}</span>
        </div>
      ) : null}
    </>
  )

  /**
   * 生成任务进行中的横幅：点完「AI 生成纪要」之后，今日页必须一眼看到任务在跑。
   * 之前只有一个不显眼的「任务」按钮，用户以为没反应。
   */
  const renderJobBanner = (dayJobs_: JobDTO[]) => {
    const active = dayJobs_.filter((job) => job.status === 'queued' || job.status === 'running')
    if (!active.length) return null
    const job = active[0]
    const started = job.status === 'running' && job.startedAt ? Date.parse(job.startedAt) : 0
    const elapsed = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0
    const queued = job.status === 'queued'
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        marginBottom: 8,
        border: `1px solid ${ACCENT}`,
        borderRadius: RADIUS,
        background: ACCENT_SOFT,
        flexWrap: 'wrap',
      }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: RADIUS_PILL,
          background: ACCENT,
          flex: '0 0 auto',
          opacity: queued ? 0.5 : 1,
        }} />
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: ACCENT }}>
          {queued ? t('panel.jobs.status.queued') : t('panel.jobs.status.running')}
        </span>
        <span style={{ ...smallStyle, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
          {clock(job.start)}–{clock(job.end)}
        </span>
        {elapsed > 0 ? <span style={smallStyle}>{t('panel.jobs.elapsed').replace('{s}', String(elapsed))}</span> : null}
        {active.length > 1 ? <span style={smallStyle}>+{active.length - 1}</span> : null}
        <span style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          style={{ ...buttonStyle, borderColor: ACCENT, color: ACCENT }}
          onClick={() => { void loadJobs(); setTab('jobs') }}
        >
          {t('panel.jobs.view')}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void cancelJob(job.id)}
        >
          {t('panel.jobs.cancel')}
        </button>
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
    const dayJobs = jobs.filter((job) => job.day === data.day).slice(0, 5)
    const activeJobs = jobs.filter((job) => (job.status === 'queued' || job.status === 'running') && job.day === data.day)
    const currentJob = activeJobs.find((job) => (
      Math.abs(job.start - activeSelection.start) < 0.5 && Math.abs(job.end - activeSelection.end) < 0.5
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
        {activeJobs.length ? (
          <div style={{ flex: '0 0 auto', padding: '6px 10px 0' }}>{renderJobBanner(jobs)}</div>
        ) : null}
        <div style={{ flex: '0 0 auto', padding: '6px 10px 0' }}>
          <RangeSelector
            t={t}
            buckets={data.buckets}
            windowStart={data.window.start}
            windowEnd={data.window.end}
            selection={activeSelection}
            now={now}
            minutes={selectionMinutes}
            captureMinutes={selectionCapture}
            speechMinutes={selectionSpeech}
            intervals={minuteIntervals}
            intervalsLabel={t('panel.today.minutesLane')}
            onDraft={handleDraft}
            onCommit={handleCommit}
            onLast2h={() => quickSelect('last2h')}
            onAll={() => quickSelect('all')}
            height={chartHeight}
            onResize={setChartHeight}
            extra={(
              <>
                {noticeError ? <span style={{ ...smallStyle, color: DANGER }}>{noticeError}</span> : null}
                {notice ? <span style={{ ...smallStyle, color: FG2 }}>{notice}</span> : null}
              </>
            )}
          />
          <div style={{ ...smallStyle, display: 'flex', alignItems: 'center', gap: 6, minHeight: 18, padding: '2px 0 6px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span style={{ fontWeight: 600, flex: '0 0 auto' }}>{t('panel.todayStats')}</span>
            <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {data.stats.segments} 段 · {numberText(data.stats.chars)} 字 · 语音 {data.stats.speechMinutes} {t('unit.min')} · {t('panel.captured')} {data.stats.captureMinutes} 分钟
              {lastLoadedAt ? ` · ${t('panel.updated')} ${clockFromDate(lastLoadedAt)}` : ''}
              {` · ${t('panel.autoRefresh')}`}
            </span>
            {data.truncated ? <span style={{ color: WARN }}>{t('panel.transcript.truncated').replace('{n}', String(data.segments.length))}</span> : null}
            {data.warnings.map((warning) => <span key={warning} style={{ color: WARN }}>{warning}</span>)}
          </div>

          <div style={{
            border: `1px solid ${CARD_BORDER}`,
            borderRadius: RADIUS,
            background: CARD,
            padding: '10px 12px',
            margin: '0 0 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span style={{ fontSize: FS.xs, fontWeight: 600 }}>{t('panel.generate.background')}</span>
              <span style={{ fontSize: FS.xs, color: bgSelection.length ? ACCENT : CAPTION }}>
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
                borderTop: `1px solid ${BORDER}`,
                maxHeight: 120,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}>
                {backgrounds.length === 0 ? (
                  <span style={smallStyle}>{t('panel.generate.noBackgrounds')} · {t('panel.generate.backgroundHint')}</span>
                ) : backgrounds.map((card) => (
                  <label key={card.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: FS.xs, cursor: 'pointer' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={!data || Boolean(currentJob)}
                onClick={() => void generateDraft()}
              >
                {currentJob
                  ? (currentJob.status === 'queued' ? t('panel.jobs.status.queued') : t('panel.minutes.generating'))
                  : t('panel.minutes.generate')}
              </button>
              <span style={{ flex: '1 1 auto' }} />
              <button type="button" style={buttonStyle} onClick={() => setTab('jobs')}>{t('panel.tab.jobs')}</button>
              {dayMinutes && dayMinutes.sessions.length > 0 ? (
                <button type="button" style={buttonStyle} onClick={() => setTab('minutes')}>{t('panel.today.viewMinutes')}</button>
              ) : null}
            </div>
          </div>
        </div>

        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: `1px solid ${BORDER}` }}>
          <div style={{ flex: '0 0 auto', padding: '6px 10px 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.transcript')}</span>
              <span style={smallStyle}>
                {t('panel.transcript.count').replace('{n}', String(segments.length)).replace('{chars}', numberText(segmentChars))}
              </span>
              <span style={{ flex: '1 1 auto' }} />
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  ...(followLatest ? {} : { borderColor: ACCENT, color: ACCENT }),
                }}
                onClick={() => {
                  setFollowLatest(true)
                  if (listRef.current) listRef.current.scrollTop = 0
                }}
              >
                {t('panel.jumpLatest')}
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
              {(['all', 'mic', 'system'] as const).map((key) => (
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
          <div
            ref={listRef}
            onScroll={(event) => {
              // 回到顶部就恢复跟随；往下翻就停住，别抢用户的位置
              setFollowLatest(event.currentTarget.scrollTop <= 4)
            }}
            style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '2px 10px 12px' }}
          >
            {visibleSegments.length === 0
              ? <div style={{ ...smallStyle, lineHeight: 1.6, padding: '10px 0' }}>{emptyText || t('panel.transcript.empty')}</div>
              : visibleSegments.map((segment, index) => {
                const assigned = segment.line ? assign[String(segment.line)] : undefined
                const spokeName = assigned?.name ?? (assigned ? assigned.speaker.replace('speaker_', 'S') : '')
                return (
                <div
                  key={`${segment.s}-${index}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '62px 48px 116px minmax(0, 1fr)',
                    columnGap: 8,
                    alignItems: 'start',
                    padding: '5px 0',
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: FS.xs, lineHeight: '18px', color: CAPTION, fontVariantNumeric: 'tabular-nums' }}>
                    {clock(segment.s, true)}
                  </span>
                  <span style={{
                    justifySelf: 'start',
                    fontSize: FS.xs,
                    lineHeight: '16px',
                    padding: '0 4px',
                    borderRadius: RADIUS_CHIP,
                    border: `1px solid ${BORDER}`,
                    color: trackColor(segment.track),
                    whiteSpace: 'nowrap',
                  }}>
                    {trackName(segment.track, t)}
                  </span>
                  <SpeakerChip name={spokeName} score={assigned?.score ?? segment.speakerScore} />
                  <span style={{ minWidth: 0, fontSize: FS.sm, lineHeight: '18px', wordBreak: 'break-word' }}>
                    {segment.text}
                  </span>
                </div>
                )
              })}
          </div>
        </div>
      </div>
    )
  }

  /** 纪要页的页头：标题 + 场次 + 范围切换，和「背景」「任务」保持同一种结构。 */
  const minutesHeader = () => (
    <PageHeader
      title={t('panel.tab.minutes')}
      meta={minutesMode === 'day'
        ? ` ${minutes?.day ?? ''}`
        : t('panel.minutes.range.count').replace('{n}', String(minutesRange?.total ?? 0))}
      actions={(['week', 'all', 'day'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          style={{
            ...buttonStyle,
            ...(minutesMode === mode ? { borderColor: ACCENT, color: ACCENT, background: ACCENT_SOFT } : {}),
          }}
          onClick={() => {
            setMinutesMode(mode)
            if (mode === 'day' && data) void loadMinutes(data.day)
          }}
        >
          {t(`panel.minutes.range.${mode}`)}
        </button>
      ))}
    />
  )

  const renderMinutes = () => {
    const sessions = minutes?.sessions ?? []
    if (minutesMode !== 'day') {
      // 倒序：日期新的在上，同一天里时间晚的在上（演示数据也走这里）
      const groups = [...(minutesRange?.groups ?? [])]
        .sort((a, b) => b.day.localeCompare(a.day))
        .map((group) => ({
          ...group,
          sessions: [...group.sessions].sort((a, b) => b.start - a.start || b.end - a.end),
        }))
      return (
        <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
          {minutesHeader()}
          {renderNotices()}
          {groups.length === 0 ? (
            <div style={{ ...smallStyle, lineHeight: 1.6, padding: '6px 0' }}>
              {t(minutesMode === 'week' ? 'panel.minutes.emptyWeek' : 'panel.minutes.emptyAll')}
            </div>
          ) : groups.map((group) => (
            <div key={group.day}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 6px' }}>
                <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{group.day}</span>
                <span style={smallStyle}>{t('panel.minutes.sessions').replace('{n}', String(group.sessions.length))}</span>
              </div>
              {group.sessions.map((session) => {
                const key = `${group.day}-${session.id}`
                const open = expandedMinute === key
                const body = sessionBody(session as unknown as Record<string, unknown>)
                return (
                  <div key={key} style={{ ...cardStyle, marginBottom: 8 }}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedMinute(open ? null : key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setExpandedMinute(open ? null : key)
                        }
                      }}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }}
                    >
                      <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                        {clock(session.start)}–{clock(session.end)}
                      </span>
                      <span style={{ fontSize: FS.sm, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.topic}
                      </span>
                      <span style={{ ...smallStyle, marginLeft: 'auto', flex: '0 0 auto', color: FG2 }}>
                        {open ? '▾' : '▸'}
                      </span>
                    </div>
                    {open ? (
                      <>
                        {body ? renderMarkdownLite(body, (target) => void revealPath(target)) : null}
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                          <button
                            type="button"
                            style={buttonStyle}
                            onClick={() => void copySession(session, group.day, `range-${key}`)}
                          >
                            {flash === `range-${key}` ? t('panel.minutes.copied') : t('panel.minutes.copy')}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div style={{ ...smallStyle, marginTop: 4, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {summaryOf(body, 160)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )
    }
    return (
      <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--pl-pad)' }}>
        {minutesHeader()}
        {renderNotices()}
        {minutesError ? renderError(minutesError, () => { if (data) void loadMinutes(data.day) }) : null}
        {minutesLoading && !minutes ? <div style={{ ...smallStyle, padding: '6px 0' }}>{t('panel.loading')}</div> : null}
        {!minutesLoading && minutes && sessions.length === 0 && !editing
          ? <div style={{ ...smallStyle, lineHeight: 1.6, padding: '6px 0' }}>{t('panel.minutes.empty')}</div>
          : null}
        {editing && !editing.id ? renderEditor(editing) : null}
        {[...sessions].sort((a, b) => b.start - a.start || b.end - a.end).map((session) => {
          if (editing && editing.id === session.id) return <div key={session.id}>{renderEditor(editing)}</div>
          const badge = sourceLabel(session.source, t)
          return (
            <div key={session.id} style={cardStyle}>
              <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', columnGap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: MONO, fontSize: FS.xs, color: FG2, fontVariantNumeric: 'tabular-nums' }}>
                  {clock(session.start)}–{clock(session.end)}
                </span>
                <span style={{ fontSize: FS.sm, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.topic}
                </span>
                <span style={{ fontSize: FS.xs, lineHeight: '16px', color: badge.color, border: `1px solid ${BORDER}`, background: BG2, borderRadius: RADIUS_CHIP, padding: '0 4px', whiteSpace: 'nowrap' }}>
                  {badge.label}
                </span>
              </div>
              {sessionBody(session as unknown as Record<string, unknown>) ? renderMarkdownLite(sessionBody(session as unknown as Record<string, unknown>), (p) => void revealPath(p)) : null}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', marginTop: 6 }}>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => void copySession(session, minutes?.day ?? data?.day ?? '', `md-${session.id}`)}
                >
                  {flash === `md-${session.id}` ? t('panel.minutes.copied') : t('panel.minutes.copy')}
                </button>
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


  const narrow = panelWidth > 0 && panelWidth < 420
  const panelVars = narrow
    ? { ...tokenVars, '--pl-radius-card': '12px', '--pl-radius-chip': '9px', '--pl-pad': '10px' }
    : tokenVars

  const days = data?.days ?? []
  const currentIndex = days.indexOf(data?.day ?? '')
  const refreshing = loading

  return (
    <div
      ref={rootRef}
      data-mm-panel="1"
      style={{
        ...panelVars,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: FS.sm,
        color: FG,
        background: BG,
      }}
    >
      <style>{`@keyframes mm-pulse{0%,100%{opacity:.25}50%{opacity:1}}
[data-mm-panel] :focus-visible{outline:var(--dsw-focus-ring-width) solid var(--pl-brand);outline-offset:2px}`}</style>
      <div style={{ flex: '0 0 auto', padding: 'var(--pl-pad) var(--pl-pad) 10px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', minWidth: 0 }}>
            {(['today', 'minutes', 'background', 'jobs', 'asr', 'speaker', 'import', 'about'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '4px 0 7px',
                  fontSize: FS.sm,
                  fontWeight: tab === key ? 600 : 400,
                  color: tab === key ? FG : CAPTION,
                  borderBottom: `2px solid ${tab === key ? ACCENT : 'transparent'}`,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(`panel.tab.${key}`)}
                {key === 'jobs' && jobs.some((job) => job.status === 'queued' || job.status === 'running') ? ' ·' : ''}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, flex: '0 0 auto' }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={refreshing}
              onClick={() => { void loadDay(data?.day, false); if (data) void loadMinutes(data.day); void loadBackgrounds() }}
            >
              {refreshing ? t('panel.refreshing') : t('panel.refresh')}
            </button>
            <span style={{ ...smallStyle, fontFamily: MONO }} title={t('panel.version')}>{PLUGIN_VERSION}</span>
          </div>
        </div>
        {tab === 'today' || (tab === 'minutes' && minutesMode === 'day') ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5, marginTop: 6 }}>
            <span style={{ marginRight: 'auto' }} />
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
            {tab === 'minutes' ? (
              <button type="button" style={buttonStyle} disabled={!data} onClick={startAdd}>{t('panel.minutes.add')}</button>
            ) : null}
          </div>
        ) : null}
      </div>
      {demoMode ? (
        <div style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 10px 6px',
          padding: '5px 8px',
          border: `1px solid ${WARN}`,
          borderRadius: RADIUS,
          background: BG2,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: FS.xs, fontWeight: 600, color: WARN }}>{t('panel.demo.banner')}</span>
          <span style={smallStyle}>{t('panel.demo.bannerHint')}</span>
          <span style={{ flex: '1 1 auto' }} />
          <button
            type="button"
            style={{ ...buttonStyle, borderColor: WARN, color: WARN }}
            onClick={() => {
              setDemoActive(false)
              setDemoMode(false)
              setData(null)
              setMinutes(null)
              setMinutesRange(null)
            }}
          >
            {t('panel.demo.exit')}
          </button>
        </div>
      ) : (update?.hasUpdate || update?.appliedVersion) && !updateHidden ? (
        <div style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 10px 6px',
          padding: '5px 8px',
          border: `1px solid ${ACCENT}`,
          borderRadius: RADIUS,
          background: ACCENT_SOFT,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: FS.xs, fontWeight: 600, color: ACCENT }}>
            {update.appliedVersion && update.appliedVersion === update.latest
              ? t('panel.update.applied').replace('{v}', update.appliedVersion)
              : t('panel.update.available').replace('{v}', update.latest ?? '')}
          </span>
          <span style={{ ...smallStyle, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
            {update.current} → {update.latest}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          {update.appliedVersion && update.appliedVersion === update.latest ? null : (
            <button
              type="button"
              style={{ ...buttonStyle, borderColor: ACCENT, color: ACCENT }}
              disabled={updating}
              onClick={() => void applyUpdateNow()}
            >
              {updating ? t('panel.update.updating') : t('panel.update.now')}
            </button>
          )}
          <button type="button" style={buttonStyle} onClick={() => setUpdateHidden(true)}>
            {t('panel.update.later')}
          </button>
        </div>
      ) : null}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'today' ? renderToday() : tab === 'minutes' ? renderMinutes() : tab === 'background' ? renderBackground() : tab === 'jobs' ? renderJobs() : tab === 'asr' ? renderAsr() : tab === 'speaker' ? renderSpeaker() : tab === 'import' ? renderImport() : renderAbout()}
      </div>
    </div>
  )
}

const smallStyle: CSSProperties = { fontSize: FS.xs, color: CAPTION }

/** Turn **bold** spans into real emphasis; the minutes prompt writes them inline. */
function renderRich(text: string): React.ReactNode {
  if (!text.includes('**')) return text
  const parts = text.split('**')
  if (parts.length < 3) return text
  return parts.map((part, index) => (index % 2 === 1
    ? <strong key={index} style={{ fontWeight: 650 }}>{part}</strong>
    : <span key={index}>{part}</span>))
}

/** 本地资源点击后打开所在文件夹：文件取上级目录，目录就打开自己。 */
function folderUrlOf(localPath: string): string {
  const clean = localPath.replace(/[/]+$/, '')
  const base = clean.split('/').pop() ?? ''
  const looksLikeFile = base.includes('.')
  const folder = looksLikeFile ? clean.slice(0, clean.length - base.length).replace(/\/$/, '') : clean
  return `file://${folder || '/'}/`
}

const INLINE_RE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+|\/Users\/[^\s]+|`[^`]+`)/g

/** 行内渲染：加粗、[标题](链接)、裸 URL、本地绝对路径、`代码`。 */
function renderInline(text: string, keyPrefix: string, onReveal?: (path: string) => void): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('**')) {
      out.push(<strong key={key} style={{ fontWeight: 650 }}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" style={{ color: ACCENT, textDecoration: 'none' }}>
            {link[1]}
          </a>,
        )
      } else out.push(token)
    } else if (token.startsWith('http')) {
      out.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener" style={{ color: ACCENT, textDecoration: 'none', wordBreak: 'break-all' }}>
          {token}
        </a>,
      )
    } else if (token.startsWith('/Users')) {
      out.push(
        <button
          key={key}
          type="button"
          onClick={() => onReveal?.(token)}
          title={`在访达中打开：${token}`}
          style={{
            font: 'inherit',
            fontSize: '0.95em',
            fontFamily: MONO,
            color: FG2,
            background: 'transparent',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
            textUnderlineOffset: 2,
            wordBreak: 'break-all',
            cursor: 'pointer',
          }}
        >
          {token}
        </button>,
      )
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key} style={{ fontFamily: MONO, fontSize: '0.95em', background: SURFACE_SOFT, borderRadius: RADIUS_CHIP, padding: '0 3px' }}>
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      out.push(token)
    }
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 把纪要正文（一段 Markdown）按块渲染：引用块 / 标题 / 待办 / 列表 / 段落。 */
function renderMarkdownLite(text: string, onReveal?: (path: string) => void): React.ReactNode {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '')
    if (!line.trim() || /^>\s*$/.test(line)) {
      i += 1
      continue
    }
    // 连续引用合并成一个块，去掉单独的 ">"
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        const inner = lines[i].replace(/^\s*>\s?/, '').trim()
        if (inner) quote.push(inner)
        i += 1
      }
      blocks.push(
        <div
          key={`b${key++}`}
          style={{ borderLeft: `2px solid ${CARD_BORDER}`, paddingLeft: 8, margin: '4px 0 6px', fontSize: FS.xs, lineHeight: 1.7, color: FG2 }}
        >
          {quote.map((entry, idx) => (
            <div key={idx} style={idx === 0 && entry.startsWith('💡') ? { fontWeight: 600, color: FG } : undefined}>
              {renderInline(entry, `${key}-${idx}`, onReveal)}
            </div>
          ))}
        </div>,
      )
      continue
    }
    if (line.startsWith('### ')) {
      blocks.push(
        <div key={`b${key++}`} style={{ marginTop: 10, marginBottom: 3, fontSize: FS.xs, fontWeight: 700, color: FG }}>
          {renderInline(line.slice(4), `h${key}`, onReveal)}
        </div>,
      )
      i += 1
      continue
    }
    // 列表（待办 / 普通）
    if (/^\s*- /.test(line)) {
      const items: Array<{ text: string; todo: boolean; done: boolean }> = []
      while (i < lines.length && /^\s*- /.test(lines[i])) {
        const raw = lines[i].replace(/^\s*- /, '')
        const todo = raw.match(/^\[( |x|X)\]\s*(.*)$/)
        if (todo) items.push({ text: todo[2], todo: true, done: todo[1] !== ' ' })
        else items.push({ text: raw, todo: false, done: false })
        i += 1
      }
      blocks.push(
        <div key={`b${key++}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '2px 0 4px' }}>
          {items.map((item, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, fontSize: FS.xs, lineHeight: 1.65 }}>
              <span style={{ flex: '0 0 auto', color: item.todo ? (item.done ? SUCCESS : WARN) : CAPTION }}>
                {item.todo ? (item.done ? '☑' : '☐') : '•'}
              </span>
              <span style={{ minWidth: 0 }}>{renderInline(item.text, `l${key}-${idx}`, onReveal)}</span>
            </div>
          ))}
        </div>,
      )
      continue
    }
    blocks.push(
      <div key={`b${key++}`} style={{ fontSize: FS.xs, lineHeight: 1.7, margin: '2px 0' }}>
        {renderInline(line, `p${key}`, onReveal)}
      </div>,
    )
    i += 1
  }
  return blocks
}

/**
 * 正文兜底：正常情况直接读 content（一段 Markdown）。
 * 如果主进程还是旧版本、只下发 summary/points/todos 这些拆开的老字段，
 * 就在这里拼回一段 Markdown，避免卡片空白。
 */
function sessionBody(session: Record<string, unknown>): string {
  const content = typeof session.content === 'string' ? session.content.trim() : ''
  if (content) return content
  const summary = typeof session.summary === 'string' ? session.summary.trim() : ''
  const points = Array.isArray(session.points) ? session.points.map(String) : []
  const decisions = Array.isArray(session.decisions) ? session.decisions.map(String) : []
  const todos = Array.isArray(session.todos) ? session.todos.map(String) : []
  const docs = Array.isArray(session.relatedDocs) ? session.relatedDocs.map(String) : []
  const out: string[] = []
  if (summary) out.push('> 💡 **本场背景与目标**', '>', `> ${summary}`, '')
  const conclusions = decisions.length ? decisions : points
  if (conclusions.length) {
    out.push('### 核心结论', '')
    for (const item of conclusions) out.push(`- ${item}`)
    out.push('')
  }
  if (todos.length) {
    out.push('### TODO', '')
    for (const todo of todos) out.push(`- [ ] ${todo}`)
    out.push('')
  }
  if (docs.length) {
    out.push('### 相关链接与资源', '')
    for (const doc of docs) out.push(`- ${doc}`)
    out.push('')
  }
  return out.join('\n').trim()
}

function trackName(track: string, t: (key: string) => string): string {
  if (track === 'system') return t('panel.filter.system')
  if (track === 'merged' || track === 'meeting') return t('panel.filter.merged')
  return t('panel.filter.mic')
}

function trackColor(track: string): string {
  // 音轨只有三种，用蓝 + 灰两族就够了，别再引入第三种色相。
  if (track === 'system') return 'var(--dsw-alias-chart-system)'
  if (track === 'merged' || track === 'meeting') return FG2
  return 'var(--dsw-alias-chart-messages)'
}

/**
 * 当天 00:00–24:00 的内存曲线，按分类堆叠：
 * 程序堆 / 音频缓冲 / 固定开销，叠起来就是常驻占用。
 * 映射的模型文件（可回收）不参与堆叠，单独一条虚线画在下面，避免把其他分类压扁。
 */

/**
 * 链路心跳的趋势图：和内存图同一套观感（05 分钟/1 小时/全天、拖动框选、悬停提示）。
 * 纵轴是每格里的语音秒数，红色竖带表示那一段没有采集。
 */
function HeartbeatChart({ points, summary, range, t }: {
  points: Array<{ minute: number; state: 'ok' | 'idle' | 'gap' | 'future'; speech: number; snippets: number }>
  summary: { total: number; ok: number; idle: number; gap: number }
  range: 'minute' | 'hour' | 'day'
  t: (key: string) => string
}): ReactElement {
  const width = 560
  const height = 72
  const pad = 6
  const start = points[0]?.minute ?? 0
  const end = (points.at(-1)?.minute ?? 0) + (range === 'day' ? 5 : 1)
  const span = Math.max(1, end - start)
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null)
  const [dragging, setDragging] = useState<{ anchor: number; current: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; point: { minute: number; state: string; speech: number; snippets: number } } | null>(null)
  const viewStart = zoom ? zoom.start : start
  const viewEnd = zoom ? zoom.end : end
  const viewSpan = Math.max(1, viewEnd - viewStart)
  const xAt = (minute: number): number => ((Math.min(viewEnd, Math.max(viewStart, minute)) - viewStart) / viewSpan) * width
  const minuteAt = (px: number): number => viewStart + (px / width) * viewSpan
  const step = points.length > 1 ? Math.max(1, points[1].minute - points[0].minute) : 1
  const maxSpeech = Math.max(1, ...points.map((point) => point.speech))
  const yAt = (value: number): number => height - pad - (value / maxSpeech) * (height - pad * 2)
  const visible = points.filter((point) => point.minute + step > viewStart && point.minute < viewEnd)
  const line = visible.length
    ? `M${visible.map((point) => `${xAt(point.minute).toFixed(1)},${yAt(point.speech).toFixed(1)}`).join(' L')}`
    : ''
  const area = visible.length
    ? `${line} L${xAt(visible.at(-1)!.minute).toFixed(1)},${height - pad} L${xAt(visible[0].minute).toFixed(1)},${height - pad} Z`
    : ''
  const ticks = range === 'minute'
    ? [0, 1, 2, 3, 4, 5].map((offset) => Math.round(viewStart + offset))
    : range === 'hour'
      ? [0, 15, 30, 45, 60].map((offset) => Math.round(viewStart + offset))
      : [0, 360, 720, 1080, 1440]
  const label = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${range === 'day' ? '00' : String(Math.round(minute % 60)).padStart(2, '0')}`

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${width} ${height + 14}`}
          width="100%"
          height={height + 14}
          role="img"
          style={{ display: 'block', background: SURFACE_SOFT, borderRadius: RADIUS_CHIP, cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(event) => {
            if (!event.isPrimary) return
            const rect = event.currentTarget.getBoundingClientRect()
            const minute = minuteAt(((event.clientX - rect.left) / rect.width) * width)
            setDragging({ anchor: minute, current: minute })
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
            const minute = minuteAt(ratio * width)
            if (dragging) setDragging({ ...dragging, current: minute })
            if (!visible.length) return
            let nearest = visible[0]
            let distance = Math.abs(visible[0].minute - minute)
            for (const point of visible) {
              const diff = Math.abs(point.minute - minute)
              if (diff < distance) { nearest = point; distance = diff }
            }
            setHover({ x: ratio * 100, point: nearest })
          }}
          onPointerUp={(event) => {
            if (!dragging) return
            const from = Math.min(dragging.anchor, dragging.current)
            const to = Math.max(dragging.anchor, dragging.current)
            setDragging(null)
            try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
            if (to - from >= (range === 'day' ? 10 : 1)) setZoom({ start: from, end: to })
          }}
          onPointerCancel={() => { setDragging(null); setHover(null) }}
          onPointerLeave={() => setHover(null)}
        >
          {visible.filter((point) => point.state === 'gap').map((point) => (
            <rect
              key={`gap-${point.minute}`}
              x={xAt(point.minute)}
              y={0}
              width={Math.max(1, (width / viewSpan) * step)}
              height={height}
              fill={DANGER}
              opacity={0.12}
            />
          ))}
          {area ? <path d={area} fill={ACCENT} opacity={0.12} /> : null}
          {line ? <path d={line} fill="none" stroke={ACCENT} strokeWidth={2} vectorEffect="non-scaling-stroke" /> : null}
          {dragging && Math.abs(dragging.current - dragging.anchor) > 0.2 ? (
            <rect
              x={xAt(Math.min(dragging.anchor, dragging.current))}
              y={0}
              width={Math.abs(xAt(dragging.current) - xAt(dragging.anchor))}
              height={height}
              fill={ACCENT}
              opacity={0.12}
            />
          ) : null}
          {ticks.map((minute) => (
            <text key={minute} x={xAt(minute)} y={height + 11} fontSize={9} fill={CAPTION} textAnchor={minute === 0 ? 'start' : minute === 1440 ? 'end' : 'middle'}>
              {label(minute)}
            </text>
          ))}
        </svg>
        {hover ? (
          <div style={{
            position: 'absolute',
            top: 4,
            left: `calc(${hover.x}% + ${hover.x > 55 ? -12 : 12}px)`,
            transform: hover.x > 55 ? 'translateX(-100%)' : 'none',
            pointerEvents: 'none',
            background: 'Canvas',
            color: 'CanvasText',
            border: `1px solid ${CARD_BORDER}`,
            borderRadius: RADIUS,
            boxShadow: '0 8px 24px rgba(16,24,40,.22)',
            padding: '5px 8px',
            fontSize: FS.xs,
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            zIndex: 2,
          }}>
            <div style={{ fontFamily: MONO, fontWeight: 600 }}>
              {`${String(Math.floor(hover.point.minute / 60)).padStart(2, '0')}:${String(Math.round(hover.point.minute % 60)).padStart(2, '0')}`}
              {'  '}
              {t(`panel.asr.hb.state.${hover.point.state}`)}
            </div>
            <div style={{ color: FG2 }}>
              {t('panel.asr.hb.tipSpeech').replace('{s}', hover.point.speech.toFixed(1))}
              {' · '}
              {t('panel.asr.hb.tipRows').replace('{n}', String(hover.point.snippets))}
            </div>
          </div>
        ) : null}
      </div>
      <div style={{ ...smallStyle, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* 没有断点就直接给一句「全时段正常」，比列三个数字更不容易看错 */}
        {summary.gap === 0 ? (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: SUCCESS, fontWeight: 600 }}>
              <span style={{ width: 6, height: 6, borderRadius: RADIUS_PILL, background: SUCCESS }} />
              {t('panel.asr.hb.allGood')}
            </span>
            <span style={{ color: CAPTION }}>
              {t('panel.asr.hb.legend.ok')} {summary.ok} · {t('panel.asr.hb.legend.idle')} {summary.idle}
            </span>
          </>
        ) : (
          <>
            <span style={{ color: SUCCESS }}>{t('panel.asr.hb.legend.ok')} {summary.ok}</span>
            <span>{t('panel.asr.hb.legend.idle')} {summary.idle}</span>
            <span style={{ color: DANGER, fontWeight: 600 }}>{t('panel.asr.hb.legend.gap')} {summary.gap}</span>
          </>
        )}
        {zoom ? (
          <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => setZoom(null)}>
            {t('panel.asr.mem.resetZoom')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function MemoryTimeline({ samples, day, range, onRange, t }: {
  samples: MemorySampleDTO[]
  day: Array<{ minute: number; occupied: number; heap: number; audio: number; fixed: number; mapped: number }>
  range: 'minute' | 'hour' | 'day'
  onRange: (next: 'minute' | 'hour' | 'day') => void
  t: (key: string) => string
}): ReactElement {
  // 最近 1 小时：横轴是「过去 60 分钟」；全天：00:00–24:00
  const nowMinute = (() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })()
  const baseSpan = range === 'minute' ? 5 : range === 'hour' ? 60 : 1440
  const baseStart = range === 'day' ? 0 : Math.max(0, nowMinute - baseSpan)
  const baseEnd = range === 'day' ? 1440 : Math.max(baseSpan, nowMinute)
  // 用户拖出来的窗口；空表示跟着「最近 1 小时 / 全天」走
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null)
  const [dragging, setDragging] = useState<{ anchor: number; current: number } | null>(null)
  const [hover, setHover] = useState<{ minute: number; x: number; point: { minute: number; heap: number; audio: number; fixed: number; mapped: number } } | null>(null)
  const windowStart = zoom ? zoom.start : baseStart
  const windowEnd = zoom ? zoom.end : baseEnd
  const span = Math.max(1, windowEnd - windowStart)
  const latestStatus = samples.at(-1)
  const latest = day.at(-1)
  const width = 560
  const height = 96
  const pad = 6
  const stacks = [
    { key: 'heap' as const, color: 'var(--dsw-alias-chart-messages)' },
    { key: 'audio' as const, color: 'var(--dsw-alias-chart-audio)' },
    { key: 'fixed' as const, color: FG2 },
  ]
  const totals = day.map((point) => stacks.reduce((sum, part) => sum + (point[part.key] || 0), 0))
  const max = Math.max(1, ...totals)
  const xAt = (minute: number): number => ((Math.min(windowEnd, Math.max(windowStart, minute)) - windowStart) / span) * width
  const minuteAt = (px: number): number => windowStart + (px / width) * span
  const yAt = (value: number): number => height - pad - (value / max) * (height - pad * 2)

  // 逐层累加：第 i 层的上边界是前 i 层之和
  const bands = (() => {
    let running = day.map(() => 0)
    const out: Array<{ path: string; color: string }> = []
    for (const part of stacks) {
      const lower = running.slice()
      running = running.map((value, index) => value + (day[index][part.key] || 0))
      const upper = running.slice()
      if (!day.length) break
      const top = day.map((point, index) => `${xAt(point.minute).toFixed(1)},${yAt(upper[index]).toFixed(1)}`)
      const bottom = day.map((point, index) => `${xAt(point.minute).toFixed(1)},${yAt(lower[index]).toFixed(1)}`).reverse()
      out.push({ path: `M${top.join(' L')} L${bottom.join(' L')} Z`, color: part.color })
    }
    return out
  })()

  const ticks = range === 'minute'
    ? [0, 1, 2, 3, 4, 5].map((offset) => Math.round(windowStart + offset))
    : range === 'hour'
      ? [0, 15, 30, 45, 60].map((offset) => Math.round(windowStart + offset))
      : [0, 360, 720, 1080, 1440]
  const totalLabel = latest
    ? formatBytes(stacks.reduce((sum, part) => sum + (latest[part.key] || 0), 0), true)
    : latestStatus ? formatBytes(latestStatus.occupied ?? latestStatus.footprint, true) : '—'

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: FS.sm, fontWeight: 600 }}>{t('panel.asr.foot')}</span>
        <span style={{ fontFamily: MONO, fontSize: FS.num, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{totalLabel}</span>
        <span style={{ flex: '1 1 auto' }} />
        {(['minute', 'hour', 'day'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            style={{
              ...buttonStyle,
              ...(range === mode ? { borderColor: ACCENT, color: ACCENT, background: ACCENT_SOFT } : {}),
            }}
            onClick={() => { setZoom(null); onRange(mode) }}
          >
            {t(`panel.asr.mem.range.${mode}`)}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height + 14}`}
        width="100%"
        height={height + 14}
        role="img"
        style={{ display: 'block', marginTop: 4, background: SURFACE_SOFT, borderRadius: RADIUS_CHIP, cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={(event) => {
          if (!event.isPrimary) return
          const rect = event.currentTarget.getBoundingClientRect()
          const minute = minuteAt(((event.clientX - rect.left) / rect.width) * width)
          setDragging({ anchor: minute, current: minute })
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          const minute = minuteAt(ratio * width)
          if (dragging) setDragging({ ...dragging, current: minute })
          // 悬停取最近的一个采样点，显示那一刻的分类占用
          if (!day.length) return
          let nearest = day[0]
          let distance = Math.abs(day[0].minute - minute)
          for (const point of day) {
            const diff = Math.abs(point.minute - minute)
            if (diff < distance) { nearest = point; distance = diff }
          }
          setHover({ minute: nearest.minute, x: ratio * 100, point: nearest })
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(event) => {
          if (!dragging) return
          const start = Math.min(dragging.anchor, dragging.current)
          const end = Math.max(dragging.anchor, dragging.current)
          setDragging(null)
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
          if (end - start >= 2) setZoom({ start, end })
        }}
        onPointerCancel={() => setDragging(null)}
      >
        {bands.map((band, index) => (
          <path key={index} d={band.path} fill={band.color} opacity={0.45} stroke={band.color} strokeWidth={1} strokeOpacity={0.7} />
        ))}
        {latest && latest.mapped > 0 ? (
          <path
            d={day.map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(point.minute).toFixed(1)},${(height - pad * 2).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={BORDER}
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        ) : null}
        {dragging && Math.abs(dragging.current - dragging.anchor) > 0.2 ? (
          <rect
            x={xAt(Math.min(dragging.anchor, dragging.current))}
            y={0}
            width={Math.abs(xAt(dragging.current) - xAt(dragging.anchor))}
            height={height}
            fill={ACCENT}
            opacity={0.12}
          />
        ) : null}
        {ticks.map((minute) => (
          <text key={minute} x={xAt(minute)} y={height + 11} fontSize={9} fill={CAPTION} textAnchor={minute === 0 ? 'start' : minute === 1440 ? 'end' : 'middle'}>
            {`${String(Math.floor(minute / 60)).padStart(2, '0')}:${range === 'minute' ? String(Math.round(minute % 60)).padStart(2, '0') : '00'}`}
          </text>
        ))}
      </svg>
      {hover ? (
        <div style={{
          position: 'absolute',
          top: 4,
          left: `calc(${hover.x}% + ${hover.x > 55 ? -12 : 12}px)`,
          transform: hover.x > 55 ? 'translateX(-100%)' : 'none',
          pointerEvents: 'none',
          // 用系统实色 Canvas：浅色白、深色近黑，不会像半透明浮层那样透出下面的曲线
          background: 'Canvas',
          color: 'CanvasText',
          border: `1px solid ${CARD_BORDER}`,
          borderRadius: RADIUS,
          boxShadow: '0 8px 24px rgba(16,24,40,.22)',
          padding: '5px 8px',
          fontSize: FS.xs,
          lineHeight: 1.6,
          whiteSpace: 'nowrap',
          zIndex: 2,
        }}>
          <div style={{ fontFamily: MONO, fontWeight: 600, marginBottom: 2 }}>
            {`${String(Math.floor(hover.minute / 60)).padStart(2, '0')}:${String(Math.round(hover.minute % 60)).padStart(2, '0')}`}
            {'  '}
            {formatBytes((hover.point.heap || 0) + (hover.point.audio || 0) + (hover.point.fixed || 0), true)}
          </div>
          {stacks.map((part) => (
            <div key={part.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ width: 6, height: 6, borderRadius: RADIUS_PILL, background: part.color }} />
              <span style={{ color: FG2 }}>{t(`panel.asr.mem.${part.key}`)}</span>
              <span style={{ fontFamily: MONO, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(hover.point[part.key], true)}</span>
            </div>
          ))}
          {(hover.point.mapped || 0) > 0 ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: 0.7 }}>
              <span style={{ width: 6, height: 6, borderRadius: RADIUS_PILL, background: BORDER }} />
              <span style={{ color: FG2 }}>{t('panel.asr.mem.mapped')}</span>
              <span style={{ fontFamily: MONO, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(hover.point.mapped, true)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
      <div style={{ ...smallStyle, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span>{t('panel.asr.mem.dragHint')}</span>
        {zoom ? (
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: 'auto' }}
            onClick={() => setZoom(null)}
          >
            {t('panel.asr.mem.resetZoom')}
          </button>
        ) : null}
      </div>
      {latest ? (
        <div style={{ display: 'grid', gridTemplateColumns: '8px 72px 72px', columnGap: 8, alignItems: 'center', marginTop: 4, fontSize: FS.xs }}>
          {stacks.map((part) => (
            <Fragment key={part.key}>
              <span style={{ width: 8, height: 8, borderRadius: RADIUS_PILL, background: part.color }} />
              <span>{t(`panel.asr.mem.${part.key}`)}</span>
              <span style={{ fontFamily: MONO, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(latest[part.key], true)}</span>
            </Fragment>
          ))}
          <span style={{ width: 8, height: 8, borderRadius: RADIUS_PILL, background: BORDER }} />
          <span>{t('panel.asr.mem.mapped')}</span>
          <span style={{ fontFamily: MONO, textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{formatBytes(latest.mapped, true)}</span>
        </div>
      ) : (
        <div style={{ ...smallStyle, marginTop: 4 }}>{t('panel.asr.mem.wait')}</div>
      )}
    </div>
  )
}

function formatBytes(bytes: number | null | undefined, zero = false): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return zero ? '0 KB' : '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function jobSeconds(job: JobDTO): number {
  if ((job.status === 'running' || job.status === 'queued') && job.startedAt) {
    const started = Date.parse(job.startedAt)
    if (Number.isFinite(started)) return Math.max(0, Math.floor((Date.now() - started) / 1000))
  }
  return Math.max(0, Math.round((job.elapsedMs ?? 0) / 1000))
}

/**
 * 今日和说话人识别共用的「选区 + 时间轴」：一份交互，不要各写一套。
 * 选区信息、快捷按钮、密度图（缩放 / 平移 / 拖拽）都在这里。
 */
function RangeSelector(props: {
  t: (key: string) => string
  buckets: Array<{ m: number; s: number }>
  windowStart: number
  windowEnd: number
  selection: { start: number; end: number }
  now: number | null
  minutes: number
  captureMinutes: number
  speechMinutes: number
  intervals?: Array<{ start: number; end: number; label?: string }>
  intervalsLabel?: string
  onDraft: (range: { start: number; end: number }) => void
  onCommit: (range: { start: number; end: number }) => void
  onLast2h: () => void
  onAll: () => void
  last2hDisabled?: boolean
  allDisabled?: boolean
  extra?: ReactNode
  /** 时间轴高度，可拖动调整。 */
  height?: number
  onResize?: (height: number) => void
}): ReactElement {
  const { t } = props
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ ...smallStyle, color: FG2, flex: '1 1 auto', minWidth: 0, lineHeight: '16px' }}>
          {t('panel.selection')}
          {' '}
          <span style={{ fontFamily: MONO, color: FG }}>{clock(props.selection.start)}–{clock(props.selection.end)}</span>
          {' '}· {props.minutes} {t('unit.min')}
          {' '}· {t('panel.captured')} {props.captureMinutes} {t('unit.min')}
          {' '}· {t('panel.speech')} {props.speechMinutes.toFixed(1)} {t('unit.min')}
        </span>
        {props.extra}
        <button type="button" style={buttonStyle} disabled={props.last2hDisabled} onClick={props.onLast2h}>{t('panel.last2h')}</button>
        <button type="button" style={buttonStyle} disabled={props.allDisabled} onClick={props.onAll}>{t('panel.allDay')}</button>
      </div>
      <TimelineChart
        buckets={props.buckets}
        start={props.windowStart}
        end={props.windowEnd}
        selection={props.selection}
        now={props.now}
        labels={{
          density: t('panel.density'),
          hint: t('panel.densityHint'),
          gap: t('panel.legend.gap'),
          speech: t('panel.legend.speech'),
          now: t('panel.now'),
        }}
        {...(props.intervals?.length ? { intervals: props.intervals } : {})}
        {...(props.intervalsLabel ? { intervalsLabel: props.intervalsLabel } : {})}
        formatTime={(minute) => clock(minute)}
        onDraft={props.onDraft}
        onCommit={props.onCommit}
        {...(props.height ? { height: props.height } : {})}
      />
      {props.onResize ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          title={t('panel.chart.resize')}
          onPointerDown={(event) => {
            if (!event.isPrimary) return
            dragRef.current = { startY: event.clientY, startHeight: props.height ?? 150 }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || !event.isPrimary) return
            const next = Math.min(420, Math.max(80, drag.startHeight + (event.clientY - drag.startY)))
            props.onResize?.(next)
          }}
          onPointerUp={(event) => {
            dragRef.current = null
            try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已经释放 */ }
          }}
          style={{
            height: 8,
            margin: '2px 0 4px',
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none',
          }}
        >
          <span style={{ width: 44, height: 3, borderRadius: RADIUS_PILL, background: BORDER }} />
        </div>
      ) : null}
    </>
  )
}


/** 名字太长会撑破列宽，取括号前的部分再截断。 */

/** 列表里只给前若干字，点进单日看全文。 */
function summaryOf(text: string, max = 160): string {
  const plain = text
    .split('\n')
    .map((line) => line.replace(/^[>#*\-\s]+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

function shortSpeaker(name: string): string {
  const base = name.split(/[（(]/)[0].trim()
  return base.length > 6 ? `${base.slice(0, 6)}…` : base
}

/** 转写行里的「说话人」标签，今日和说话人识别共用。 */

/**
 * 三个内容页共用的页头：左边标题 + 说明，右边操作。
 * 之前各页各写一套，间距和基线都不一样，对齐看着发飘。
 */
function PageHeader(props: {
  title: string
  meta?: string
  actions?: ReactNode
  hint?: string
  extra?: ReactNode
}): ReactElement {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
        <span style={{ fontSize: FS.sm, fontWeight: 600, flex: '0 0 auto' }}>{props.title}</span>
        {props.meta ? <span style={{ ...smallStyle, flex: '1 1 auto', minWidth: 0 }}>{props.meta}</span> : <span style={{ flex: '1 1 auto' }} />}
        {props.actions ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>{props.actions}</div> : null}
      </div>
      {props.extra}
      {props.hint ? (
        <div style={{ ...smallStyle, lineHeight: 1.55, marginTop: 4 }}>{props.hint}</div>
      ) : null}
    </div>
  )
}

function SpeakerChip({ name, score }: { name: string; score?: number }): ReactElement {
  return (
    <span
      title={name ? `${name}${typeof score === 'number' ? ` · 相似度 ${score.toFixed(2)}` : ''}` : '未分配'}
      style={{
        justifySelf: 'start',
        display: 'inline-block',
        maxWidth: '100%',
        fontSize: FS.xs,
        lineHeight: '16px',
        padding: '0 4px',
        borderRadius: RADIUS_CHIP,
        border: `1px solid ${BORDER}`,
        background: name ? ACCENT_SOFT : 'transparent',
        color: name ? ACCENT : CAPTION,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        verticalAlign: 'middle',
      }}
    >
      {name ? shortSpeaker(name) : '—'}
      {name && typeof score === 'number' ? (
        <span style={{ opacity: 0.7, marginLeft: 3 }}>{score.toFixed(2)}</span>
      ) : null}
    </span>
  )
}

function JobBadge({ job, t }: { job: JobDTO; t: (key: string) => string }) {
  // 排队是等待，不是进行中；只有 running 算「当前正在发生」。
  const color = job.status === 'done'
    ? SUCCESS
    : job.status === 'failed'
      ? DANGER
      : job.status === 'running'
        ? ACCENT
        : FG2
  return (
    <span style={{ fontSize: FS.xs, color, border: `1px solid ${BORDER}`, background: BG2, borderRadius: RADIUS_CHIP, padding: '0 4px', whiteSpace: 'nowrap' }}>
      {t(`panel.jobs.status.${job.status}`)}
    </span>
  )
}

function JobDetail({ job, t }: { job: JobDTO; t: (key: string) => string }) {
  if (job.status === 'queued') return <span style={{ color: CAPTION }}>{t('panel.jobs.queuedHint')}</span>
  if (job.status === 'running') {
    return (
      <span>
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: ACCENT, marginRight: 5, animation: 'mm-pulse 1.1s ease-in-out infinite' }} />
        {t('panel.today.running')}… {jobSeconds(job)}s
      </span>
    )
  }
  if (job.status === 'done') {
    return <span style={{ color: SUCCESS }}>{t('panel.today.generated')} · {job.added ?? 0} 场 · {jobSeconds(job)}s</span>
  }
  if (job.status === 'cancelled') return <span style={{ color: CAPTION }}>{t('panel.jobs.status.cancelled')}</span>
  return (
    <span style={{ color: DANGER }}>
      {t('panel.today.failed')}：{job.error?.message || t('panel.jobs.status.failed')}
      {job.error?.hint ? ` · ${job.error.hint}` : ''}
    </span>
  )
}

function JobRow({ job, t, onCancel }: { job: JobDTO; t: (key: string) => string; onCancel: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: FS.xs, minWidth: 0, color: job.status === 'failed' ? DANGER : CAPTION }}>
      <span style={{ flex: '0 0 auto', fontFamily: MONO }}>{clock(job.start)}–{clock(job.end)}</span>
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <JobDetail job={job} t={t} />
      </span>
      {(job.status === 'queued' || job.status === 'running') ? (
        <button type="button" style={{ ...buttonStyle, padding: '1px 6px', color: DANGER }} onClick={() => onCancel(job.id)}>
          {t('panel.jobs.cancel')}
        </button>
      ) : null}
    </div>
  )
}
