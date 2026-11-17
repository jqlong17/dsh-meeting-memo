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
type DemoLine = {
  /** 相对本场开始的秒数，用来推 s / e。 */
  at: number
  dur: number
  track: 'system' | 'mic'
  text: string
  who?: string
  score?: number
}

/** 四场会，覆盖上午到下午；中间留空档，时间轴才像真的一天。 */
const MEETINGS: Array<{ start: number; minutes: number; title: string; lines: DemoLine[] }> = [
  {
    start: 545, // 09:05 发布评审
    minutes: 37,
    title: 'v2.4 发布评审',
    lines: [
      { at: 0, dur: 5, track: 'system', text: '人都到齐了，今天过 v2.4 的发布评审，重点看灰度范围和回滚预案。', who: '苏晴', score: 0.91 },
      { at: 6, dur: 6, track: 'system', text: '先说结论：功能都验收完了，风险集中在移动端兼容。', who: '苏晴', score: 0.88 },
      { at: 14, dur: 7, track: 'mic', text: '移动端我先说一句，iOS 15 那个编辑器闪烁昨天修了，Android 还差一版。', who: '林知远', score: 0.84 },
      { at: 23, dur: 6, track: 'system', text: '那灰度能不能先只放桌面端？移动端我跟一版再放。', who: '陈默', score: 0.79 },
      { at: 31, dur: 6, track: 'system', text: '可以，灰度策略本来就是按端拆的，改一下配置就行。', who: '苏晴', score: 0.82 },
      { at: 39, dur: 7, track: 'mic', text: '回滚脚本我今天跑了一遍，从 50% 退回 0 大概两分半。', who: '林知远', score: 0.86 },
      { at: 48, dur: 8, track: 'system', text: '两分半能接受。埋点那边确认过了吗？新版本的分析要看得到转化。' },
      { at: 58, dur: 7, track: 'system', text: '埋点上周就上了，事件名我贴在变更清单里，别改。', who: '陈默', score: 0.78 },
      { at: 67, dur: 7, track: 'mic', text: '压测结果也出来了，峰值下 P99 是三百二十毫秒。', who: '林知远', score: 0.81 },
      { at: 76, dur: 7, track: 'system', text: '三百二在可接受范围，先上线观察，超过四百我们再动手。', who: '苏晴', score: 0.85 },
      { at: 85, dur: 6, track: 'system', text: '时间就定周四晚上八点，我先发公告，文案今天下午给。', who: '陈默', score: 0.8 },
      { at: 93, dur: 6, track: 'mic', text: '好，我周四下午提前把监控看板配好。', who: '林知远', score: 0.76 },
      { at: 101, dur: 4, track: 'system', text: '那就这么定，散会。' },
    ],
  },
  {
    start: 630, // 10:30 客户沟通
    minutes: 28,
    title: '客户沟通：私有化部署排期',
    lines: [
      { at: 0, dur: 6, track: 'system', text: '周老师您好，今天主要对一下私有化部署的排期和前置条件。', who: '陈默', score: 0.87 },
      { at: 8, dur: 7, track: 'system', text: '我们这边希望月底前跑起来，选一个部门先试。', who: '周叙', score: 0.72 },
      { at: 17, dur: 8, track: 'mic', text: '部署包我周三之前给到，包含离线和在线两套配置。', who: '林知远', score: 0.83 },
      { at: 27, dur: 7, track: 'system', text: '环境上有什么硬要求？我们现在是两台机器，内存各 64G。', who: '周叙', score: 0.75 },
      { at: 36, dur: 8, track: 'mic', text: '两台够用，单机至少 32G，磁盘最好留 500G 给索引。', who: '林知远', score: 0.8 },
      { at: 46, dur: 6, track: 'system', text: '好，那我这边先申请资源，白名单要开哪些？', who: '周叙', score: 0.7 },
      { at: 54, dur: 9, track: 'system', text: '两个出网地址，我把清单发您，邮件里附上部署手册。', who: '陈默', score: 0.86 },
      { at: 65, dur: 6, track: 'system', text: '收到，那我们下周一再对一次进度。', who: '周叙', score: 0.73 },
      { at: 73, dur: 5, track: 'mic', text: '好，我周一上午把环境先验一遍。', who: '林知远', score: 0.78 },
    ],
  },
  {
    start: 850, // 14:10 设计评审
    minutes: 26,
    title: '设计评审：模板市场交互',
    lines: [
      { at: 0, dur: 6, track: 'system', text: '下午这场过一下模板市场的交互稿，重点是空状态和权限提示。', who: '陈默', score: 0.88 },
      { at: 8, dur: 8, track: 'system', text: '空状态我改了一版，不再是一整块插画，改成一句说明加两个入口。', who: '陈默', score: 0.84 },
      { at: 18, dur: 7, track: 'mic', text: '两个入口会不会太重？我倾向只留「从模板创建」。', who: '苏晴', score: 0.79 },
      { at: 27, dur: 7, track: 'system', text: '那新建的时候就少了一条路，用户得先退出再进来。' },
      { at: 36, dur: 8, track: 'mic', text: '可以在新建弹窗里加一个「看看模板」，不用单独占位。', who: '苏晴', score: 0.82 },
      { at: 46, dur: 6, track: 'system', text: '这个我同意，成本也低。权限那块按原来的方案？', who: '陈默', score: 0.81 },
      { at: 54, dur: 7, track: 'mic', text: '对，只读用户看不到编辑入口，这点上周已经改过了。', who: '苏晴', score: 0.77 },
      { at: 63, dur: 6, track: 'system', text: '行，那我把稿子更新一下，明天同步给前端。', who: '陈默', score: 0.83 },
    ],
  },
  {
    start: 960, // 16:00 复盘
    minutes: 18,
    title: '发布复盘',
    lines: [
      { at: 0, dur: 6, track: 'system', text: '复盘一下这次灰度暴露的两个问题，一个是监控告警延迟。', who: '苏晴', score: 0.86 },
      { at: 8, dur: 8, track: 'system', text: '告警延迟是因为采样窗口设太长了，改成三十秒就够。', who: '林知远', score: 0.8 },
      { at: 18, dur: 7, track: 'mic', text: '第二个是回滚之后缓存没清干净，用户还看到新版界面。', who: '林知远', score: 0.84 },
      { at: 27, dur: 8, track: 'system', text: '这个得写进回滚清单，不能只靠人记。', who: '苏晴', score: 0.82 },
      { at: 37, dur: 6, track: 'system', text: '我来补清单，顺便加到发布检查项里。', who: '陈默', score: 0.79 },
      { at: 45, dur: 5, track: 'mic', text: '好，那这次就到这。', who: '苏晴', score: 0.75 },
    ],
  },
]

