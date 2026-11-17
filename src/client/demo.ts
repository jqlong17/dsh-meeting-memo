/**
 * 演示模式：给六个页面喂一套固定的虚构数据，和真实文件完全隔离。
 *
 * 数据本身是为宣传截图构造的：一家虚构公司「云雀科技」、虚构产品「云雀文档 v2.4」
 * 的一场发布评审。人名、公司、场景、数字全部编造，刻意不采用任何真实会议里的
 * 业务词汇（本体 / 客座率 / 合同评审 / 航信 等），避免宣传素材泄露真实项目。
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

/**
 * 14 条转写，覆盖「有名字 / 未识别 / 系统轨 / 麦克风轨」四种形态。
 * 内容围绕虚构产品 v2.4 的发布评审：灰度、回滚、埋点、压测。
 */
const SEGMENTS = [
  { s: 545, e: 546.6, track: 'system', text: '人都到齐了，今天主要过 v2.4 的发布评审，重点看灰度范围和回滚预案。', speaker: '苏晴', speakerScore: 0.91, line: 1 },
  { s: 547, e: 548.8, track: 'system', text: '先说结论：功能都验收完了，剩下的风险集中在移动端兼容。', speaker: '苏晴', speakerScore: 0.88, line: 2 },
  { s: 550, e: 551.8, track: 'mic', text: '移动端我先说一句，iOS 15 上那个编辑器闪烁昨天已经修了，Android 还差一版。', speaker: '林知远', speakerScore: 0.84, line: 3 },
  { s: 553, e: 554.6, track: 'system', text: '那灰度能不能先只放桌面端？移动端我跟一版再放。', speaker: '陈默', speakerScore: 0.79, line: 4 },
  { s: 556, e: 557.6, track: 'system', text: '可以，灰度策略本来就是按端拆的，改一下配置就行。', speaker: '苏晴', speakerScore: 0.82, line: 5 },
  { s: 559, e: 560.2, track: 'mic', text: '回滚脚本我今天跑了一遍，从 50% 退回 0 大概两分半，比上次快。', speaker: '林知远', speakerScore: 0.86, line: 6 },
  { s: 562, e: 563.6, track: 'system', text: '两分半能接受。埋点那边确认过了吗？新版本的分析要看得到转化。', line: 7 },
  { s: 565, e: 566.4, track: 'system', text: '埋点上周就上了，事件名我贴在变更清单里，别改。', speaker: '陈默', speakerScore: 0.78, line: 8 },
  { s: 568, e: 569.6, track: 'mic', text: '压测结果也出来了，峰值下 P99 是三百二十毫秒，比目标差一点。', speaker: '林知远', speakerScore: 0.81, line: 9 },
  { s: 571, e: 572.4, track: 'system', text: '三百二在可接受范围，先上线观察，超过四百我们再动手。', speaker: '苏晴', speakerScore: 0.85, line: 10 },
  { s: 574, e: 575.2, track: 'system', text: '那时间就定周四晚上八点，我先发公告，文案今天下午给。', speaker: '陈默', speakerScore: 0.8, line: 11 },
  { s: 576, e: 577.4, track: 'mic', text: '好，我周四下午提前把监控看板配好。', speaker: '林知远', speakerScore: 0.76, line: 12 },
  { s: 579, e: 580, track: 'system', text: '那就这么定，散会。', line: 13 },
  { s: 581, e: 582, track: 'mic', text: '辛苦大家。', line: 14 },
]

/** 09:00–09:45，密度有起伏：开头交代、中间讨论、结尾收束。 */
const BUCKETS = Array.from({ length: 46 }, (_, index) => 540 + index).map((minute) => {
  const wave = Math.sin((minute - 540) / 6) * 16 + 32
  return {
    m: minute,
    s: Math.max(6, Math.round(wave + (minute % 5) * 2)),
    c: 80 + (minute % 7) * 18,
    n: 1,
  }
})

const DAILY: DayPayload = {
  day: DAY,
  today: DAY,
  days: ['2026-11-13', '2026-11-14', '2026-11-16', DAY],
  root: '/Users/demo/.dsh/meeting-memo/asr-log',
  files: { activity: true, snippets: true },
  filePaths: {
    activity: `/Users/demo/.dsh/meeting-memo/asr-log/${DAY}/activity.jsonl`,
    snippets: `/Users/demo/.dsh/meeting-memo/asr-log/${DAY}/snippets.jsonl`,
  },
  window: { start: 0, end: 1440 },
  buckets: BUCKETS,
  segments: SEGMENTS,
  segmentsTotal: SEGMENTS.length,
  truncated: false,
  stats: {
    segments: SEGMENTS.length,
    chars: SEGMENTS.reduce((sum, segment) => sum + segment.text.length, 0),
    speechMinutes: 32.4,
    captureMinutes: 46,
    firstMinute: 540,
    lastMinute: 585,
    tracks: { mic: 5, system: 9 },
  },
  hourly: [
    { hour: 8, capturedMinutes: 0, speechMinutes: 0, chars: 0, segments: 0 },
    { hour: 9, capturedMinutes: 46, speechMinutes: 32.4, chars: 612, segments: 14 },
    { hour: 10, capturedMinutes: 20, speechMinutes: 14.2, chars: 288, segments: 7 },
  ],
  selection: { start: 545, end: 582 },
  warnings: [],
  inspected: [],
  home: '/Users/demo/.dsh/meeting-memo',
  sources: [{
    id: 'asr',
    label: '本机转写',
    root: '/Users/demo/.dsh/meeting-memo/asr-log',
    days: 6,
    latest: DAY,
    active: true,
  }],
} as unknown as DayPayload

