/**
 * Host-side generation jobs.
 *
 * The panel only starts a job and polls. Closing the sidebar, switching tabs,
 * or reloading the page does not cancel the model call — the job lives here
 * until it finishes, fails, or the user cancels it.
 *
 * Finished jobs are written to `jobs.json` so a later page load can still show
 * them. A Host restart cannot resume an in-flight model call; those rows are
 * marked interrupted on the next start.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobError {
  code: string
  message: string
  hint?: string
}

export interface MinutesJob {
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
  error?: JobError
}

export interface JobOutcome {
  added: number
  model?: string
  topic?: string
  elapsedMs?: number
}

export type JobRunner = (job: MinutesJob, signal: AbortSignal) => Promise<JobOutcome>

const FILE = 'jobs.json'
const MAX_CONCURRENT = 2
const MAX_JOBS = 40

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isStatus(value: unknown): value is JobStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'cancelled'
}

function readStored(home: string): MinutesJob[] {
  const file = path.join(home, FILE)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const items = Array.isArray(parsed) ? parsed : asRecord(parsed).jobs
    if (!Array.isArray(items)) return []
    return items.map((item) => normalizeStored(item)).filter((item): item is MinutesJob => item !== null)
  } catch {
    return []
  }
}

function normalizeStored(raw: unknown): MinutesJob | null {
  const record = asRecord(raw)
  const id = String(record.id ?? '').trim()
  const day = String(record.day ?? '').trim()
  const start = Number(record.start)
  const end = Number(record.end)
  if (!id || !day || !Number.isFinite(start) || !Number.isFinite(end) || !isStatus(record.status)) return null
  const error = asRecord(record.error)
  return {
    id,
    day,
    start,
    end,
    backgroundIds: Array.isArray(record.backgroundIds) ? record.backgroundIds.map((item) => String(item)).filter(Boolean) : [],
    ...(typeof record.skillId === 'string' && record.skillId ? { skillId: record.skillId } : {}),
    ...(typeof record.supplements === 'string' && record.supplements ? { supplements: record.supplements } : {}),
    status: record.status,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    ...(typeof record.startedAt === 'string' ? { startedAt: record.startedAt } : {}),
    ...(typeof record.finishedAt === 'string' ? { finishedAt: record.finishedAt } : {}),
    ...(Number.isFinite(Number(record.elapsedMs)) ? { elapsedMs: Number(record.elapsedMs) } : {}),
    ...(Number.isFinite(Number(record.added)) ? { added: Number(record.added) } : {}),
    ...(typeof record.model === 'string' && record.model ? { model: record.model } : {}),
    ...(typeof record.topic === 'string' && record.topic ? { topic: record.topic } : {}),
    ...(typeof error.message === 'string' && error.message
      ? { error: { code: String(error.code || 'ERROR'), message: error.message, ...(typeof error.hint === 'string' ? { hint: error.hint } : {}) } }
      : {}),
  }
}

export class MinutesJobStore {
  private jobs: MinutesJob[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly releases = new Map<string, () => void>()
  private running = 0
  private disposed = false
  private readonly home: string
  private readonly run: JobRunner

  constructor(home: string, run: JobRunner) {
    this.home = home
    this.run = run
    const now = new Date().toISOString()
    this.jobs = readStored(home).map((job) => {
      if (job.status !== 'queued' && job.status !== 'running') return job
      return {
        ...job,
        status: 'failed' as const,
        finishedAt: now,
        error: { code: 'INTERRUPTED', message: 'Host 重启，进行中的生成已中断', hint: '重新点「AI 生成纪要」即可。' },
      }
    })
    this.persist()
  }

  /** Abort in-flight calls and stop writing. Used when the plugin is reloaded. */
  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort()
    for (const release of this.releases.values()) release()
  }

  list(): MinutesJob[] {
    return this.jobs.map((job) => ({ ...job, backgroundIds: [...job.backgroundIds] }))
  }

  get(id: string): MinutesJob | undefined {
    const job = this.jobs.find((item) => item.id === id)
    return job ? { ...job, backgroundIds: [...job.backgroundIds] } : undefined
  }

  start(input: { day: string; start: number; end: number; backgroundIds?: string[]; skillId?: string; supplements?: string }): MinutesJob {
    const from = Math.min(input.start, input.end)
    const to = Math.max(input.start, input.end)
    const existing = this.jobs.find((job) => (
      (job.status === 'queued' || job.status === 'running')
      && job.day === input.day
      && Math.abs(job.start - from) < 0.5
      && Math.abs(job.end - to) < 0.5
    ))
    if (existing) return { ...existing, backgroundIds: [...existing.backgroundIds] }
    const job: MinutesJob = {
      id: `job-${randomUUID()}`,
      day: input.day,
      start: from,
      end: to,
      backgroundIds: [...new Set((input.backgroundIds ?? []).map((id) => String(id)).filter(Boolean))].slice(0, 12),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.supplements?.trim() ? { supplements: input.supplements.trim().slice(0, 20_000) } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    this.jobs = [job, ...this.jobs].slice(0, MAX_JOBS)
    this.persist()
    this.pump()
    return { ...job, backgroundIds: [...job.backgroundIds] }
  }

  cancel(id: string): MinutesJob {
    const job = this.jobs.find((item) => item.id === id)
    if (!job) throw new Error('任务不存在')
    if (job.status === 'queued') {
      this.finish(job, 'cancelled')
      return { ...job, backgroundIds: [...job.backgroundIds] }
    }
    if (job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.elapsedMs = job.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : undefined
      this.controllers.get(job.id)?.abort()
      this.persist()
      this.releases.get(job.id)?.()
    }
    return { ...job, backgroundIds: [...job.backgroundIds] }
  }

  clearFinished(): MinutesJob[] {
    this.jobs = this.jobs.filter((job) => job.status === 'queued' || job.status === 'running')
    this.persist()
    return this.list()
  }

  private persist(): void {
    if (this.disposed) return
    writeAtomic(path.join(this.home, FILE), `${JSON.stringify({ version: 1, jobs: this.jobs }, null, 2)}\n`)
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT) {
      const next = [...this.jobs].reverse().find((job) => job.status === 'queued')
      if (!next) return
      this.running += 1
      next.status = 'running'
      next.startedAt = new Date().toISOString()
      const controller = new AbortController()
      this.controllers.set(next.id, controller)
      const release = (): void => {
        if (this.releases.get(next.id) !== release) return
        this.releases.delete(next.id)
        this.controllers.delete(next.id)
        this.running = Math.max(0, this.running - 1)
        this.pump()
      }
      this.releases.set(next.id, release)
      this.persist()
      void this.execute(next, controller).finally(release)
    }
  }

  private async execute(job: MinutesJob, controller: AbortController): Promise<void> {
    try {
      const outcome = await this.run(job, controller.signal)
      if (job.status === 'cancelled' || controller.signal.aborted) {
        this.finish(job, 'cancelled')
        return
      }
      job.added = outcome.added
      job.model = outcome.model
      job.topic = outcome.topic
      job.elapsedMs = outcome.elapsedMs
      this.finish(job, 'done')
    } catch (error) {
      if (job.status === 'cancelled' || controller.signal.aborted) {
        this.finish(job, 'cancelled')
        return
      }
      const typed = error as { code?: unknown; hint?: unknown; message?: unknown; name?: unknown }
      const aborted = typed?.name === 'AbortError' || typed?.code === 'CANCELLED'
      if (aborted) {
        this.finish(job, 'cancelled')
        return
      }
      job.error = {
        code: typeof typed?.code === 'string' ? typed.code : 'ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof typed?.hint === 'string' ? { hint: typed.hint } : {}),
      }
      this.finish(job, 'failed')
    }
  }

  private finish(job: MinutesJob, status: 'done' | 'failed' | 'cancelled'): void {
    job.status = status
    job.finishedAt = new Date().toISOString()
    if (job.elapsedMs === undefined && job.startedAt) {
      job.elapsedMs = Math.max(0, Date.now() - Date.parse(job.startedAt))
    }
    this.persist()
  }
}
