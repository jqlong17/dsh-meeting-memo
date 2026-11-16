/**
 * Supervises the Swift capture helper. The panel only flips enabled/mode;
 * closing the sidebar does not stop recording.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AsrModelRegistry, type AsrModel } from './asr-models.ts'
import { appendActivity, appendSnippet, asrLogRoot, dayKey, type AsrMode } from './asr-log.ts'
import { addChargedModel, applyMeasured, parseFootprint, trimMemory, type MemoryParts, type MemorySample } from './memory-sample.ts'
import { audioHealthOf, audioNeedsRestart, type AudioHealth } from './audio-health.ts'
import { sherpaCommand, sherpaReady, transcribeWav } from './sherpa.ts'

export interface AsrStatus {
  enabled: boolean
  running: boolean
  phase: 'idle' | 'starting' | 'running' | 'paused' | 'failed'
  mode: AsrMode
  language: AsrLanguage
  model: { id: string; name: string; path: string; kind?: string; format?: string; summary?: string; bytes?: number; appleCoreML?: boolean } | null
  rssBytes: number | null
  memory: MemorySample[]
  logRoot: string
  helper: string | null
  mic: boolean | null
  system: boolean | null
  /** 正在使用的麦克风名字。 */
  input: string
  /** 指定的设备 UID；空表示跟随系统默认。 */
  inputUID: string
  /** 可选输入设备。 */
  inputs: Array<{ uid: string; name: string; default?: boolean }>
  /** Whether audio frames actually arrive, not only whether speech was detected. */
  audio: AudioHealth
  audioRestarts: number
  message: string
  startedAt: string | null
  lastSnippetAt: string | null
  lastError: string | null
}

export type AsrLanguage = 'zhen' | 'zh' | 'en' | 'auto'

interface Persisted {
  enabled: boolean
  mode: AsrMode
  language: AsrLanguage
  /** 指定麦克风设备 UID；空表示跟随系统默认。 */
  input?: string
}

const FILE = 'asr-service.json'

/** 上一个 helper 的 pid：重载插件时旧进程可能没被回收，这里兜底清一次。 */
function pidFile(home: string): string {
  return path.join(home, 'asr-helper.pid')
}

function reapStaleHelper(home: string): void {
  let pid = 0
  try {
    pid = Number(readFileSync(pidFile(home), 'utf8').trim())
  } catch {
    return
  }
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return
  try {
    process.kill(pid, 0)
  } catch {
    return
  }
  // 只杀确实是我们的 helper，避免误伤同 pid 复用的其它进程
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (!command.includes('asr-helper')) return
  } catch {
    // macOS 没有 /proc；用 ps 兜底
    try {
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      if (!out.includes('asr-helper')) return
    } catch {
      return
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出
  }
}


function kanaHeavy(text: string): boolean {
  let kana = 0
  let han = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x3040 && code <= 0x30ff) kana += 1
    else if (code >= 0x4e00 && code <= 0x9fff) han += 1
  }
  return kana >= 2 && kana > han
}

function silenceWav(file: string): void {
  const samples = 8000
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([header, data]))
}

function processRss(pid: number): number | null {
  try {
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null
  } catch {
    return null
  }
}

function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function readPersisted(home: string): Persisted {
  const file = path.join(home, FILE)
  if (!existsSync(file)) return { enabled: true, mode: 'tracks', language: 'zhen' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown; mode?: unknown; language?: unknown; input?: unknown }
    const mode = parsed.mode === 'raw' || parsed.mode === 'merged' || parsed.mode === 'tracks' ? parsed.mode : 'tracks'
    const language = parsed.language === 'zh' || parsed.language === 'en' || parsed.language === 'auto' || parsed.language === 'zhen'
      ? parsed.language
      : 'zhen'
    const input = typeof parsed.input === 'string' && parsed.input.trim() ? parsed.input.trim() : undefined
    return { enabled: parsed.enabled !== false, mode, language, ...(input ? { input } : {}) }
  } catch {
    return { enabled: true, mode: 'tracks', language: 'zhen' }
  }
}