const SESSION_ONE = `> 💡 **本场背景与目标**

v2.4 功能开发已收尾，本次评审确认灰度范围、回滚预案与上线时间。参会：产品、测试、后端。

### 核心结论

- 灰度按端拆分：周四先放桌面端，移动端等 Android 修复后再放。
- 回滚脚本实测从 50% 退回 0 约两分半，满足要求。
- 峰值 P99 为 320ms，略高于 300ms 目标，先上线观察，超过 400ms 再处理。

### TODO

- 周四 20:00 上线桌面端灰度 — 苏晴
- 发布公告与更新说明 — 陈默
- 监控看板按新版本事件配好 — 林知远
- Android 编辑器闪烁修复后跟进移动端灰度 — 林知远

### 相关链接与资源

- v2.4 变更清单
- 灰度配置说明
- 回滚脚本（ops/rollback-v2.4.sh）
- 埋点事件表`

const SESSION_TWO = `> 💡 **本场背景与目标**

周会同步本周进度与风险，确认下周节奏。

### 核心结论

- 桌面端开发已完成，进入灰度准备。
- 测试用例补齐到 118 条，覆盖率 92%。
- 下周重点是移动端与文档更新。

### TODO

- 周四下班前交周报 — 全体
- 补移动端兼容用例 — 苏晴
- 更新帮助中心截图 — 陈默`

const SESSIONS = [
  {
    id: 'demo-1',
    start: 545,
    end: 582,
    topic: 'v2.4 发布评审',
    content: SESSION_ONE,
    source: 'ai' as const,
    updatedAt: at(10, 6),
  },
  {
    id: 'demo-2',
    start: 600,
    end: 620,
    topic: '周会：本周进度与风险',
    content: SESSION_TWO,
    source: 'ai' as const,
    updatedAt: at(10, 32),
  },
]

const MINUTES: MinutesPayload = {
  day: DAY,
  title: 'v2.4 发布周',
  note: '',
  updatedAt: at(10, 32),
  model: 'demo/model',
  sessions: SESSIONS,
  jsonPath: `/Users/demo/.dsh/meeting-memo/minutes/${DAY}.json`,
  mdPath: `/Users/demo/.dsh/meeting-memo/minutes/${DAY}.md`,
  markdown: '',
}

const OVERVIEW: MinutesOverview = {
  day: DAY,
  today: DAY,
  days: [DAY],
  root: '/Users/demo/.dsh/meeting-memo/minutes',
  minutes: MINUTES,
}

const RANGE: MinutesRangeDTO = {
  mode: 'week',
  today: DAY,
  days: ['2026-11-16', DAY],
  total: 3,
  groups: [
    { day: DAY, sessions: SESSIONS, mdPath: `/Users/demo/.dsh/meeting-memo/minutes/${DAY}.md` },
    {
      day: '2026-11-16',
      sessions: [{
        id: 'demo-3',
        start: 400,
        end: 430,
        topic: '客户对接：私有化部署排期',
        content: `> 💡 **本场背景与目标**

客户希望月底前完成私有化部署试点，本次对齐排期与前置条件。

### 核心结论

- 试点环境下周提供，部署包周三前交付。
- 客户侧需要开放两个出网白名单。

### TODO

- 交付部署包 — 林知远
- 提供白名单信息 — 客户 IT`,
        source: 'ai' as const,
        updatedAt: at(9, 10),
      }],
      mdPath: '/Users/demo/.dsh/meeting-memo/minutes/2026-11-16.md',
    },
  ],
}

const BACKGROUNDS: BackgroundsPayload = {
  items: [
    {
      id: 'bg-1',
      title: '产品线概览',
      tags: ['产品', '发布'],
      content: '云雀文档：在线协作编辑工具，桌面端 + 移动端。当前主版本 v2.x，双周一个迭代，灰度按端分别放量。',
      createdAt: at(9, 0),
      updatedAt: at(9, 0),
    },
    {
      id: 'bg-2',
      title: '术语表',
      tags: ['术语'],
      content: '灰度：只对一部分用户开放新版本。\n回滚：把已放量的版本退回旧版。\n埋点：记录用户行为的自定义事件。\nP99：99% 的请求快于该耗时。',
      createdAt: at(9, 0),
      updatedAt: at(9, 0),
    },
    {
      id: 'bg-3',
      title: 'v2.4 变更清单',
      tags: ['发布', '清单'],
      content: '新增：协同批注、模板市场。\n修复：iOS 15 编辑器闪烁、附件上传偶发失败。\n变更：快捷键默认值调整（需在公告中说明）。',
      createdAt: at(9, 0),
      updatedAt: at(9, 0),
    },
  ],
  selection: ['bg-1', 'bg-3'],
}

