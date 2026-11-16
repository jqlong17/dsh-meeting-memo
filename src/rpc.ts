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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { AsrModelRegistry } from './asr-models.ts'
import { ModelDownloads } from './model-download.ts'
import { defaultDownloadRoot, offerMatches, offersForPlatform } from './model-catalog.ts'
import type { AsrRuntime } from './asr-service.ts'
import type { MinutesJobStore } from './jobs.ts'
import { addLabel, deleteLabel, groupByDay, readLabels } from './speaker-labels.ts'
import { audioPieces, diarizeTrack, nameSpeakers } from './speaker-diarize.ts'
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

async function dispatch(
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
      if (typeof payload.input === 'string') return runtime.setInput(payload.input)
      throw new MeetingError('BAD_ASR', '缺少 enabled 或 mode')
    }
    case 'speaker.assignments': {
      const days = readAssignments(service.config.home)
      const wanted = typeof payload.day === 'string' && payload.day ? payload.day : undefined
      return wanted ? { day: wanted, map: days[wanted] ?? {} } : { days }
    }
    case 'speaker.analyze': {
      const payloadDay = typeof payload.day === 'string' && payload.day ? payload.day : undefined
      const day = service.dayPayload(payloadDay)
      const labels = readLabels(service.config.home).filter((item) => item.day === day.day)
      const models = speakerModelsDir()
      const workDir = path.join(service.config.home, '.speaker-work')
      const results = []
      for (const track of ['mic', 'system']) {
        const pieces = audioPieces(day.segments, track)
        if (!pieces.length) continue
        const result = await diarizeTrack({
          runtimeHome: service.config.home,
          modelsDir: models,
          track,
          pieces,
          workDir,
          threshold: typeof payload.threshold === 'number' ? payload.threshold : 0.75,

          timeZone: service.config.timeZone,
        })
        if (result) results.push(result)
      }
      if (!results.length) {
        throw new MeetingError('NO_AUDIO', '没有可用的音频，或分离模型缺失', '确认保存内容为「双轨原音 + 文本」，并检查声纹模型是否存在。')
      }
      const named = nameSpeakers(results, labels)
      const map: Record<string, { speaker: string; name?: string; track: string }> = {}
      for (const result of results) {
        for (const [line, speaker] of result.byLine) {
          const name = named.get(`${result.track}:${speaker}`)
          map[String(line)] = { speaker, track: result.track, ...(name ? { name } : {}) }
        }
      }
      const days = readAssignments(service.config.home)
      days[day.day] = map
      writeAssignments(service.config.home, days)
      const speakers = [...new Set(results.flatMap((result) => result.speakers))]
      return {
        day: day.day,
        lines: Object.keys(map).length,
        speakers: speakers.length,
        named: new Set([...named.values()]).size,
        names: [...new Set([...named.values()])],
      }
    }
    case 'speaker.list': {
      const items = readLabels(service.config.home)
      let root = ''
      try {
        root = service.dayPayload(undefined).root
      } catch {
        root = ''
      }
      const groups = groupByDay(items).map((group) => ({
        day: group.day,
        items: group.items.map((item) => {
          let audioCount = root ? countAudio(root, item.day, item.start, item.end, service.config.timeZone) : 0
          if (root && item.lines?.length) {
            const wanted = new Set(item.lines)
            const day = (() => {
              try {
                return service.dayPayload(item.day)
              } catch {
                return null
              }
            })()
            if (day) {
              const exact = day.segments.filter((segment) => (
                (segment.lines ?? (segment.line ? [segment.line] : [])).some((line) => wanted.has(line))
              )).filter((segment) => Boolean(segment.audio)).length
              audioCount = exact
            }
          }
          return { ...item, audioCount }
        }),
      }))
      return { groups, total: items.length, audioOn: Boolean(asr?.runtime.status().mode === 'raw') }
    }
    case 'speaker.add': {
      const result = addLabel(service.config.home, payload.item)
      return { item: result.item, total: result.items.length }
    }
    case 'speaker.delete':
      return { total: deleteLabel(service.config.home, String(payload.id || '')).length }
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
    offers: offersForPlatform().map((offer) => ({
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


/** 数某天某段区间落了多少个 wav（文件名就是毫秒时间戳）。 */
function countAudio(root: string, day: string, start: number, end: number, timeZone: string): number {
  const base = Date.parse(`${day}T00:00:00`)
  if (!Number.isFinite(base)) return 0
  // 用当地零点拼出毫秒区间；日期字符串按本地解释，和日志口径一致。
  const from = base + start * 60_000
  const to = base + end * 60_000
  let total = 0
  for (const track of ['mic', 'system']) {
    const dir = path.join(root, day, 'audio', track)
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.wav')) continue
      const ms = Number(name.slice(0, -4))
      if (Number.isFinite(ms) && ms >= from && ms <= to) total += 1
    }
  }
  void timeZone
  return total
}


const ASSIGN_FILE = 'speaker-assignments.json'

type Assignments = Record<string, Record<string, { speaker: string; name?: string; track: string }>>

function readAssignments(home: string): Assignments {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, ASSIGN_FILE), 'utf8')) as { days?: Assignments }
    return parsed.days ?? {}
  } catch {
    return {}
  }
}

function writeAssignments(home: string, days: Assignments): void {
  writeFileSync(path.join(home, ASSIGN_FILE), `${JSON.stringify({ version: 1, days }, null, 2)}\n`, 'utf8')
}

/** 分离模型默认借 voice-split 那份（已经下载过），可用 SPEAKER_MODELS 覆盖。 */
function speakerModelsDir(): string {
  const fromEnv = (process.env.SPEAKER_MODELS || '').trim()
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), '.dsh', 'voice-split', 'models')
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
