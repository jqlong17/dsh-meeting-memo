/** Shapes shared by the Host RPC and the browser panel (type-only imports). */

export interface SegmentDTO {
  /** Start, minutes of local day. */
  s: number
  /** End, minutes of local day. */
  e: number
  track: string
  text: string
  source?: string
  /** 1-based line in snippets.jsonl before merging. */
  line?: number
  /** 合并后的片段可能跨多行；复制索引需要全部行号。 */
  lines?: number[]
}

export interface BucketDTO {
  m: number
  s: number
  c: number
  n: number
}

export interface HourDTO {
  hour: number
  capturedMinutes: number
  speechMinutes: number
  chars: number
  segments: number
}

export interface DayStatsDTO {
  segments: number
  chars: number
  speechMinutes: number
  captureMinutes: number
  firstMinute: number | null
  lastMinute: number | null
  tracks: Record<string, number>
}

export interface SelectionDTO {
  start: number
  end: number
}

export interface RootInspectionDTO {
  root: string
  exists: boolean
  dayCount: number
  latestDay: string | null
}

export interface DayPayload {
  day: string
  today: string
  days: string[]
  root: string
  files: { activity: boolean; snippets: boolean }
  filePaths: { activity: string; snippets: string }
  window: { start: number; end: number }
  buckets: BucketDTO[]
  segments: SegmentDTO[]
  segmentsTotal: number
  truncated: boolean
  stats: DayStatsDTO
  hourly: HourDTO[]
  selection: SelectionDTO
  warnings: string[]
  inspected: RootInspectionDTO[]
  home: string
  sources?: SourceOptionDTO[]
}

export interface SourceOptionDTO {
  id: string
  label: string
  root: string
  exists: boolean
  dayCount: number
  active: boolean
}

export interface AsrModelDTO {
  id: string
  name: string
  path: string
  kind: string
  capabilities?: string[]
  usable?: boolean
  format?: string
  summary?: string
  bytes?: number
  source?: string
  addedAt: string
  note?: string
}

export interface ModelOfferDTO {
  id: string
  name: string
  summary: string
  capabilities: string[]
  usable: boolean
  format: string
  bytesHint: number
  url: string
  present: boolean
}

export interface ModelDownloadDTO {
  id: string
  name: string
  status: 'running' | 'done' | 'failed'
  received: number
  total: number | null
  message: string
}

export interface AsrModelsPayload {
  selectedId: string | null
  library?: string | null
  defaultRoot?: string
  models: AsrModelDTO[]
  offers?: ModelOfferDTO[]
  downloads?: ModelDownloadDTO[]
  bundledDir: string
  suggestion: { ok: boolean; kind: string; path: string; name: string; missing: string[] } | null
}

export interface MemorySampleDTO {
  at: string
  rss: number
  footprint: number
  /** Headline: live charge plus external-model weights when they are not already charged. */
  occupied?: number
  model: number
  mapped: number
  audio: number
  heap: number
  fixed: number
}

export interface AsrStatusDTO {
  enabled: boolean
  running: boolean
  phase: 'idle' | 'starting' | 'running' | 'paused' | 'failed'
  mode: 'raw' | 'tracks' | 'merged'
  language?: 'zhen' | 'zh' | 'en' | 'auto'
  model: { id: string; name: string; path: string; kind?: string; format?: string; summary?: string; bytes?: number; appleCoreML?: boolean } | null
  rssBytes?: number | null
  memory?: MemorySampleDTO[]
  logRoot: string
  helper: string | null
  mic: boolean | null
  system: boolean | null
  /** Whether audio frames really arrive on each track. */
  audio?: {
    mic: 'ok' | 'silent' | 'dead' | 'off'
    system: 'ok' | 'silent' | 'dead' | 'off'
    silentMinutes: number
  }
  audioRestarts?: number
  message: string
  startedAt: string | null
  lastSnippetAt: string | null
  lastError: string | null
}

export interface MinuteSessionDTO {
  id: string
  start: number
  end: number
  topic: string
  /** 这场会议的全部内容，一段 Markdown。 */
  content: string
  source: 'draft' | 'ai' | 'agent' | 'manual'
  updatedAt: string
}

export interface BackgroundCardDTO {
  id: string
  title: string
  tags: string[]
  content: string
  createdAt: string
  updatedAt: string
}

export interface BackgroundsPayload {
  items: BackgroundCardDTO[]
  selection: string[]
}

export interface MinutesPayload {
  day: string
  title: string
  note: string
  updatedAt: string
  /** Provider/model that wrote the AI entries. */
  model?: string
  sessions: MinuteSessionDTO[]
  jsonPath: string
  mdPath: string
  markdown: string
}

export interface SkillDTO {
  id: string
  name: string
  description: string
  prompt: string
  builtin?: boolean
  updatedAt: string
}

export interface SkillsPayload {
  selectedId: string
  skills: SkillDTO[]
}

export interface MinutesOverview {
  day: string
  today: string
  days: string[]
  root: string
  minutes: MinutesPayload
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobDTO {
  id: string
  day: string
  start: number
  end: number
  backgroundIds: string[]
  skillId?: string
  supplements?: string
  status: JobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  elapsedMs?: number
  added?: number
  model?: string
  topic?: string
  error?: { code: string; message: string; hint?: string }
}

export interface RangePayload {
  day: string
  start: number
  end: number
  segments: SegmentDTO[]
  chars: number
  speechMinutes: number
  text: string
  truncated: boolean
}