const JOBS: JobDTO[] = [
  {
    id: 'job-1',
    day: DAY,
    start: 545,
    end: 582,
    backgroundIds: ['bg-1', 'bg-3'],
    status: 'done',
    createdAt: at(9, 50),
    startedAt: at(9, 50),
    finishedAt: at(9, 52),
    elapsedMs: 118_000,
    added: 1,
    model: 'demo/model',
    topic: 'v2.4 发布评审',
  },
  {
    id: 'job-2',
    day: DAY,
    start: 600,
    end: 620,
    backgroundIds: [],
    status: 'running',
    createdAt: at(10, 30),
    startedAt: at(10, 30),
    topic: '周会：本周进度与风险',
  },
  {
    id: 'job-3',
    day: DAY,
    start: 480,
    end: 500,
    backgroundIds: [],
    status: 'failed',
    createdAt: at(8, 10),
    startedAt: at(8, 10),
    finishedAt: at(8, 11),
    elapsedMs: 42_000,
    error: '模型返回为空，稍后自动重试',
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
    path: '/Users/demo/.dsh/meeting-memo/models/SenseVoiceSmall_int8',
    kind: 'coreml-sensevoice',
    format: 'coreml',
    summary: '苹果系统默认',
    bytes: 227 * 1024 * 1024,
    appleCoreML: true,
  },
  rssBytes: 130 * 1024 * 1024,
  memory: MEMORY,
  logRoot: '/Users/demo/.dsh/meeting-memo/asr-log',
  helper: '/Users/demo/.dsh/meeting-memo/bin/asr-helper',
  mic: true,
  system: true,
  audio: { mic: 'ok', system: 'ok', silentMinutes: 0 },
  audioRestarts: 0,
  message: '正在录音并转写。',
  startedAt: at(9, 0),
  lastSnippetAt: at(10, 32),
  lastError: null,
  input: 'MacBook Pro麦克风',
  inputUID: '',
  inputs: [{ uid: 'builtin', name: 'MacBook Pro麦克风', default: true }],
} as unknown as AsrStatusDTO

const MODELS: AsrModelsPayload = {
  selectedId: 'sensevoice-coreml-int8',
  library: null,
  defaultRoot: '/Users/demo/.dsh/meeting-memo/models',
  bundledDir: '/Users/demo/.dsh/meeting-memo/models',
  models: [
    {
      id: 'sensevoice-coreml-int8',
      name: 'SenseVoiceSmall_int8 苹果 Core ML',
      path: '/Users/demo/.dsh/meeting-memo/models/SenseVoiceSmall_int8',
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
      path: '/Users/demo/.dsh/meeting-memo/models/sensevoice-small',
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
      { id: 'spk-1', day: DAY, start: 545, end: 572, label: '苏晴', note: '测试负责人', lines: [1, 2, 5, 10], createdAt: at(10, 5), samples: 4, audioCount: 4 },
      { id: 'spk-2', day: DAY, start: 553, end: 575, label: '陈默', note: '产品负责人', lines: [4, 8, 11], createdAt: at(10, 6), samples: 3, audioCount: 3 },
      { id: 'spk-3', day: DAY, start: 550, end: 582, label: '林知远', note: '后端研发', lines: [3, 6, 9, 12], createdAt: at(10, 7), samples: 4, audioCount: 4 },
    ],
  }],
} as unknown as SpeakerPayload

const ASSIGNMENTS = {
  day: DAY,
  map: Object.fromEntries(SEGMENTS.filter((segment) => 'speaker' in segment).map((segment) => [
    String(segment.line),
    {
      speaker: 'live',
      name: String((segment as { speaker?: string }).speaker),
      track: segment.track,
      score: (segment as { speakerScore?: number }).speakerScore ?? 0.8,
      source: 'live',
    },
  ])),
}

const SKILLS: { selectedId: string; skills: SkillDTO[] } = {
  selectedId: 'default',
  skills: [
    {
      id: 'default',
      name: '默认纪要',
      description: '背景、核心结论、TODO、相关链接四段。',
      prompt: '把转写整理成背景 / 核心结论 / TODO / 相关链接与资源。',
      builtin: true,
    } as unknown as SkillDTO,
    {
      id: 'release',
      name: '发布评审纪要',
      description: '面向发布：范围、风险、回滚、上线时间，TODO 必须带责任人。',
      prompt: '只保留与发布相关的内容：灰度范围、已知风险、回滚预案、上线时间；TODO 带责任人。',
    } as unknown as SkillDTO,
  ],
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
  'minutes.index': { text: `当前日志切片\n文件: ${DEMO_DATA.day.filePaths.snippets}\n要读的行: 1-14` },
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
