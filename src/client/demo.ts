/**
 * 演示模式：给六个页面喂一套固定的假数据，和真实文件完全隔离。
 *
 * 为什么放在客户端：演示只针对页面。放宿主就得在每条 RPC 前判断开关，
 * 还要逐条保证不写真实文件——漏一处就会把演示数据写进真实纪要。
 * 这里拦截在数据入口，结构上做不到写文件。
 *
 * 用法：面板的 rpc() 先问 demoResponse(op, payload)，返回 null 才走真实 RPC。
 */
import type {
  AsrModelsPayload,
  AsrStatusDTO,
  BackgroundsPayload,
  DayPayload,
  JobDTO,
  MinutesOverview,
  MinutesPayload,
  MinutesRangeDTO,
  SkillDTO,
  SpeakerPayload,
  UpdateStatusDTO,
} from '../types.ts'

const DAY = '2026-11-17'

function at(hour: number, minute: number): string {
  return `${DAY}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`
}

/** 12 条转写：覆盖「有名字 / 未识别 / 系统轨 / 麦克风轨」四种形态。 */
const SEGMENTS = [
  { s: 545, e: 546.5, track: 'system', text: '我们今天过一下本体平台和航信的对接方案。', speaker: '张思齐', speakerScore: 0.88, line: 1 },
  { s: 547, e: 549, track: 'system', text: '他们那边现在主要卡在数据接入这一层，接口对不上。', speaker: '肖晓东', speakerScore: 0.81, line: 2 },
  { s: 550, e: 551.2, track: 'mic', text: '我补充一句，客座率和合同评审这两个场景可以先做试点。', speaker: '龙嘉奇', speakerScore: 0.79, line: 3 },
  { s: 553, e: 554.8, track: 'system', text: '试点清单谁来出？我这边可以出对象类型的部分。', speaker: '张思齐', speakerScore: 0.84, line: 4 },
  { s: 556, e: 557.4, track: 'system', text: '那数据来源和接口的部分我们技术团队来补。', speaker: '肖晓东', speakerScore: 0.77, line: 5 },
  { s: 559, e: 560, track: 'mic', text: '好，那下周三之前把清单汇总到我这里。', speaker: '龙嘉奇', speakerScore: 0.83, line: 6 },
  { s: 562, e: 563.6, track: 'system', text: '另外文档解析和大模型这两个接口需要提前准备。', line: 7 },
  { s: 565, e: 566.2, track: 'system', text: '对，应用侧如果要快速搭问答，绕不开这两个。', speaker: '张思齐', speakerScore: 0.8, line: 8 },
  { s: 568, e: 569.5, track: 'mic', text: '提醒一下，业务专家那边的设想文档也要同步。', speaker: '龙嘉奇', speakerScore: 0.75, line: 9 },
  { s: 571, e: 572.4, track: 'system', text: '那个文档是本体演进的基准，确实得补。', speaker: '肖晓东', speakerScore: 0.82, line: 10 },
  { s: 574, e: 575, track: 'system', text: '行，那今天就先到这里，会后我把材料发群里。', speaker: '张思齐', speakerScore: 0.86, line: 11 },
  { s: 576, e: 576.8, track: 'mic', text: '好，谢谢大家。', line: 12 },
]

const BUCKETS = [
  538, 539, 540, 545, 546, 547, 548, 549, 550, 551, 552, 553, 554, 555, 556,
  557, 558, 559, 560, 561, 562, 563, 564, 565, 566, 567, 568, 569, 570, 571,
  572, 573, 574, 575, 576, 577,
].map((minute, index) => ({
  m: minute,
  s: 30 + (index % 7) * 6,
  c: 80 + (index % 5) * 20,
  n: 1,
}))

const DAILY: DayPayload = {
  day: DAY,
  today: DAY,
  days: ['2026-11-13', '2026-11-14', '2026-11-16', DAY],
  root: '/Users/you/.dsh/meeting-memo/asr-log',
  files: { activity: true, snippets: true },
  filePaths: {
    activity: `/Users/you/.dsh/meeting-memo/asr-log/${DAY}/activity.jsonl`,
    snippets: `/Users/you/.dsh/meeting-memo/asr-log/${DAY}/snippets.jsonl`,
  },
  window: { start: 0, end: 1440 },
  buckets: BUCKETS,
  segments: SEGMENTS,
  segmentsTotal: SEGMENTS.length,
  truncated: false,
  stats: {
    segments: SEGMENTS.length,
    chars: SEGMENTS.reduce((sum, segment) => sum + segment.text.length, 0),
    speechMinutes: 31.6,
    captureMinutes: 38,
    firstMinute: 538,
    lastMinute: 577,
    tracks: { mic: 4, system: 8 },
  },
  hourly: [],
  selection: { start: 545, end: 577 },
  warnings: [],
  inspected: [],
  home: '/Users/you/.dsh/meeting-memo',
  sources: [],
} as unknown as DayPayload

