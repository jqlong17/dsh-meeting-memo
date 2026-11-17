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
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { readDayMap, listDays, writeDay } from './speaker-assignments.ts'
import { readEmbMap } from './emb-store.ts'
import { backfillLabel } from './speaker-backfill.ts'
import { buildCentroids, decodeEmbedding } from './speaker-live.ts'
import { centroidKey, neededScopes, parseRows, rebuildAssignments } from './speaker-rebuild.ts'
import { applyUpdate, checkUpdate, readUpdateState } from './update.ts'
import { PACKAGE_NAME } from './about.ts'
import { PLUGIN_VERSION } from './version.ts'
import { audioPieces, diarizeTrack, nameSpeakers } from './speaker-diarize.ts'
import { dayKey } from './asr-log.ts'
import { listMinutesDays } from './minutes.ts'
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
    case 'minutes.range': {
      const mode = payload.mode === 'all' ? 'all' : payload.mode === 'day' ? 'day' : 'week'
      const today = dayKey(service.config.timeZone)
      const all = listMinutesDays(service.config.home)
      let selected: string[] = []
      if (mode === 'all') {
        selected = all
      } else if (mode === 'day') {
        const wanted = typeof payload.day === 'string' && payload.day ? payload.day : all.at(-1) ?? today
        selected = [wanted]
      } else {
        const days: string[] = []
        for (let offset = 6; offset >= 0; offset -= 1) {
          const date = new Date(`${today}T00:00:00`)
          date.setDate(date.getDate() - offset)
          days.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
        }
        selected = all.filter((day) => days.includes(day))
      }
      // 日期从新到旧、同一天内按时间从晚到早：面板「纪要」就是倒序时间线
      const groups = selected
        .slice()
        .sort((a, b) => b.localeCompare(a))
        .map((day) => {
          const doc = service.minutesForDay(day)
          return {
            day,
            sessions: [...doc.sessions].sort((a, b) => b.start - a.start || b.end - a.end),
            mdPath: doc.mdPath,
          }
        })
        .filter((group) => group.sessions.length > 0)
      return { mode, today, days: all, groups, total: groups.reduce((sum, group) => sum + group.sessions.length, 0) }
    }
    case 'update.check': {
      const status = await checkUpdate({
        name: PACKAGE_NAME,
        current: PLUGIN_VERSION,
        profileDir: process.env.DSH_PROFILE_DIR,
        profile: process.env.DSH_PROFILE,
        force: payload.force === true,
      })
      const state = readUpdateState(service.config.home)
      return {
        ...status,
        checkedAt: state.checkedAt ?? status.checkedAt,
        ...(state.appliedVersion ? { appliedVersion: state.appliedVersion } : {}),
        ...(state.appliedAt ? { appliedAt: state.appliedAt } : {}),
        autoUpdate: service.config.autoUpdate,
      }
    }
    case 'update.apply': {
      const result = await applyUpdate({
        name: PACKAGE_NAME,
        profile: process.env.DSH_PROFILE,
        cwd: process.env.DSH_PROFILE_DIR,
      })
      return result
    }
    case 'minutes.index':
      return service.indexFor(
        typeof payload.day === 'string' && payload.day ? payload.day : undefined,
        payload.start,
        payload.end,
      )
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
    case 'asr.restart': {
      const runtime = requireAsr(asr).runtime
      await runtime.start()
      return runtime.status()
    }
    case 'asr.heartbeat': {
      // 链路心跳的全天检测：每分钟一条状态（有语音 / 只采集 / 断）
      const day = typeof payload.day === 'string' && payload.day
        ? payload.day
        : dayKey(service.config.timeZone)
      const range = payload.range === 'minute' ? 'minute' : payload.range === 'hour' ? 'hour' : 'day'
      const span = range === 'minute' ? 5 : range === 'hour' ? 60 : 1440
      const root = path.join(service.config.home, 'asr-log', day)
      const minutes = new Map<number, { speech: number; snippets: number }>()
      try {
        for (const line of readFileSync(path.join(root, 'activity.jsonl'), 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line) as { startAt?: string; micSpeechSeconds?: number; systemSpeechSeconds?: number; snippetCount?: number }
            if (!row.startAt) continue
            const at = new Date(row.startAt)
            const minute = at.getHours() * 60 + at.getMinutes()
            const prev = minutes.get(minute) ?? { speech: 0, snippets: 0 }
            minutes.set(minute, {
              speech: prev.speech + (Number(row.micSpeechSeconds) || 0) + (Number(row.systemSpeechSeconds) || 0),
              snippets: prev.snippets + (Number(row.snippetCount) || 0),
            })
          } catch {
            // 坏行跳过
          }
        }
      } catch {
        // 没有日志就是全空
      }
      const now = new Date()
      const nowMinute = now.getHours() * 60 + now.getMinutes()
      const start = range === 'day' ? 0 : Math.max(0, nowMinute - span)
      const end = range === 'day' ? 1440 : Math.max(span, nowMinute)
      const step = range === 'day' ? 5 : 1
      const points: Array<{ minute: number; state: 'ok' | 'idle' | 'gap'; speech: number; snippets: number }> = []
      let ok = 0
      let idle = 0
      let gap = 0
      for (let minute = Math.floor(start); minute < Math.ceil(end); minute += step) {
        let speech = 0
        let snippets = 0
        let seen = false
        for (let offset = 0; offset < step; offset += 1) {
          const hit = minutes.get(minute + offset)
          if (!hit) continue
          seen = true
          speech += hit.speech
          snippets += hit.snippets
        }
        const state = !seen ? 'gap' : speech > 0.5 ? 'ok' : 'idle'
        if (state === 'ok') ok += 1
        else if (state === 'idle') idle += 1
        else gap += 1
        points.push({ minute, state, speech, snippets })
      }
      return { day, range, start, end, points, summary: { total: points.length, ok, idle, gap } }
    }
    case 'asr.storage': {
      // 原音与备份的占用情况：面板「保存内容」那里显示，并提供清理入口
      const logRoot = path.join(service.config.home, 'asr-log')
      const days: Array<{ day: string; files: number; bytes: number }> = []
      let backupBytes = 0
      let backupFiles = 0
      try {
        for (const name of readdirSync(logRoot)) {
          const dir = path.join(logRoot, name)
          if (!statSync(dir).isDirectory()) continue
          const audioDir = path.join(dir, 'audio')
          let files = 0
          let bytes = 0
          const walk = (target: string): void => {
            let entries: string[] = []
            try {
              entries = readdirSync(target)
            } catch {
              return
            }
            for (const entry of entries) {
              const full = path.join(target, entry)
              try {
                const stat = statSync(full)
                if (stat.isDirectory()) walk(full)
                else if (entry.endsWith('.wav')) {
                  files += 1
                  bytes += stat.size
                }
              } catch {
                // 读不到就跳过
              }
            }
          }
          walk(audioDir)
          if (files) days.push({ day: name, files, bytes })
          // 迁移留的 .premigrate 备份也算进来，别让用户不知道占了多少
          try {
            for (const entry of readdirSync(dir)) {
              if (!entry.endsWith('.premigrate')) continue
              backupFiles += 1
              backupBytes += statSync(path.join(dir, entry)).size
            }
          } catch {
            // 忽略
          }
        }
      } catch {
        // 没有日志目录
      }
      days.sort((a, b) => a.day.localeCompare(b.day))
      const audioBytes = days.reduce((sum, item) => sum + item.bytes, 0)
      const audioFiles = days.reduce((sum, item) => sum + item.files, 0)
      const home = service.config.home
      try {
        for (const entry of readdirSync(home)) {
          if (!entry.endsWith('.premigrate')) continue
          backupFiles += 1
          backupBytes += statSync(path.join(home, entry)).size
        }
      } catch {
        // 忽略
      }
      return {
        audio: { files: audioFiles, bytes: audioBytes, days },
        backups: { files: backupFiles, bytes: backupBytes },
        retentionDays: 7,
      }
    }
    case 'asr.cleanup': {
      // 清理原音：olderThanDays=0 表示全部清掉；不传默认 7 天
      const raw = Number(payload.olderThanDays)
      const days = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 7
      const today = dayKey(service.config.timeZone)
      const cutoff = days === 0 ? '9999-99-99' : dayKey(service.config.timeZone, new Date(Date.now() - days * 86_400_000))
      const targets: string[] = []
      const logRoot = path.join(service.config.home, 'asr-log')
      try {
        for (const name of readdirSync(logRoot)) {
          if (name >= today) continue
          if (days !== 0 && name >= cutoff) continue
          const walk = (target: string): void => {
            let entries: string[] = []
            try {
              entries = readdirSync(target)
            } catch {
              return
            }
            for (const entry of entries) {
              const full = path.join(target, entry)
              const stat = statSync(full)
              if (stat.isDirectory()) walk(full)
              else if (entry.endsWith('.wav')) targets.push(full)
            }
          }
          walk(path.join(logRoot, name, 'audio'))
        }
      } catch {
        // 没有目录就没什么可清
      }
      let removed = 0
      let freed = 0
      for (const file of targets) {
        try {
          const size = statSync(file).size
          unlinkSync(file)
          removed += 1
          freed += size
        } catch {
          // 删不掉就算了，不阻断
        }
      }
      return { removed, freed, olderThanDays: days }
    }
    case 'asr.memory': {
      // 当天 00:00–24:00 的内存曲线；按 5 分钟均值降采样，最多 288 个点
      const day = typeof payload.day === 'string' && payload.day
        ? payload.day
        : dayKey(service.config.timeZone)
      const file = path.join(service.config.home, 'memory.jsonl')
      let rows: Array<{ at: string; occupied: number; heap: number; audio: number; fixed: number; mapped: number }> = []
      try {
        rows = readFileSync(file, 'utf8').trim().split('\n').flatMap((line) => {
          if (!line.trim()) return []
          try {
            const row = JSON.parse(line) as { at?: string }
            if (!row.at || !row.at.startsWith(day)) return []
            return [row as { at: string; occupied: number; heap: number; audio: number; fixed: number; mapped: number }]
          } catch {
            return []
          }
        })
      } catch {
        rows = []
      }
      // 最近 5 分钟用 30 秒粒度（10 点）；最近 1 小时用 1 分钟（60 点）；全天 5 分钟（288 点）
      const range = payload.range === 'minute' ? 'minute' : payload.range === 'hour' ? 'hour' : 'day'
      const bucketMinutes = range === 'minute' ? 0.5 : range === 'hour' ? 1 : 5
      const spanMinutes = range === 'minute' ? 5 : range === 'hour' ? 60 : 1440
      const nowMinute = (() => {
        const now = new Date()
        return now.getHours() * 60 + now.getMinutes()
      })()
      const buckets = new Map<number, { sum: number; count: number; heap: number; audio: number; fixed: number; mapped: number }>()
      for (const row of rows) {
        const at = new Date(row.at)
        const minute = at.getHours() * 60 + at.getMinutes()
        if (range !== 'day' && minute < nowMinute - spanMinutes) continue
        const slot = Math.round(Math.floor(minute / bucketMinutes) * bucketMinutes * 100) / 100
        const bucket = buckets.get(slot) ?? { sum: 0, count: 0, heap: 0, audio: 0, fixed: 0, mapped: 0 }
        bucket.sum += row.occupied || 0
        bucket.count += 1
        bucket.heap += row.heap || 0
        bucket.audio += row.audio || 0
        bucket.fixed += row.fixed || 0
        bucket.mapped += row.mapped || 0
        buckets.set(slot, bucket)
      }
      const samples = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([minute, bucket]) => ({
        minute,
        at: `${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`,
        occupied: Math.round(bucket.sum / bucket.count),
        heap: Math.round(bucket.heap / bucket.count),
        audio: Math.round(bucket.audio / bucket.count),
        fixed: Math.round(bucket.fixed / bucket.count),
        mapped: Math.round(bucket.mapped / bucket.count),
      }))
      return { day, range, samples }
    }
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
      const wanted = typeof payload.day === 'string' && payload.day ? payload.day : undefined
      if (wanted) return { day: wanted, map: readDayMap(service.config.home, wanted) }
      const days = Object.fromEntries(listDays(service.config.home).map((day) => [day, readDayMap(service.config.home, day)]))
      return { days }
    }
    case 'speaker.rebuild': {
      const day = service.dayPayload(typeof payload.day === 'string' && payload.day ? payload.day : undefined).day
      const file = path.join(service.config.home, 'asr-log', day, 'snippets.jsonl')
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        throw new MeetingError('NO_LOG', '当天还没有转写')
      }
      const rows = parseRows(text)
      // 声纹存在 emb.jsonl，按行号合回来（老文件里仍可能是内联的）
      const embMap = readEmbMap(path.join(service.config.home, 'asr-log', day))
      for (const row of rows) {
        if (!row.emb) {
          const stored = embMap.get(row.line)
          if (stored) row.emb = stored
        }
      }
      const labels = readLabels(service.config.home)
      if (!labels.length) {
        throw new MeetingError('NO_LABELS', '还没有登记任何说话人', '先去「说话人识别 → 打标」登记几句，再回来重算')
      }
      // 每种「轨道|设备」各建一套质心；麦克风跨设备声纹会掉分，不能混
      const sets = new Map<string, CentroidSet>()
      for (const scope of neededScopes(rows)) {
        const built = buildCentroids(
          path.join(service.config.home, 'asr-log'),
          labels,
          service.config.home,
          scope.track === 'mic' ? scope.device : undefined,
          scope.track,
        )
        sets.set(centroidKey(scope.track, scope.device), built)
      }
      const result = rebuildAssignments({
        rows,
        centroidSets: sets,
        decode: decodeEmbedding,
      })
      // 旧归属整体替换：没声纹的行保留原值，其余以本次判定为准
      const previous = readDayMap(service.config.home, day)
      const next: typeof previous = {}
      const evaluated = new Set(rows.filter((row) => row.emb).map((row) => String(row.line)))
      for (const [line, entry] of Object.entries(previous)) {
        if (!evaluated.has(line)) next[line] = entry
      }
      for (const [line, entry] of Object.entries(result.map)) next[line] = entry
      writeDay(service.config.home, day, next)
      service.invalidateSpeakerCache()
      return {
        day,
        rows: rows.length,
        withEmbedding: result.total,
        matched: result.matched,
        names: result.names,
        enrolled: new Set(labels.map((label) => label.label)).size,
      }
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
          map[String(line)] = { speaker, track: result.track, source: 'batch', ...(name ? { name } : {}) }
        }
      }
      writeDay(service.config.home, day.day, map)
      service.invalidateSpeakerCache()
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
          let samples = 0
          if (item.lines?.length) {
            // 声纹才是匹配要用的东西：按行数有 emb 的条数，别再让人误以为「0 音频 = 没数据」
            const flags = snippetFlags(service.config.home, item.day)
            const picked = item.lines
            samples = picked.filter((line) => flags.get(line)?.emb).length
            const withAudio = picked.filter((line) => flags.get(line)?.audio).length
            if (withAudio) audioCount = withAudio
          }
          return { ...item, audioCount, samples }
        }),
      }))
      return { groups, total: items.length, audioOn: Boolean(asr?.runtime.status().mode === 'raw') }
    }
    case 'speaker.enrollRecent': {
      const name = String(payload.label || '').trim()
      if (!name) throw new MeetingError('BAD_LABEL', '需要一个说话人名字')
      const count = Math.min(20, Math.max(1, Number(payload.count) || 3))
      const day = service.dayPayload(typeof payload.day === 'string' && payload.day ? payload.day : undefined).day
      const file = path.join(service.config.home, 'asr-log', day, 'snippets.jsonl')
      let raw = ''
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        throw new MeetingError('NO_LOG', '当天还没有转写')
      }
      const rows: Array<{ line: number; startAt: string; endAt: string; track: string; text: string; emb?: string }> = []
      const embMap = readEmbMap(path.join(service.config.home, 'asr-log', day))
      let index = 0
      for (const text of raw.split('\n')) {
        if (!text.trim()) continue
        index += 1
        try {
          const row = JSON.parse(text) as Record<string, unknown>
          if (typeof row.emb !== 'string' || !row.emb) {
            const stored = embMap.get(index)
            if (stored) row.emb = stored
            else continue
          }
          // 只挑麦克风轨：system 轨是别人在说话，混进来会把质心带偏
          if (typeof row.input !== 'string' || !row.input) continue
          const body = String(row.text ?? '').trim()
          if (body.length < 4) continue
          rows.push({
            line: index,
            startAt: String(row.startAt ?? ''),
            endAt: String(row.endAt ?? row.startAt ?? ''),
            track: String(row.track ?? ''),
            text: body,
            emb: row.emb,
          })
        } catch {
          // 坏行跳过
        }
      }
      // 优先同一设备：登记时用哪支麦克风，之后就用哪支认人
      const deviceRow = [...rows].reverse().find((row) => row.emb)
      const recent = rows.slice(-count)
      if (!recent.length) throw new MeetingError('NO_SAMPLES', '最近没有可用的声纹样本')
      const toMinute = (iso: string): number => {
        const date = new Date(iso)
        return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
      }
      const start = Math.min(...recent.map((row) => toMinute(row.startAt)))
      const end = Math.max(...recent.map((row) => toMinute(row.endAt)))
      const { item } = addLabel(service.config.home, {
        day,
        start,
        end,
        label: name,
        lines: recent.map((row) => row.line),
        note: '快速登记',
      })
      const applied = backfillLabel(service.config.home, service.config.timeZone, item)
      void deviceRow
      return { item, samples: recent.length, day, applied }
    }
    case 'speaker.add': {
      const result = addLabel(service.config.home, payload.item)
      // 用户亲手打标的行立刻生效，不等下一次识别
      const applied = backfillLabel(service.config.home, service.config.timeZone, result.item)
      return { item: result.item, total: result.items.length, applied }
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



/** 当天的每一行有没有声纹、有没有 wav；标签列表据此显示「可用样本」。 */
function snippetFlags(home: string, day: string): Map<number, { emb: boolean; audio: boolean }> {
  const flags = new Map<number, { emb: boolean; audio: boolean }>()
  // 老片段没有 emb 字段，但可能已经从 wav 补算进缓存，同样算可用样本
  let cache: Record<string, string> = {}
  try {
    cache = JSON.parse(readFileSync(path.join(home, 'emb-cache.json'), 'utf8')) as Record<string, string>
  } catch {
    cache = {}
  }
  try {
    const text = readFileSync(path.join(home, 'asr-log', day, 'snippets.jsonl'), 'utf8')
    let index = 0
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      index += 1
      try {
        const row = JSON.parse(raw) as { emb?: unknown; audio?: unknown }
        flags.set(index, {
          emb: (typeof row.emb === 'string' && row.emb.length > 0) || Boolean(cache[`${day}:${index}`]),
          audio: typeof row.audio === 'string' && row.audio.length > 0,
        })
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    // 没有日志就是空
  }
  return flags
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
