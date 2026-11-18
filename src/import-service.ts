/**
 * 离线导入：起一个 `asr-helper transcribe` 子进程转写文件，把结果按任务落盘。
 *
 * 与实时采集的区别：
 * - 时间基准是文件内秒数，不是墙上时钟；
 * - 单轨，没有麦克风/系统之分；
 * - 不需要心跳：任务本身就是一次性的，进程退出即结束。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { MeetingService } from './service.ts'
import {
  appendSnippet,
  bucketsOf,
  clock,
  deleteImport,
  findByHash,
  fingerprint,
  importDir,
  listImports,
  makeImportId,
  patchMeta,
  readMeta,
  readMinutes,
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
    writeMeta(this.home, meta)
    this.spawnTranscribe(id, file, meta, modelDir)
    return { meta, duplicated: false }
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
      const current = readMeta(this.home, id)
      if (!current) return
      if (current.status !== 'running') return
      if (code === 0) {
        patchMeta(this.home, id, { status: 'done', processedSec: current.durationSec || current.processedSec })
        return
      }
      patchMeta(this.home, id, {
        status: current.processedSec > 0 ? 'done' : 'failed',
        error: current.processedSec > 0 ? undefined : (stderr.trim() || `转写进程退出（${code}）`),
      })
    })
    void meta
  }

  private onEvent(id: string, event: Record<string, unknown>): void {
    const type = String(event.type ?? '')
    if (type === 'start') {
      patchMeta(this.home, id, { durationSec: Number(event.durationSec) || 0, model: this.resolveModelDir() })
      return
    }
    if (type === 'progress') {
      patchMeta(this.home, id, { processedSec: Number(event.processedSec) || 0 })
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
      const current = readMeta(this.home, id)
      if (current) patchMeta(this.home, id, { snippets: current.snippets + 1 })
      return
    }
    if (type === 'error') {
      patchMeta(this.home, id, { status: 'failed', error: String(event.message ?? '转写失败') })
    }
  }

  cancel(id: string): boolean {
    const state = this.running.get(id)
    if (!state) return false
    state.child.kill('SIGKILL')
    this.running.delete(id)
    patchMeta(this.home, id, { status: 'cancelled' })
    return true
  }

  get(id: string): { meta: ImportMeta; snippets: ReturnType<typeof readSnippets>; buckets: Array<{ m: number; s: number }>; minutes: string | null } {
    const meta = readMeta(this.home, id)
    if (!meta) throw new ImportError('NO_IMPORT', '找不到这个导入任务')
    const snippets = readSnippets(this.home, id)
    return { meta, snippets, buckets: bucketsOf(snippets), minutes: readMinutes(this.home, id).markdown }
  }

  remove(id: string): boolean {
    if (this.running.has(id)) throw new ImportError('RUNNING', '任务还在转写，先取消再删除')
    return deleteImport(this.home, id)
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
