/**
 * 离线导入：起一个 `asr-helper transcribe` 子进程转写文件，把结果按任务落盘。
 *
 * 与实时采集的区别：
 * - 时间基准是文件内秒数，不是墙上时钟；
 * - 单轨，没有麦克风/系统之分；
 * - 不需要心跳：任务本身就是一次性的，进程退出即结束。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { MeetingService } from './service.ts'
import {
  appendSnippet,
  clock,
  trashImport,
  purgeTrash,
  findByHash,
  fingerprint,
  importDir,
  listImports,
  makeImportId,
  patchMeta,
  readMeta,
  readMinutes,
  updateSnippetText as updateImportText,
  readSnippets,
  writeMeta,
  writeMinutes,
  type ImportMeta,
} from './imports.ts'
import { buildPrompt, clipText, parseMeetings } from './ai.ts'
import { builtinSkill } from './skills.ts'

export class ImportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface Running {
  child: ChildProcess
  buffer: string
}

export class ImportService {
  private running = new Map<string, Running>()
  /** 串行队列：一次只跑一个转写，避免多个进程同时加载模型占满内存。 */
  private queue: Array<{ id: string; file: string }> = []
  private busy = false
  /** 待落盘的 meta 改动：进度/句数这类高频更新合并写，避免一分钟几十次落盘。 */
  private pending = new Map<string, Partial<ImportMeta>>()
  private lastFlush = new Map<string, number>()

  private readonly service: MeetingService
  private readonly helper: string
  /** 运行时取当前选中的模型目录与语言：用户在「转写服务」里换了就跟着换。 */
  private readonly resolveModelDir: () => string
  private readonly resolveLanguage: () => string

  constructor(
    service: MeetingService,
    helper: string,
    resolveModelDir: () => string,
    resolveLanguage: () => string,
  ) {
    this.service = service
    this.helper = helper
    this.resolveModelDir = resolveModelDir
    this.resolveLanguage = resolveLanguage
  }

  private get home(): string {
    return this.service.config.home
  }

  /**
   * 清扫 /tmp 里 24 小时前的 `asr-import-*.m4a`。
   *
   * 转写被取消（SIGKILL）时子进程的 defer 不会执行，抽出来的临时音轨会留在磁盘上。
   * 每次插件启动扫一遍，代价极小。
   */
  /** 启动时清掉回收站里超过 7 天的任务。 */
  static sweepTrash(home: string, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    try {
      return purgeTrash(home, olderThanMs)
    } catch {
      return 0
    }
  }

  static sweepTempFiles(olderThanMs = 24 * 60 * 60 * 1000): number {
    let removed = 0
    try {
      const dir = os.tmpdir()
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('asr-import-') || !name.endsWith('.m4a')) continue
        const full = path.join(dir, name)
        try {
          if (Date.now() - statSync(full).mtimeMs < olderThanMs) continue
          unlinkSync(full)
          removed += 1
        } catch {
          // 删不掉就算了
        }
      }
    } catch {
      // 扫不了就算了
    }
    return removed
  }

  list(): ImportMeta[] {
    return listImports(this.home)
  }

  /** 开始转写：算指纹、查重、建目录、起子进程。 */
  start(file: string): { meta: ImportMeta; duplicated: boolean } {
    if (!file || !existsSync(file)) throw new ImportError('NO_FILE', '文件不存在或读不了')
    const { hash, size } = fingerprint(file)
    const existing = findByHash(this.home, hash)
    if (existing) return { meta: existing, duplicated: true }
    const modelDir = this.resolveModelDir()
    if (!modelDir || !existsSync(modelDir)) throw new ImportError('NO_MODEL', '还没有下载语音模型，先去「转写服务」下载')

    const id = makeImportId(hash)
    const meta: ImportMeta = {
      version: 1,
      id,
      name: path.basename(file),
      size,
      hash,
      durationSec: 0,
      createdAt: new Date().toISOString(),
      status: 'running',
      processedSec: 0,
      snippets: 0,
    }
    const queued = { ...meta, status: 'queued' as const }
    writeMeta(this.home, queued)
    this.queue.push({ id, file })
    void this.pump()
    return { meta: queued, duplicated: false }
  }

  /** 串行处理队列：上一个结束（或失败）才起下一个。 */
  private async pump(): Promise<void> {
    if (this.busy) return
    const next = this.queue.shift()
    if (!next) return
    this.busy = true
    const meta = readMeta(this.home, next.id)
    if (meta && meta.status === 'queued') {
      const modelDir = this.resolveModelDir()
      if (!modelDir || !existsSync(modelDir)) {
        patchMeta(this.home, next.id, { status: 'failed', error: '还没有下载语音模型' })
      } else {
        patchMeta(this.home, next.id, { status: 'running', startedAt: new Date().toISOString() })
        this.spawnTranscribe(next.id, next.file, meta, modelDir)
        return
      }
    }
    this.busy = false
    void this.pump()
  }

  /**
   * 合并写 meta：普通的进度/计数攒着，每 10 秒落一次；
   * 状态变化（done/failed/cancelled）立刻落，不能等。
   */
  private queueMeta(id: string, patch: Partial<ImportMeta>): void {
    const merged = { ...(this.pending.get(id) ?? {}), ...patch }
    this.pending.set(id, merged)
    const urgent = patch.status !== undefined || patch.finishedAt !== undefined || patch.startedAt !== undefined
    const last = this.lastFlush.get(id) ?? 0
    if (urgent || Date.now() - last >= 10_000) this.flushMeta(id)
  }

  private flushMeta(id: string): void {
    const patch = this.pending.get(id)
    if (!patch) return
    this.pending.delete(id)
    this.lastFlush.set(id, Date.now())
    patchMeta(this.home, id, patch)
  }

  private spawnTranscribe(id: string, file: string, meta: ImportMeta, modelDir: string): void {
    const child = spawn(this.helper, ['transcribe', '--file', file, '--model', modelDir, '--language', this.resolveLanguage()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state: Running = { child, buffer: '' }
    this.running.set(id, state)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      state.buffer += chunk
      const lines = state.buffer.split('\n')
      state.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        this.onEvent(id, event)
      }
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000)
    })
    child.on('exit', (code) => {
      this.running.delete(id)
      this.busy = false
      void this.pump()

      const current = readMeta(this.home, id)
      if (!current) return
      if (current.status !== 'running') return
      const finishedAt = new Date().toISOString()
      if (code === 0) {
        this.queueMeta(id, { status: 'done', processedSec: current.durationSec || current.processedSec, finishedAt })
        return
      }
      this.queueMeta(id, {
        status: current.processedSec > 0 ? 'done' : 'failed',
        finishedAt,
        error: current.processedSec > 0 ? undefined : (stderr.trim() || `转写进程退出（${code}）`),
      })
    })
    void meta
  }

  private onEvent(id: string, event: Record<string, unknown>): void {
    const type = String(event.type ?? '')
    if (type === 'start') {
      this.queueMeta(id, { durationSec: Number(event.durationSec) || 0, model: this.resolveModelDir() })
      return
    }
    if (type === 'progress') {
      this.queueMeta(id, { processedSec: Number(event.processedSec) || 0 })
      return
    }
    if (type === 'snippet') {
      const text = String(event.text ?? '').trim()
      if (!text) return
      appendSnippet(this.home, id, {
        startSec: Number(event.startSec) || 0,
        endSec: Number(event.endSec) || 0,
        text,
      })
      const pending = this.pending.get(id)?.snippets
      const base = pending ?? readMeta(this.home, id)?.snippets ?? 0
      this.queueMeta(id, { snippets: base + 1 })
      return
    }
    if (type === 'error') {
      this.queueMeta(id, { status: 'failed', finishedAt: new Date().toISOString(), error: String(event.message ?? '转写失败') })
    }
  }

  /** 弹系统文件选择框，返回选中的绝对路径（可能是多个）。 */
  async pick(): Promise<string[]> {
    return new Promise((resolve) => {
      const child = spawn(this.helper, ['pick'], { stdio: ['ignore', 'pipe', 'inherit'] })
      let stdout = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.on('exit', () => {
        const line = stdout.split('\n').map((item) => item.trim()).filter(Boolean).pop() ?? ''
        try {
          const parsed = JSON.parse(line) as { paths?: string[] }
          resolve(Array.isArray(parsed.paths) ? parsed.paths : [])
        } catch {
          resolve([])
        }
      })
      child.on('error', () => resolve([]))
    })
  }

  cancel(id: string): boolean {
    const queuedAt = this.queue.findIndex((item) => item.id === id)
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1)
      this.queueMeta(id, { status: 'cancelled', finishedAt: new Date().toISOString() })
      return true
    }
    const state = this.running.get(id)
    if (!state) return false
    state.child.kill('SIGKILL')
    this.running.delete(id)
    this.queueMeta(id, { status: 'cancelled', finishedAt: new Date().toISOString() })
    return true
  }

  /**
   * 读任务详情。`fromIndex` 用于增量拉取：面板已经有的片段不必每 2 秒重传一遍。
   * 密度桶由面板自己按已有片段算，这里不再重复计算。
   */
  get(id: string, fromIndex = 0): {
    meta: ImportMeta
    snippets: Array<ReturnType<typeof readSnippets>[number] & { index: number }>
    total: number
    minutes: string | null
    /** 已生成的纪要区间（分钟，相对文件），面板画成绿色条。 */
    sessions: Array<{ start: number; end: number; topic: string }>
  } {
    const meta = readMeta(this.home, id)
    if (!meta) throw new ImportError('NO_IMPORT', '找不到这个导入任务')
    const all = readSnippets(this.home, id)
    const start = Number.isFinite(fromIndex) && fromIndex > 0 ? Math.min(fromIndex, all.length) : 0
    const stored = readMinutes(this.home, id)
    return {
      meta,
      // 带上绝对下标：面板并发拉取时按 index 去重，避免同一条追加两次
      snippets: all.slice(start).map((row, offset) => ({ index: start + offset, ...row })),
      total: all.length,
      minutes: stored.markdown,
      sessions: stored.sessions,
    }
  }

  /** 删除任务：挪进回收站，7 天后自动清理，不是立刻抹掉。 */
  /** 改某一句的正文（下标从 0 开始），返回是否成功。 */
  updateLine(id: string, index: number, text: string): boolean {
    return updateImportText(this.home, id, index, text)
  }

  remove(id: string): boolean {
    if (this.running.has(id)) throw new ImportError('RUNNING', '任务还在转写，先取消再删除')
    return trashImport(this.home, id) !== null
  }

  /** 用导入任务的转写生成纪要，结果只写在任务目录里。 */
  async generate(id: string, startSec?: number, endSec?: number, signal?: AbortSignal): Promise<{ markdown: string; sessions: number }> {
    const { meta, snippets: all } = this.get(id)
    const fallbackEnd = meta.durationSec > 0 ? meta.durationSec : Number.MAX_SAFE_INTEGER
    const from = Math.max(0, Math.min(startSec ?? 0, endSec ?? fallbackEnd))
    const to = Math.max(from + 1, endSec ?? meta.durationSec)
    const picked = all.filter((item) => item.endSec > from && item.startSec < to)
    if (!picked.length) throw new ImportError('EMPTY_RANGE', '这段区间没有转写内容')
    const lines = picked.map((item) => `[${clock(item.startSec)}] ${item.text}`)
    const clipped = clipText(lines.join('\n'), 30_000)
    const prompt = buildPrompt({
      day: meta.createdAt.slice(0, 10),
      range: { start: from / 60, end: to / 60 },
      transcript: clipped.text,
      truncated: clipped.truncated,
      backgrounds: [],
      system: builtinSkill().prompt,
    })
    const output = await this.service.streamPrompt(prompt, { ...(signal ? { signal } : {}) })
    let meetings
    try {
      meetings = parseMeetings(output, { start: from / 60, end: to / 60 }, false)
    } catch {
      throw new ImportError('AI_OUTPUT', '模型输出无法解析，重试或换个模型')
    }
    const markdown = meetings.map((meeting) => {
      const head = `## ${clock(meeting.start * 60)}–${clock(meeting.end * 60)} ${meeting.topic}`
      return `${head}\n\n${meeting.content.trim()}\n\n> 来源：离线导入 · ${meta.name}（${clock(from)}–${clock(to)}）`
    }).join('\n\n---\n\n')
    writeMinutes(this.home, id, `${markdown}\n`, {
      version: 1,
      id,
      name: meta.name,
      range: { from, to },
      sessions: meetings.map((meeting) => ({
        start: meeting.start,
        end: meeting.end,
        topic: meeting.topic,
        content: meeting.content,
      })),
      generatedAt: new Date().toISOString(),
    })
    patchMeta(this.home, id, { minutesAt: new Date().toISOString() })
    return { markdown, sessions: meetings.length }
  }

  /** 目录里绝不该出现音频：测试与维护用。 */
  hasAudio(id: string): boolean {
    try {
      const dir = importDir(this.home, id)
      process.env
      return existsSync(path.join(dir, 'audio'))
    } catch {
      return false
    }
  }
}