function writePersisted(home: string, value: Persisted): void {
  mkdirSync(home, { recursive: true })
  const file = path.join(home, FILE)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export class AsrRuntime {
  private readonly home: string
  private readonly timeZone: string
  private child: ChildProcess | null = null
  private persisted: Persisted
  private phase: AsrStatus['phase'] = 'idle'
  private message = '等待选择模型'
  private mic: boolean | null = null
  private system: boolean | null = null
  private startedAt: string | null = null
  private lastSnippetAt: string | null = null
  private lastError: string | null = null
  private helperPath: string | null = null
  private buffer = ''
  private generation = 0
  private runningModelId: string | null = null
  private memory: MemorySample[] = []
  private memoryTimer: ReturnType<typeof setInterval> | null = null
  /** Last footprint actually measured while an external model was loaded. */
  private loadedFor: string | null = null
  private loadedFootprint = 0
  /** Last moment the helper said anything at all. The mic can stall without exiting. */
  private lastEventAt = 0
  /** Per-minute audio ticks, used to tell a quiet room from a dead input tap. */
  private audioTicks: Record<string, unknown>[] = []
  /** 实际在用的麦克风名字，由 helper 上报。 */
  private inputName = ''
  /** 可用输入设备，启动时问一次 helper。 */
  private inputs: Array<{ uid: string; name: string; default?: boolean }> = []
  private audioRestarts = 0
  private lastReconnectAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private restarts = 0
  private disposed = false
  private readonly models: AsrModelRegistry
  private readonly root: string

  constructor(home: string, timeZone: string, sourceRoot: string = pluginRoot()) {
    this.home = home
    this.timeZone = timeZone
    this.models = new AsrModelRegistry(home)
    this.persisted = readPersisted(home)
    this.root = sourceRoot
    this.logRoot()
  }

  logRoot(): string {
    const root = asrLogRoot(this.home)
    mkdirSync(root, { recursive: true })
    return root
  }

  status(): AsrStatus {
    const model = this.models.selected()
    return {
      enabled: this.persisted.enabled,
      running: this.child !== null && this.phase === 'running',
      phase: this.persisted.enabled ? this.phase : 'paused',
      mode: this.persisted.mode,
      language: this.persisted.language,
      model: model ? {
        id: model.id,
        name: model.name,
        path: model.path,
        kind: model.kind,
        format: model.format,
        summary: model.summary,
        ...(model.bytes ? { bytes: model.bytes } : {}),
        appleCoreML: model.kind === 'coreml-sensevoice',
      } : null,
      rssBytes: this.child?.pid ? processRss(this.child.pid) : this.memory.at(-1)?.rss ?? null,
      memory: trimMemory(this.memory),
      logRoot: this.logRoot(),
      helper: this.helperPath,
      mic: this.mic,
      system: this.system,
      input: this.inputName,
      inputUID: this.persisted.input ?? '',
      inputs: this.inputs,
      audio: audioHealthOf(this.audioTicks, this.system !== false),
      audioRestarts: this.audioRestarts,
      message: this.message,
      startedAt: this.startedAt,
      lastSnippetAt: this.lastSnippetAt,
      lastError: this.lastError,
    }
  }

  async setEnabled(enabled: boolean): Promise<AsrStatus> {
    this.persisted.enabled = enabled
    writePersisted(this.home, this.persisted)
    if (!enabled) {
      this.stopChild()
      this.phase = 'paused'
      this.message = '已暂停。打开后会继续录音和转写。'
      return this.status()
    }
    await this.start()
    return this.status()
  }

  /** 切换麦克风：空字符串表示跟随系统默认。 */
  async setInput(uid: string): Promise<AsrStatus> {
    const clean = uid.trim()
    this.persisted = { ...this.persisted, ...(clean ? { input: clean } : {}) }
    if (!clean) delete this.persisted.input
    writePersisted(this.home, this.persisted)
    if (this.persisted.enabled) await this.start()
    return this.status()
  }

  /** 问 helper 有哪些输入设备（每次切换后刷新）。 */
  async refreshInputs(): Promise<void> {
    try {
      const helper = await this.ensureHelper()
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(helper, ['inputs'], { stdio: ['ignore', 'pipe', 'ignore'] })
        let text = ''
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => { text += chunk })
        child.on('error', reject)
        child.on('exit', () => resolve(text))
      })
      const line = out.split('\n').find((item) => item.includes('"type":"inputs"')) ?? ''
      if (line) {
        const parsed = JSON.parse(line) as { items?: Array<{ uid: string; name: string; default?: boolean }> }
        this.inputs = parsed.items ?? []
      }
    } catch {
      this.inputs = []
    }
  }

  async setMode(mode: AsrMode): Promise<AsrStatus> {
    this.persisted.mode = mode
    writePersisted(this.home, this.persisted)
    if (this.persisted.enabled && this.child) {
      this.stopChild()
      await this.start()
    }
    return this.status()
  }

  async setLanguage(language: AsrLanguage): Promise<AsrStatus> {
    this.persisted.language = language
    writePersisted(this.home, this.persisted)
    if (this.persisted.enabled && this.child) {
      this.stopChild()
      await this.start()
    }
    return this.status()
  }

  async start(): Promise<void> {
    if (this.disposed || !this.persisted.enabled) return
    const model = this.models.selected()
    if (!model) {
      this.phase = 'idle'
      this.message = '服务已打开，但还没有选定可录音的模型。'
      return
    }
    if (!model.usable) {
      this.phase = 'failed'
      this.message = '这个模型还不能用来录音。可选 Core ML，或 sherpa-onnx 的 SenseVoice / Zipformer / Moonshine。'
      return
    }
    if (model.kind !== 'coreml-sensevoice' && !sherpaReady(this.home)) {
      this.phase = 'failed'
      this.message = 'sherpa-onnx 官方运行时还没放进插件目录。'
      return
    }
    if (this.child && this.runningModelId === model.id) return
    if (this.child) this.stopChild()
    this.phase = 'starting'
    this.message = '正在启动采集…'
    try {
      const helper = await this.ensureHelper()
      void this.refreshInputs()
      this.spawn(helper, model)
    } catch (error) {
      this.phase = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.message = this.lastError
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopChild()
  }

  private spawn(helper: string, model: AsrModel): void {
    reapStaleHelper(this.home)
    const day = dayKey(this.timeZone)
    const audio = path.join(this.logRoot(), day, 'audio')
    const external = model.kind !== 'coreml-sensevoice'
    mkdirSync(audio, { recursive: true })
    const inputArgs = this.persisted.input ? ['--input', this.persisted.input] : []
    const args = external
      ? ['capture', '--engine', 'external', '--audio', audio, '--mode', this.persisted.mode, '--language', this.persisted.language, ...inputArgs]
      : ['capture', '--model', model.path, '--mode', this.persisted.mode, '--language', this.persisted.language, ...(this.persisted.mode === 'raw' ? ['--audio', audio] : []), ...inputArgs]
    try {
      writeFileSync(pidFile(this.home), String(child.pid ?? ''), 'utf8')
    } catch {
      // 记不下来不影响采集
    }
    const generation = ++this.generation
    this.runningModelId = model.id
    this.memory = []
    this.audioTicks = []
    this.watchMemory()
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.startedAt = new Date().toISOString()
    this.buffer = ''
    this.lastEventAt = Date.now()
    this.watchStall()
    if (external) this.probeLoaded(model)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      if (text) this.lastError = text.slice(0, 400)
    })
    child.on('exit', () => {
      if (generation !== this.generation) return
      if (this.child === child) this.child = null
      if (this.disposed || !this.persisted.enabled) {
        this.phase = 'paused'
        return
      }
      this.restarts += 1
      if (this.restarts > 5) {
        this.phase = 'failed'
        this.message = this.lastError || '采集进程反复退出，已停止自动重启。'
        return
      }
      this.phase = 'starting'
      this.message = '采集中断，正在重新启动…'
      setTimeout(() => { void this.start() }, 2_000)
    })
  }

  /**
   * The audio tap can die on sleep/wake or a device switch while the process
   * stays alive and silent. The helper emits activity once a minute, so a long
   * silence means capture is gone even though nothing exited.
   */
  private watchStall(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    const check = (): void => {
      if (!this.child || this.disposed) return
      const silentFor = Date.now() - this.lastEventAt
      if (silentFor < 180_000) return
      this.lastError = '采集进程三分钟没有心跳，已重启。'
      this.message = '麦克风好像断了，正在重新接上…'
      this.stopChild()
      setTimeout(() => { void this.start() }, 1_000)
    }
    this.watchdog = setInterval(check, 30_000)
    this.watchdog.unref?.()
  }

  private onData(chunk: string): void {
    this.lastEventAt = Date.now()
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(text) as Record<string, unknown>
      } catch {
        continue
      }
      this.apply(event)
    }
  }

  private apply(event: Record<string, unknown>): void {
    const type = String(event.type || '')
    if (type === 'status') {
      this.phase = 'running'
      this.mic = typeof event.mic === 'boolean' ? event.mic : this.mic
      this.system = typeof event.system === 'boolean' ? event.system : this.system
      if (typeof event.input === 'string') this.inputName = event.input
      this.message = this.system === false
        ? '正在听麦克风。系统声音还没开（需要屏幕录制权限）。'
        : '正在录音并转写。'
      this.restarts = 0
      return
    }
    if (type === 'error') {
      this.lastError = String(event.message || '采集出错')
      if (event.track === 'system') this.system = false
      if (event.track === 'mic') {
        this.phase = 'failed'
        this.message = this.lastError
      } else if (this.phase !== 'failed') {
        this.message = this.lastError
      }
      return
    }
    if (type === 'utt') {
      void this.transcribeUtt(event)
      return
    }
    if (type === 'snippet') {
      const startAt = String(event.startAt || '')
      const endAt = String(event.endAt || startAt)
      const text = String(event.text || '').trim()
      if (!startAt || !text) return
      const track = this.persisted.mode === 'merged' ? 'merged' : String(event.track || 'mic')
      const day = dayKey(this.timeZone, new Date(startAt))
      appendSnippet(this.logRoot(), {
        day,
        startAt,
        endAt,
        track,
        text,
        ...(typeof event.audio === 'string' ? { audio: event.audio } : {}),
      })
      this.lastSnippetAt = endAt
      return
    }
    if (type === 'activity') {
      const startAt = String(event.startAt || '')
      if (!startAt) return
      appendActivity(this.logRoot(), {
        day: dayKey(this.timeZone, new Date(startAt)),
        startAt,
        micSpeechSeconds: Number(event.micSpeechSeconds) || 0,
        systemSpeechSeconds: Number(event.systemSpeechSeconds) || 0,
        micChars: Number(event.micChars) || 0,
        systemChars: Number(event.systemChars) || 0,
        snippetCount: Number(event.snippetCount) || 0,
      })
      if (Number.isFinite(Number(event.micBuffers))) {
        this.audioTicks = [...this.audioTicks, event].slice(-8)
        const health = audioHealthOf(this.audioTicks, this.system !== false)
        if (audioNeedsRestart(health) && Date.now() - this.lastReconnectAt > 120_000) {
          this.reconnectForAudio()
        } else if (health.mic === 'ok' && this.phase === 'running' && !this.lastError?.startsWith('麦克风收不到')) {
          this.message = '正在录音并转写。'
        }
      }
    }
  }

  /**
   * A muted or detached input keeps the process alive and keeps writing
   * heartbeats, so the stall watchdog never fires. Rebuild the audio engine.
   */
  private reconnectForAudio(): void {
    this.lastReconnectAt = Date.now()
    this.audioRestarts += 1
    this.audioTicks = []
    this.restarts = 0
    this.message = '麦克风没有收到声音，正在重连…'
    this.lastError = '麦克风没有收到声音，已自动重连。'
    const model = this.models.selected()
    this.stopChild()
    if (!model) return
    setTimeout(() => {
      if (this.disposed || !this.persisted.enabled) return
      void this.start()
    }, 800).unref?.()
  }

  private async transcribeUtt(event: Record<string, unknown>): Promise<void> {
    const model = this.models.selected()
    const audio = typeof event.audio === 'string' ? event.audio : ''
    const startAt = String(event.startAt || '')
    const endAt = String(event.endAt || startAt)
    if (!model || !audio || !startAt) return
    try {
      let text = await transcribeWav(this.home, model.path, model.kind, audio, this.persisted.language, (child) => this.watchLoaded(model.id, child.pid))
      if (this.persisted.language === 'zhen' && kanaHeavy(text)) {
        const zh = await transcribeWav(this.home, model.path, model.kind, audio, 'zh', (child) => this.watchLoaded(model.id, child.pid))
        if (zh) text = zh
      }
      if (!text) return
      const track = this.persisted.mode === 'merged' ? 'merged' : String(event.track || 'mic')
      appendSnippet(this.logRoot(), {
        day: dayKey(this.timeZone, new Date(startAt)),
        startAt,
        endAt,
        track,
        text,
        ...(this.persisted.mode === 'raw' ? { audio } : {}),
      })
      this.lastSnippetAt = endAt
      this.message = `正在用 ${model.name} 转写。`
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.message = this.lastError
    }
  }

  private footprint(pid: number): Promise<MemoryParts | null> {
    return new Promise((resolve) => {
      const child = spawn('/usr/bin/footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      let text = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => { text += chunk })
      child.on('error', () => resolve(null))
      child.on('exit', () => {
        if (!text.trim()) {
          resolve(null)
          return
        }
        resolve(parseFootprint(text, processRss(pid) ?? 0))
      })
    })
  }

  private async sampleMemory(pid: number): Promise<void> {
    const own = await this.footprint(pid)
    if (!own) return
    let parts = own
    const extra = spawn('pgrep', ['-f', 'sherpa-onnx-offline'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pids = await new Promise<number[]>((resolve) => {
      let text = ''
      extra.stdout?.setEncoding('utf8')
      extra.stdout?.on('data', (chunk) => { text += chunk })
      extra.on('error', () => resolve([]))
      extra.on('exit', () => resolve(text.split('\n').map(Number).filter((value) => Number.isFinite(value) && value > 0 && value !== pid)))
    })
    for (const extraPid of pids.slice(0, 2)) {
      const sampled = await this.footprint(extraPid)
      if (sampled) parts = addChargedModel(parts, sampled)
    }
    const model = this.models.selected()
    const held = model && this.loadedFor === model.id ? this.loadedFootprint : 0
    if (parts.footprint > held + 32 * 1024 * 1024 && model && model.kind !== 'coreml-sensevoice') {
      this.loadedFor = model.id
      this.loadedFootprint = parts.footprint
    }
    const occupied = applyMeasured(parts, held)
    this.memory = trimMemory([...this.memory, { at: new Date().toISOString(), ...occupied }])
  }

  /** Sample a live loader until it exits. The number is the process footprint, not the file size. */
  private watchLoaded(modelId: string, pid: number | undefined): void {
    if (!pid) return
    const tick = (): void => {
      void this.footprint(pid).then((parts) => {
        if (!parts || parts.footprint < 32 * 1024 * 1024) return
        if (this.loadedFor !== modelId) this.loadedFootprint = 0
        this.loadedFor = modelId
        this.loadedFootprint = Math.max(this.loadedFootprint, parts.footprint)
        const latest = this.memory.at(-1)
        const base = latest ?? { at: new Date().toISOString(), rss: 0, footprint: 0, occupied: 0, model: 0, mapped: 0, audio: 0, heap: 0, fixed: 0 }
        const next = applyMeasured(base, this.loadedFootprint)
        this.memory = trimMemory([...this.memory, { ...next, at: new Date().toISOString() }])
      })
    }
    tick()
    const timer = setInterval(tick, 400)
    timer.unref?.()
    setTimeout(() => clearInterval(timer), 20_000).unref?.()
  }

  /** Load the selected external model once so the panel has a real reading before anyone speaks. */
  private probeLoaded(model: AsrModel): void {
    if (model.kind === 'coreml-sensevoice') return
    if (this.loadedFor === model.id && this.loadedFootprint > 0) return
    const wav = path.join(this.home, '.probe.wav')
    try {
      silenceWav(wav)
    } catch {
      return
    }
    const command = sherpaCommand(this.home, model.path, model.kind, wav)
    if (!command) return
    const child = spawn(command.bin, command.args, {
      env: { ...process.env, DYLD_LIBRARY_PATH: command.lib },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    this.watchLoaded(model.id, child.pid)
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 12_000).unref?.()
  }

  private watchMemory(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer)
    const tick = (): void => {
      const pid = this.child?.pid
      if (!pid) return
      void this.sampleMemory(pid)
    }
    tick()
    this.memoryTimer = setInterval(tick, 5_000)
    this.memoryTimer.unref?.()
  }

  private stopChild(): void {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.generation += 1
    this.runningModelId = null
    const child = this.child
    this.child = null
    if (!child) return
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 1_500).unref?.()
  }

  private async ensureHelper(): Promise<string> {
    const source = path.join(this.root, 'native', 'asr-helper.swift')
    if (!existsSync(source)) throw new Error(`找不到采集助手源码：${source}`)
    const outDir = path.join(this.home, 'bin')
    mkdirSync(outDir, { recursive: true })
    const binary = path.join(outDir, 'asr-helper')
    const sourceTime = statSync(source).mtimeMs
    const binaryTime = existsSync(binary) ? statSync(binary).mtimeMs : 0
    if (binaryTime >= sourceTime) {
      this.helperPath = binary
      return binary
    }
    await new Promise<void>((resolve, reject) => {
      const compile = spawn('swiftc', [
        '-O', '-o', binary, source,
        '-framework', 'AVFoundation',
        '-framework', 'CoreML',
        '-framework', 'ScreenCaptureKit',
        '-framework', 'CoreMedia',
        '-framework', 'AudioToolbox',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      compile.stderr?.on('data', (chunk) => { err += String(chunk) })
      compile.on('error', reject)
      compile.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(err.trim().slice(0, 500) || `swiftc 退出 ${code}`))
      })
    })
    this.helperPath = binary
    return binary
  }
}