/** 把四场会摊平成片段：按场次时长均匀铺开，行号按顺序编。 */
const SEGMENTS = MEETINGS.flatMap((meeting) => {
  const spacing = (meeting.minutes * 60) / meeting.lines.length
  return meeting.lines.map((line, index) => {
    const s = meeting.start + (index * spacing) / 60
    // 真实会议里话是连着的，只留一点点停顿，语音分钟才和会议时长对得上
    const e = s + Math.min(52, spacing * 0.94) / 60
    return {
      s: Math.round(s * 100) / 100,
      e: Math.round(e * 100) / 100,
      track: line.track,
      text: line.text,
      ...(line.who ? { speaker: line.who, speakerScore: line.score } : {}),
    }
  })
}).map((segment, index) => ({ ...segment, line: index + 1 }))

/** 每场会覆盖到的分钟都给密度，场间留空档，时间轴才是「一天四场」的样子。 */
const BUCKETS = MEETINGS.flatMap((meeting) => Array.from(
  { length: meeting.minutes },
  (_, index) => {
    const minute = meeting.start + index
    const wave = Math.sin((minute - meeting.start) / 3.2) * 14 + 28
    return {
      m: minute,
      s: Math.max(6, Math.round(wave + (minute % 5) * 2)),
      c: 60 + (minute % 7) * 16,
      n: 1,
    }
  },
))

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
    // 采集 121 分钟、其中 96.5 分钟有人说话，比例接近真实会议
    speechMinutes: 96.5,
    captureMinutes: MEETINGS.reduce((sum, meeting) => sum + meeting.minutes, 0) + 12,
    firstMinute: MEETINGS[0].start,
    lastMinute: MEETINGS[MEETINGS.length - 1].start + MEETINGS[MEETINGS.length - 1].minutes,
    tracks: { mic: 5, system: 9 },
  },
  hourly: [
    { hour: 8, capturedMinutes: 0, speechMinutes: 0, chars: 0, segments: 0 },
    { hour: 9, capturedMinutes: 46, speechMinutes: 32.4, chars: 612, segments: 14 },
    { hour: 10, capturedMinutes: 20, speechMinutes: 14.2, chars: 288, segments: 7 },
  ],
  selection: { start: 545, end: 582 }, // 默认框住上午第一场，截图里能看到整段转写
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