const MINUTES_CONTENT = `> 💡 **本场背景与目标**

演示数据：一场关于本体平台与客户系统对接的沟通会，目的是确认试点场景和分工。

### 核心结论

- 客座率、合同评审两个场景先做试点。
- 数据接入由客户技术团队配合，接口清单双方各出一半。
- 文档解析与大模型接口要提前准备。

### TODO

- 会后把材料发群 — 会议组织方
- 按场景梳理试点清单 — 双方项目组
- 准备两个接口 — 应用侧

### 相关链接与资源

- 本体构建运营平台
- 业务设想文档`

const SESSIONS = [
  {
    id: 'demo-1',
    start: 545,
    end: 577,
    topic: '本体平台与客户系统对接',
    content: MINUTES_CONTENT,
    source: 'ai' as const,
    updatedAt: at(11, 30),
  },
  {
    id: 'demo-2',
    start: 600,
    end: 620,
    topic: '周会：本周进度与风险',
    content: '> 💡 **本场背景与目标**\n\n演示数据：周会同步进度与风险。\n\n### 核心结论\n\n- 演示环境恢复正常。\n\n### TODO\n\n- 周四下班前交周报 — 项目组',
    source: 'ai' as const,
    updatedAt: at(10, 30),
  },
]

const MINUTES: MinutesPayload = {
  day: DAY,
  title: '演示模式',
  note: '',
  updatedAt: at(11, 30),
  model: 'demo/model',
  sessions: SESSIONS,
  jsonPath: `/Users/you/.dsh/meeting-memo/minutes/${DAY}.json`,
  mdPath: `/Users/you/.dsh/meeting-memo/minutes/${DAY}.md`,
  markdown: '',
}

const OVERVIEW: MinutesOverview = {
  day: DAY,
  today: DAY,
  days: [DAY],
  root: '/Users/you/.dsh/meeting-memo/minutes',
  minutes: MINUTES,
}

const RANGE: MinutesRangeDTO = {
  mode: 'week',
  today: DAY,
  days: ['2026-11-16', DAY],
  total: 3,
  groups: [
    { day: DAY, sessions: SESSIONS, mdPath: `/Users/you/.dsh/meeting-memo/minutes/${DAY}.md` },
    {
      day: '2026-11-16',
      sessions: [{
        id: 'demo-3',
        start: 400,
        end: 430,
        topic: '插件面板与时间轴',
        content: '> 💡 **本场背景与目标**\n\n演示数据：讨论面板交互。\n\n### 核心结论\n\n- 时间轴支持拖拽选区。',
        source: 'ai' as const,
        updatedAt: at(9, 0),
      }],
      mdPath: '/Users/you/.dsh/meeting-memo/minutes/2026-11-16.md',
    },
  ],
}

const BACKGROUNDS: BackgroundsPayload = {
  items: [
    {
      id: 'bg-1',
      title: '客户背景',
      tags: ['客户', '民航'],
      content: '演示数据：客户主业是航空信息系统，关注点在于数据接入与航班场景。',
      createdAt: at(9, 0),
      updatedAt: at(9, 0),
    },
    {
      id: 'bg-2',
      title: '术语表',
      tags: ['术语'],
      content: '演示数据：本体 / 对象类型 / 属性 / 连接器 / 业务设想文档。',
      createdAt: at(9, 0),
      updatedAt: at(9, 0),
    },
  ],
  selection: ['bg-1'],
}

const JOBS: JobDTO[] = [
  {
    id: 'job-1',
    day: DAY,
    start: 545,
    end: 577,
    backgroundIds: ['bg-1'],
    status: 'done',
    createdAt: at(11, 0),
    startedAt: at(11, 0),
    finishedAt: at(11, 2),
    elapsedMs: 118_000,
    added: 1,
    model: 'demo/model',
    topic: '本体平台与客户系统对接',
  },
  {
    id: 'job-2',
    day: DAY,
    start: 600,
    end: 620,
    backgroundIds: [],
    status: 'running',
    createdAt: at(11, 25),
    startedAt: at(11, 25),
    topic: '周会：本周进度与风险',
  },
]

