/**
 * dsh-meeting-minutes — Host half.
 *
 * Consumes notta-input's LifeLog day folders (VAD minute density + SenseVoice
 * transcripts) and exposes:
 * - the right-sidebar panel RPC (`/dsh-meeting-minutes/rpc`);
 * - Agent tools to read a day/range and to write timeline minutes locally.
 *
 * The plugin never writes into the notta log root. Minutes live under
 * `$DSH_HOME/meeting-minutes/minutes/<day>.{json,md}`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from './config.ts'
import { registerMeetingRoutes } from './rpc.ts'
import { MeetingError, MeetingService } from './service.ts'

export const name = 'dsh-meeting-minutes'
/** Weak dependencies: the Host must load even without a web UI or tools. */
export const inject: string[] = []

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function failure(error: unknown): Record<string, unknown> {
  if (error instanceof MeetingError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } }
  }
  return { ok: false, error: { code: 'ERROR', message: error instanceof Error ? error.message : String(error) } }
}

const SESSIONS_SCHEMA = {
  type: 'array' as const,
  description: '时间线段落数组，按时间线从早到晚。',
  items: {
    type: 'object' as const,
    additionalProperties: true,
    properties: {
      start: { type: 'string' as const, description: '开始时间，HH:mm（本地时间）。', required: true },
      end: { type: 'string' as const, description: '结束时间，HH:mm；省略时按 start+30 分钟。' },
      topic: { type: 'string' as const, description: '主题，一句话，例如「插件面板与时间轴」。', required: true },
      summary: { type: 'string' as const, description: '一到两句概述（可选）。' },
      points: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '内容要点，每条一句短语（可选）。',
      },
      todos: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '待办事项（可选）。',
      },
    },
  },
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  const service = new MeetingService(resolveConfig(rawConfig))

  ctx.inject(['llm'], (scope: Context) => {
    const llm = (scope as unknown as { llm?: Record<string, unknown> }).llm
    if (!llm) return
    const readSelection = (): unknown => {
      try {
        const owner = (scope as unknown as { get?: (name: string) => unknown }).get?.('agentDefaultModel')
        const selection = owner && typeof owner === 'object' ? (owner as { currentSelection?: () => unknown }).currentSelection : undefined
        return typeof selection === 'function' ? selection.call(owner) : null
      } catch {
        return null
      }
    }
    service.attachLlm({
      stream: (options) => (llm.stream as (options: Record<string, unknown>) => AsyncIterable<unknown>)(options),
      listProviders: () => (llm.listProviders as () => Array<{ id: string; name?: string }>)(),
      listModels: (provider) => (llm.listModels as (provider: string) => Promise<Array<{ id: string }>>)(provider),
      currentSelection: readSelection,
    })
  })

  ctx.inject(['connection', 'webServer'], (scope: Context) => {
    scope.effect(() => registerMeetingRoutes(scope, service), 'meeting-minutes: panel rpc')
  })

  ctx.inject(['tools'], (scope: Context) => {
    const tools = (scope as unknown as { tools?: { register?: (definition: unknown) => () => void } }).tools
    if (!tools?.register) return

    scope.effect(() => tools.register(defineTool({
      name: 'meeting_minutes_today',
      description: '查看本地「会议纪要」插件的当日情况：notta 生活日志的 VAD 分钟密度（每小时捕获分钟数、语音分钟数、字数）、当前选中的时间区间、可用日期，以及已保存纪要的路径。不返回逐句转写；要看转写用 meeting_minutes_transcript。',
      parameters: {
        day: { type: 'string', description: '日期 yyyy-MM-dd；不传取最近一天。' },
      },
      output,
      async execute(args: unknown) {
        try {
          return service.summary(asRecord(args).day as string | undefined)
        } catch (error) {
          return failure(error)
        }
      },
    })), 'meeting-minutes: today')

    scope.effect(() => tools.register(defineTool({
      name: 'meeting_minutes_transcript',
      description: '读取某个时段的 SenseVoice 转写（notta 生活日志 snippets）：按 [HH:mm:ss] 轨道：文本 逐行返回。区间默认 06:00–24:00；maxChars 控制返回长度，超出会标记 truncated。写纪要前先用它取原文。',
      parameters: {
        day: { type: 'string', description: '日期 yyyy-MM-dd；不传取最近一天。' },
        start: { type: 'string', description: '开始时间 HH:mm，默认 06:00。' },
        end: { type: 'string', description: '结束时间 HH:mm，默认 24:00。' },
        maxChars: { type: 'integer', description: '返回文本上限，默认 24000。' },
      },
      output,
      async execute(args: unknown) {
        const input = asRecord(args)
        try {
          return service.transcript(input.day as string | undefined, input.start, input.end, Number(input.maxChars) || 24_000)
        } catch (error) {
          return failure(error)
        }
      },
    })), 'meeting-minutes: transcript')

    scope.effect(() => tools.register(defineTool({
      name: 'meeting_minutes_generate',
      description: '用 Host 当前模型（可在插件配置指定 provider/model）把某区间的 SenseVoice 转写整理成会议纪要并写入本地。默认整段算一场会议，只产出一条；只有转写里出现明确换场标志时才拆成多条。会替换该区间内已有条目。',
      parameters: {
        day: { type: 'string', description: '日期 yyyy-MM-dd；不传取最近一天。' },
        start: { type: 'string', description: '开始时间 HH:mm；不传用插件里保存的选区起点。' },
        end: { type: 'string', description: '结束时间 HH:mm；不传用选区终点。' },
        backgroundIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：要用到的背景卡片 id（先用 meeting_minutes_today 查看 backgrounds.items）。',
        },
      },
      timeoutMs: 120_000,
      output,
      async execute(args: unknown) {
        const input = asRecord(args)
        try {
          return await service.generateMinutes(input.day as string | undefined, input.start, input.end, undefined, input.backgroundIds)
        } catch (error) {
          return failure(error)
        }
      },
    })), 'meeting-minutes: generate')

    scope.effect(() => tools.register(defineTool({
      name: 'meeting_minutes_save',
      description: '把整理好的会议纪要写成本地文件：每个时段含时间点、主题、内容要点、TODO。默认 merge：按时间区间替换同一时段的旧条目；mode=replace 覆盖当天全部。写完后返回 Markdown 路径，面板「纪要」标签会刷新显示。',
      parameters: {
        day: { type: 'string', description: '日期 yyyy-MM-dd；不传取最近一天。' },
        sessions: SESSIONS_SCHEMA,
        mode: { type: 'string', enum: ['merge', 'replace'], description: '默认 merge（按区间替换）；replace 覆盖当天。' },
        title: { type: 'string', description: '可选：当天纪要标题。' },
      },
      output,
      async execute(args: unknown) {
        const input = asRecord(args)
        try {
          return service.saveSessions(
            input.day as string | undefined,
            input.sessions,
            {
              mode: input.mode === 'replace' ? 'replace' : 'merge',
              title: typeof input.title === 'string' ? input.title : undefined,
              source: 'agent',
            },
          )
        } catch (error) {
          return failure(error)
        }
      },
    })), 'meeting-minutes: save')

    scope.effect(() => tools.register(defineTool({
      name: 'meeting_minutes_read',
      description: '读取某天已保存的会议纪要（JSON + Markdown 文本）。用于接着上次的内容继续补写，避免重复整理同一时段。',
      parameters: {
        day: { type: 'string', description: '日期 yyyy-MM-dd；不传取最近一天。' },
      },
      output,
      async execute(args: unknown) {
        try {
          return service.readMinutes(asRecord(args).day as string | undefined)
        } catch (error) {
          return failure(error)
        }
      },
    })), 'meeting-minutes: read')
  })
}
