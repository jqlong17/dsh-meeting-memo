/** Shapes shared by the Host RPC and the browser panel (type-only imports). */

export interface SegmentDTO {
  /** Start, minutes of local day. */
  s: number
  /** End, minutes of local day. */
  e: number
  track: string
  text: string
  source?: string
  /** 1-based line in snippets.jsonl. */
  line?: number
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
}

export interface MinuteSessionDTO {
  id: string
  start: number
  end: number
  topic: string
  summary: string
  points: string[]
  todos: string[]
  backgrounds?: string[]
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

export interface MinutesOverview {
  day: string
  today: string
  days: string[]
  root: string
  minutes: MinutesPayload
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