const MEMORY = Array.from({ length: 8 }, (_, index) => ({
  at: new Date(Date.now() - (7 - index) * 8_000).toISOString(),
  rss: 130 * 1024 * 1024,
  footprint: (72 + index) * 1024 * 1024,
  occupied: (72 + index) * 1024 * 1024,
  model: 0,
  mapped: 452 * 1024 * 1024,
  audio: 6 * 1024 * 1024,
  heap: (60 + index) * 1024 * 1024,
  fixed: 5 * 1024 * 1024,
}))

const ASR: AsrStatusDTO = {
  enabled: true,
  running: true,
  phase: 'running',
  mode: 'tracks',
  language: 'zhen',
  model: {
    id: 'sensevoice-coreml-int8',
    name: 'SenseVoiceSmall_int8 苹果 Core ML',
    path: '/Users/you/.dsh/meeting-memo/models/SenseVoiceSmall_int8',
    kind: 'coreml-sensevoice',
    format: 'coreml',
    summary: '苹果系统默认',
    bytes: 227 * 1024 * 1024,
    appleCoreML: true,
  },
  rssBytes: 130 * 1024 * 1024,
  memory: MEMORY,
  logRoot: '/Users/you/.dsh/meeting-memo/asr-log',
  helper: '/Users/you/.dsh/meeting-memo/bin/asr-helper',
  mic: true,
  system: true,
  audio: { mic: 'ok', system: 'ok', silentMinutes: 0 },
  audioRestarts: 0,
  message: '正在录音并转写。',
  startedAt: at(9, 0),
  lastSnippetAt: at(11, 30),
  lastError: null,
  input: 'MacBook Pro麦克风',
  inputUID: '',
  inputs: [{ uid: 'builtin', name: 'MacBook Pro麦克风', default: true }],
} as unknown as AsrStatusDTO

const MODELS: AsrModelsPayload = {
  selectedId: 'sensevoice-coreml-int8',
  library: null,
  defaultRoot: '/Users/you/.dsh/meeting-memo/models',
  bundledDir: '/Users/you/.dsh/meeting-memo/models',
  models: [
    {
      id: 'sensevoice-coreml-int8',
      name: 'SenseVoiceSmall_int8 苹果 Core ML',
      path: '/Users/you/.dsh/meeting-memo/models/SenseVoiceSmall_int8',
      kind: 'coreml-sensevoice',
      format: 'coreml',
      summary: '苹果系统默认 · 227 MB',
      bytes: 227 * 1024 * 1024,
      usable: true,
      addedAt: at(9, 0),
    },
    {
      id: 'sensevoice-small',
      name: 'sensevoice-small ONNX fp32',
      path: '/Users/you/.dsh/meeting-memo/models/sensevoice-small',
      kind: 'onnx',
      format: 'onnx',
      summary: '跨平台 · 1000 MB',
      bytes: 1000 * 1024 * 1024,
      usable: true,
      addedAt: at(9, 0),
    },
  ],
  offers: [],
  downloads: [],
  suggestion: null,
} as unknown as AsrModelsPayload

const SPEAKERS: SpeakerPayload = {
  total: 3,
  audioOn: false,
  groups: [{
    day: DAY,
    items: [
      { id: 'spk-1', day: DAY, start: 545, end: 549, label: '张思齐', note: '测试负责人', lines: [1, 2, 4, 8, 11], createdAt: at(11, 40), samples: 5, audioCount: 5 },
      { id: 'spk-2', day: DAY, start: 547, end: 557, label: '肖晓东', note: '后端研发', lines: [2, 5, 10], createdAt: at(11, 41), samples: 3, audioCount: 3 },
      { id: 'spk-3', day: DAY, start: 550, end: 569, label: '龙嘉奇', note: '产品', lines: [3, 6, 9, 12], createdAt: at(11, 42), samples: 4, audioCount: 4 },
    ],
  }],
} as unknown as SpeakerPayload

const ASSIGNMENTS = {
  day: DAY,
  map: Object.fromEntries(SEGMENTS.filter((segment) => 'speaker' in segment).map((segment) => [
    String(segment.line),
    { speaker: 'live', name: String((segment as { speaker?: string }).speaker), track: segment.track, score: (segment as { speakerScore?: number }).speakerScore ?? 0.8, source: 'live' },
  ])),
}