客户希望月底前跑通私有化部署试点，本次对齐排期与前置条件。

### 核心结论

- 部署包周三前交付，含离线与在线两套配置。
- 环境要求：单机 32G 内存起，磁盘预留 500G。
- 客户侧需开放两个出网白名单。

### TODO

- 交付部署包与部署手册 — 林知远
- 发送白名单清单 — 陈默
- 下周一验收环境 — 林知远`

const SESSION_THREE = `> 💡 **本场背景与目标**

模板市场的交互稿评审，重点是空状态和权限提示。

### 核心结论

- 空状态改成一句说明加一个入口，不再放大插画。
- 「看看模板」放进新建弹窗，不单独占位。
- 只读用户的编辑入口保持隐藏。

### TODO

- 更新交互稿并同步前端 — 陈默`

const SESSION_FOUR = `> 💡 **本场背景与目标**

复盘本次灰度暴露的两个问题：告警延迟、回滚后缓存未清。

### 核心结论

- 告警采样窗口从 5 分钟改成 30 秒。
- 回滚清单增加「清缓存」步骤，写进发布检查项。

### TODO

- 补回滚清单并加入发布检查 — 陈默
- 调整告警采样窗口 — 林知远`

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
    start: 630,
    end: 658,
    topic: '客户沟通：私有化部署排期',
    content: SESSION_TWO,
    source: 'ai' as const,
    updatedAt: at(11, 2),
  },
  {
    id: 'demo-3',
    start: 850,
    end: 876,
    topic: '设计评审：模板市场交互',
    content: SESSION_THREE,
    source: 'ai' as const,
    updatedAt: at(14, 40),
  },
  {
    id: 'demo-4',
    start: 960,
    end: 978,
    topic: '发布复盘',
    content: SESSION_FOUR,
    source: 'ai' as const,
    updatedAt: at(16, 20),
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
  total: 5, // 今天 4 场 + 昨天 1 场
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
    createdAt: new Date(Date.now() - 42_000).toISOString(),
    // 从「刚刚开始」算起，截图里才不会出现「已 5810 秒」这种离谱数字
    startedAt: new Date(Date.now() - 42_000).toISOString(),
    topic: '发布复盘',
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
      // 行号对应当天 36 条转写，跨四场会都有样本
      { id: 'spk-1', day: DAY, start: 545, end: 968, label: '苏晴', note: '测试负责人', lines: [1, 2, 5, 10, 23, 25, 27, 31, 33], createdAt: at(16, 30), samples: 9, audioCount: 9 },
      { id: 'spk-2', day: DAY, start: 553, end: 972, label: '陈默', note: '产品负责人', lines: [4, 8, 11, 14, 17, 21, 24, 29, 34], createdAt: at(16, 31), samples: 9, audioCount: 9 },
      { id: 'spk-3', day: DAY, start: 550, end: 975, label: '林知远', note: '后端研发', lines: [3, 6, 9, 12, 16, 19, 22, 26, 28, 35], createdAt: at(16, 32), samples: 10, audioCount: 10 },
      { id: 'spk-4', day: DAY, start: 630, end: 658, label: '周叙', note: '客户技术负责人', lines: [15, 18, 20], createdAt: at(11, 5), samples: 3, audioCount: 3 },
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
