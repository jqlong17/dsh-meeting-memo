/**
 * Same-origin RPC for the right-sidebar panel.
 *
 * POST /dsh-meeting-minutes/rpc  { op, payload }
 *   day            -> today's density buckets, segments, stats, selection
 *   selection      -> persist the user's chosen clock range
 *   minutes.list   -> one day's minutes document (JSON + Markdown)
 *   minutes.generate -> ask the Host model for meeting minutes from the range
 *   minutes.upsert -> create/update one session from the panel editor
 *   minutes.delete -> remove one session
 *   minutes.clear  -> remove the whole day's minutes file
 *   backgrounds.*  -> list/upsert/delete background cards and their selection
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { AsrModelRegistry } from './asr-models.ts'
import { ModelDownloads } from './model-download.ts'
import { MODEL_OFFERS, defaultDownloadRoot, offerMatches } from './model-catalog.ts'
import type { AsrRuntime } from './asr-service.ts'
import type { MinutesJobStore } from './jobs.ts'
import { deleteSkill, readSkills, saveSkill, selectSkill } from './skills.ts'
import { MeetingError } from './service.ts'
import type { MeetingService } from './service.ts'

export const ROUTE_PREFIX = '/dsh-mm'
const RPC_PATH = `${ROUTE_PREFIX}/rpc`
const MAX_BODY_BYTES = 512 * 1024

interface RpcSuccess {
  ok: true
  value: unknown
}

interface RpcFailure {
  ok: false
  error: { code: string; message: string; hint?: string }
}

function sendJson(res: ServerResponse, status: number, value: RpcSuccess | RpcFailure): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new MeetingError('PAYLOAD_TOO_LARGE', '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dispatch(
  service: MeetingService,
  jobs: MinutesJobStore | undefined,
  asr: { models: AsrModelRegistry; runtime: AsrRuntime; downloads?: ModelDownloads } | undefined,
  op: string,
  payload: Record<string, unknown>,
): unknown {
  switch (op) {
    case 'day':
      return service.dayPayload(typeof payload.day === 'string' ? payload.day : undefined)
    case 'status':
      return service.status()
    case 'selection':
      return service.saveSelection(String(payload.day || ''), Number(payload.start), Number(payload.end))
    case 'minutes.list':
      return service.minutes(typeof payload.day === 'string' ? payload.day : undefined)
    case 'minutes.generate':
    case 'minutes.draft': {
      const day = typeof payload.day === 'string' ? payload.day : undefined
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      return service.generateMinutes(day, payload.start, payload.end, sessionId, payload.backgroundIds)
    }
    case 'minutes.upsert': {
      const day = String(payload.day || '')
      return service.upsertSession(day, asRecord(payload.session))
    }
    case 'minutes.delete':
      return service.deleteSession(String(payload.day || ''), String(payload.id || ''))
    case 'minutes.clear':
      if (payload.confirm !== true) throw new MeetingError('CONFIRM_REQUIRED', '清空纪要需要 confirm=true')
      return service.clearDay(String(payload.day || ''))
    case 'backgrounds.list':
      return service.backgrounds()
    case 'backgrounds.upsert':
      return service.saveBackground(payload.item)
    case 'backgrounds.delete':
      return service.deleteBackground(String(payload.id || ''))
    case 'backgrounds.select':
      return service.selectBackgrounds(payload.ids)
    case 'jobs.list':
      return { jobs: requireJobs(jobs).list() }
    case 'jobs.start': {
      const day = String(payload.day || '')
      const start = Number(payload.start)
      const end = Number(payload.end)
      if (!day || !Number.isFinite(start) || !Number.isFinite(end)) {
        throw new MeetingError('BAD_JOB', '缺少日期或时间区间')
      }
      const backgroundIds = Array.isArray(payload.backgroundIds) ? payload.backgroundIds.map((id) => String(id)) : []
      const skillId = typeof payload.skillId === 'string' ? payload.skillId : undefined
      const supplements = typeof payload.supplements === 'string' ? payload.supplements : undefined
      return { job: requireJobs(jobs).start({ day, start, end, backgroundIds, ...(skillId ? { skillId } : {}), ...(supplements ? { supplements } : {}) }) }
    }
    case 'system.reveal':
      return service.revealPath(payload.path)
    case 'skills.list':
      return readSkills(service.config.home)
    case 'skills.save':
      return saveSkill(service.config.home, {
        id: typeof payload.id === 'string' ? payload.id : undefined,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        description: typeof payload.description === 'string' ? payload.description : undefined,
        prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
        select: payload.select === true,
      })
    case 'skills.delete':
      return deleteSkill(service.config.home, String(payload.id || ''))
    case 'skills.select':
      return selectSkill(service.config.home, String(payload.id || ''))
    case 'jobs.cancel':
      return { job: requireJobs(jobs).cancel(String(payload.id || '')) }
    case 'jobs.clear':
      return { jobs: requireJobs(jobs).clearFinished() }
    case 'sources.list':
      return service.sources()
    case 'models.list':
      return modelPayload(requireAsr(asr))
    case 'models.download':
      return { job: requireAsr(asr).downloads?.start(String(payload.id || '')) ?? null, ...modelPayload(requireAsr(asr)) }
    case 'models.setRoot': {
      const root = requireAsr(asr).models.setLibrary(String(payload.path || ''))
      return { root, ...modelPayload(requireAsr(asr)) }
    }
    case 'models.add': {
      const added = requireAsr(asr).models.add(String(payload.path || ''), typeof payload.name === 'string' ? payload.name : undefined)
      if (requireAsr(asr).runtime.status().enabled) void requireAsr(asr).runtime.start()
      return { model: added, ...requireAsr(asr).models.list() }
    }
    case 'models.remove':
      requireAsr(asr).models.remove(String(payload.id || ''))
      return requireAsr(asr).models.list()
    case 'models.select':
      requireAsr(asr).models.select(String(payload.id || ''))
      if (requireAsr(asr).runtime.status().enabled) void requireAsr(asr).runtime.start()
      return requireAsr(asr).models.list()
    case 'asr.status':
      return requireAsr(asr).runtime.status()
    case 'asr.set': {
      const runtime = requireAsr(asr).runtime
      if (payload.mode === 'raw' || payload.mode === 'tracks' || payload.mode === 'merged') {
        return runtime.setMode(payload.mode)
      }
      if (payload.language === 'zhen' || payload.language === 'zh' || payload.language === 'en' || payload.language === 'auto') {
        return runtime.setLanguage(payload.language)
      }
      if (typeof payload.enabled === 'boolean') return runtime.setEnabled(payload.enabled)
      throw new MeetingError('BAD_ASR', '缺少 enabled 或 mode')
    }
    default:
      throw new MeetingError('UNKNOWN_OP', `未知操作：${op || '(空)'}`)
  }
}

function modelPayload(asr: { models: AsrModelRegistry; downloads?: ModelDownloads }): Record<string, unknown> {
  const listed = asr.models.list()
  return {
    ...listed,
    defaultRoot: defaultDownloadRoot(),
    downloads: asr.downloads?.list() ?? [],
    offers: MODEL_OFFERS.map((offer) => ({
      ...offer,
      present: listed.models.some((model) => offerMatches(offer, model.path)),
    })),
  }
}

function requireAsr(asr: { models: AsrModelRegistry; runtime: AsrRuntime; downloads?: ModelDownloads } | undefined): { models: AsrModelRegistry; runtime: AsrRuntime; downloads?: ModelDownloads } {
  if (!asr) throw new MeetingError('NO_ASR', 'ASR 服务还没就绪', '重启一次 DSH 后再试。')
  return asr
}

function requireJobs(jobs: MinutesJobStore | undefined): MinutesJobStore {
  if (!jobs) throw new MeetingError('NO_JOBS', '生成任务还没就绪', '重启一次 DSH 后再试。')
  return jobs
}

interface RouteBridge {
  handle?: (op: string, payload: Record<string, unknown>) => unknown
  owner?: symbol
  registered?: boolean
}

const BRIDGE_KEY = Symbol.for('dsh-meeting-minutes.rpc.bridge')

function routeBridge(): RouteBridge {
  const holder = globalThis as unknown as Record<symbol, RouteBridge | undefined>
  if (!holder[BRIDGE_KEY]) holder[BRIDGE_KEY] = {}
  return holder[BRIDGE_KEY] as RouteBridge
}

export function registerMeetingRoutes(
  ctx: Context,
  service: MeetingService,
  jobs?: MinutesJobStore,
  asr?: { models: AsrModelRegistry; runtime: AsrRuntime; downloads?: ModelDownloads },
): () => void {
  const bridge = routeBridge()
  const owner = Symbol('meeting-minutes-route')
  bridge.handle = (op, payload) => dispatch(service, jobs, asr, op, payload)
  bridge.owner = owner

  if (bridge.registered) {
    return () => {
      if (bridge.owner !== owner) return
      bridge.handle = undefined
      bridge.owner = undefined
    }
  }

  bridge.registered = true
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname !== RPC_PATH) {
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '接口不存在' } })
        return
      }
      try {
        const body = await readJsonBody(req)
        const input = asRecord(body)
        const handle = routeBridge().handle
        if (!handle) {
          sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '会议纪要插件未启用' } })
          return
        }
        const value = await handle(String(input.op || ''), asRecord(input.payload))
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const failure: RpcFailure = error instanceof MeetingError
          ? { ok: false, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } }
          : { ok: false, error: { code: 'meeting-minutes/failed', message: error instanceof Error ? error.message : String(error) } }
        sendJson(res, 200, failure)
      }
    },
  }) as () => void

  return () => {
    if (bridge.owner !== owner) return
    bridge.handle = undefined
    bridge.owner = undefined
    if (bridge.registered) {
      bridge.registered = false
      disposeRoute()
    }
  }
}