const SKILLS: { selectedId: string; skills: SkillDTO[] } = {
  selectedId: 'default',
  skills: [{
    id: 'default',
    name: '默认纪要',
    description: '演示用技能：背景、结论、TODO、链接四段。',
    prompt: '把转写整理成背景 / 核心结论 / TODO / 相关链接与资源。',
    builtin: true,
  } as unknown as SkillDTO],
}

const UPDATE: UpdateStatusDTO = {
  mode: 'link',
  current: '0.0.0-demo',
  latest: null,
  hasUpdate: false,
  checkedAt: null,
  command: '',
}

export const DEMO_DATA = {
  day: DAILY,
  minutes: MINUTES,
  overview: OVERVIEW,
  range: RANGE,
  backgrounds: BACKGROUNDS,
  jobs: JOBS,
  asr: ASR,
  models: MODELS,
  speakers: SPEAKERS,
  assignments: ASSIGNMENTS,
  skills: SKILLS,
  update: UPDATE,
}

/** 读操作 → 夹具 */
const READ_OPS: Record<string, unknown> = {
  day: DEMO_DATA.day,
  'minutes.list': DEMO_DATA.overview,
  'minutes.range': DEMO_DATA.range,
  'minutes.index': { text: `当前日志切片（演示数据）\n文件: ${DEMO_DATA.day.filePaths.snippets}\n要读的行: 1-12` },
  'backgrounds.list': DEMO_DATA.backgrounds,
  'jobs.list': { jobs: DEMO_DATA.jobs },
  'asr.status': DEMO_DATA.asr,
  'asr.models': DEMO_DATA.models,
  'models.list': DEMO_DATA.models,
  'speaker.list': DEMO_DATA.speakers,
  'speaker.assignments': DEMO_DATA.assignments,
  'skills.list': DEMO_DATA.skills,
  'update.check': DEMO_DATA.update,
  'system.status': { root: DEMO_DATA.day.root, today: DAY, days: DEMO_DATA.day.days },
}

/** 写操作 → 空实现（界面表现「成功」，但不落盘） */
const WRITE_OPS: Record<string, unknown> = {
  'minutes.upsert': { added: 0, day: DAY, demo: true },
  'minutes.delete': { removed: 1, demo: true },
  'minutes.clear': { cleared: 1, demo: true },
  'minutes.generate': { added: 1, model: 'demo/model', elapsedMs: 1200, demo: true },
  'jobs.start': { job: DEMO_DATA.jobs[1] },
  'jobs.cancel': { cancelled: true, demo: true },
  'jobs.clear': { cleared: 1, demo: true },
  'backgrounds.save': { item: DEMO_DATA.backgrounds.items[0], items: DEMO_DATA.backgrounds.items },
  'backgrounds.delete': { removed: 1, items: DEMO_DATA.backgrounds.items },
  'speaker.add': { item: DEMO_DATA.speakers.groups[0].items[0], total: 3 },
  'speaker.delete': { total: 3 },
  'speaker.enrollRecent': { samples: 3, day: DAY },
  'asr.set': DEMO_DATA.asr,
  'models.select': DEMO_DATA.models,
  'models.remove': DEMO_DATA.models,
  'models.add': DEMO_DATA.models,
  'update.apply': { ok: true, output: '演示模式不会真的更新' },
}

export function isDemoOp(op: string): boolean {
  return op in READ_OPS || op in WRITE_OPS
}

export function isDemoWrite(op: string): boolean {
  return op in WRITE_OPS
}

export type DemoResult = { ok: true; value: unknown }

/** 返回 null 表示「演示模式不接管这个操作」，调用方走真实 RPC。 */
export function demoResponse(op: string, _payload?: unknown): DemoResult | null {
  void _payload
  if (!active) return null
  if (op in READ_OPS) return { ok: true, value: READ_OPS[op] }
  if (op in WRITE_OPS) return { ok: true, value: WRITE_OPS[op] }
  return null
}

const FLAG = 'dsh-mm-demo'

/** 当前是否处于演示模式；面板切换时改这里，rpc 每次调用都会读。 */
let active = (() => {
  try {
    return window.localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
})()

export function setDemoActive(on: boolean): void {
  active = on
  writeDemoFlag(on)
}

export function isDemoActive(): boolean {
  return active
}

export function readDemoFlag(): boolean {
  try {
    return window.localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

export function writeDemoFlag(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(FLAG, '1')
    else window.localStorage.removeItem(FLAG)
  } catch {
    // 隐私模式下只在本次会话生效
  }
}
