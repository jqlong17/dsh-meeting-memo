/**
 * ASR model registry. The plugin never downloads weights.
 * A model is either a directory the user points at, or a copy/symlink placed
 * in the plugin home under `models/`.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type AsrModelKind = 'coreml-sensevoice' | 'onnx-sensevoice' | 'zipformer' | 'moonshine' | 'whisper' | 'detect' | 'tts' | 'vad' | 'unknown'
export type ModelCapability = 'asr' | 'tts' | 'detect' | 'vad' | 'other'

export interface AsrModel {
  id: string
  name: string
  path: string
  kind: AsrModelKind
  capabilities: ModelCapability[]
  usable: boolean
  format: string
  source: 'library' | 'manual'
  bytes?: number
  summary: string
  addedAt: string
  note?: string
}

export interface ModelProbe {
  ok: boolean
  kind: AsrModelKind
  path: string
  name: string
  missing: string[]
  vocab?: number
}

const FILE = 'asr-models.json'

const KINDS: AsrModelKind[] = ['coreml-sensevoice', 'onnx-sensevoice', 'zipformer', 'moonshine', 'whisper', 'detect', 'tts', 'vad', 'unknown']

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function bundledModelsDir(home: string): string {
  return path.join(home, 'models')
}

export function probeModel(input: string): ModelProbe {
  const resolved = path.resolve(input)
  const missing: string[] = []
  if (!existsSync(resolved)) {
    return { ok: false, kind: 'unknown', path: resolved, name: path.basename(resolved), missing: ['目录不存在'] }
  }
  const encoder = path.join(resolved, 'SenseVoiceSmall_int8.mlmodelc')
  const prep = path.join(resolved, 'SenseVoicePreprocessor.mlmodelc')
  const vocab = path.join(resolved, 'vocab.json')
  if (existsSync(encoder) || existsSync(prep) || existsSync(vocab)) {
    if (!existsSync(encoder)) missing.push('SenseVoiceSmall_int8.mlmodelc')
    if (!existsSync(prep)) missing.push('SenseVoicePreprocessor.mlmodelc')
    if (!existsSync(vocab)) missing.push('vocab.json')
    let vocabCount: number | undefined
    if (existsSync(vocab)) {
      try {
        const parsed = JSON.parse(readFileSync(vocab, 'utf8')) as unknown
        if (Array.isArray(parsed)) vocabCount = parsed.length
      } catch {
        missing.push('vocab.json 无法解析')
      }
    }
    return {
      ok: missing.length === 0,
      kind: 'coreml-sensevoice',
      path: resolved,
      name: path.basename(resolved),
      missing,
      ...(vocabCount ? { vocab: vocabCount } : {}),
    }
  }
  const onnx = ['model.onnx', 'tokens.txt'].filter((name) => !existsSync(path.join(resolved, name)))
  if (onnx.length < 2) {
    return {
      ok: onnx.length === 0,
      kind: 'onnx-sensevoice',
      path: resolved,
      name: path.basename(resolved),
      missing: onnx,
    }
  }
  return { ok: false, kind: 'unknown', path: resolved, name: path.basename(resolved), missing: ['不是 Core ML SenseVoice，也不是 sherpa-onnx 目录'] }
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function dirBytes(dir: string, depth = 0): number {
  if (depth > 4) return 0
  let total = 0
  for (const name of namesIn(dir)) {
    if (name === 'test_wavs' || name === '.cache' || name === '.git') continue
    const target = path.join(dir, name)
    let stat
    try {
      stat = lstatSync(target)
    } catch {
      continue
    }
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      try {
        const followed = statSync(target)
        total += followed.isDirectory() ? dirBytes(realpathSync(target), depth + 1) : followed.size
      } catch {
        // Broken link.
      }
      continue
    }
    total += stat.size
  }
  return total
}

function stableId(modelPath: string): string {
  let hash = 0
  for (const char of modelPath) hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0
  return `lib-${(hash >>> 0).toString(16)}`
}

function describe(model: { kind: AsrModelKind; name: string; format: string }): string {
  if (model.kind === 'coreml-sensevoice') return '苹果 Core ML int8，专门给 Mac 用。当前录音只加载这一类。'
  if (model.kind === 'onnx-sensevoice') return '官方运行时可以用来录音。中英日韩粤，和苹果那份不是同一份权重。'
  if (model.kind === 'zipformer') return model.format.includes('流式') ? '可以用来录音。流式 Zipformer，按一句一句转写。' : '可以用来录音。离线中文 Zipformer。'
  if (model.kind === 'moonshine') return '可以用来录音。英语小模型，不是中文主模型。'
  if (model.kind === 'whisper') return '这是 Whisper 权重文件，当前录音运行时读不了，所以还不能用来录音。'
  if (model.kind === 'detect') return /omni/i.test(model.name) ? '界面可点区域框，偏图标，不是语音模型。' : '界面结构 / 文本框检测，只出框，不转写。'
  if (model.kind === 'tts') return '语音合成，把文字读成声音，不是识别。'
  if (model.kind === 'vad') return '语音活动或音频事件检测，用来判断有没有人在说话。'
  return '识别到权重，但还不能确定用途。'
}

export function classifyModel(dir: string): Omit<AsrModel, 'id' | 'addedAt' | 'source'> | null {
  const resolved = path.resolve(dir)
  if (!existsSync(resolved)) return null
  const name = path.basename(resolved).toLowerCase()
  const files = namesIn(resolved)
  const lower = files.map((file) => file.toLowerCase())
  const has = (needle: string): boolean => lower.includes(needle) || lower.some((file) => file.endsWith(needle))
  const bytes = dirBytes(resolved)
  const base = { name: path.basename(resolved), path: resolved, bytes }

  if (has('.mlmodelc') && has('vocab.json')) {
    return { ...base, kind: 'coreml-sensevoice', capabilities: ['asr'], usable: true, format: 'Apple Core ML' }
  }
  if (name.includes('yamnet') || has('yamnet.onnx') || name.includes('silero') || has('silero_vad.onnx')) {
    return { ...base, kind: 'vad', capabilities: ['vad'], usable: false, format: name.includes('silero') || has('silero_vad.onnx') ? '语音检测' : '事件检测' }
  }
  if (/kokoro|vits|matcha|piper|chattts|cosyvoice|bark|melo|tts/.test(name)) {
    return { ...base, kind: 'tts', capabilities: ['tts'], usable: false, format: '语音合成' }
  }
  if (name.includes('omniparser') || name.includes('screenparser') || name.includes('icon_detect') || has('best.pt') && !has('tokens.txt')) {
    return { ...base, kind: 'detect', capabilities: ['detect'], usable: false, format: name.includes('omni') ? '界面可点区域框' : '界面结构 / 文本框' }
  }
  if (name.includes('whisper') || lower.some((file) => /^(tiny|base|small|medium|large|large-v\d+)\.pt$/.test(file))) {
    const variants = files.filter((file) => file.endsWith('.pt'))
    return { ...base, kind: 'whisper', capabilities: ['asr'], usable: false, format: 'openai-whisper .pt', ...(variants.length ? { note: variants.join(' · ') } : {}) }
  }
  if (lower.some((file) => file.endsWith('.ort')) && has('tokens.txt')) {
    return { ...base, kind: 'moonshine', capabilities: ['asr'], usable: true, format: 'Moonshine' }
  }
  if (has('tokens.txt') && lower.some((file) => file.endsWith('.onnx'))) {
    const streaming = name.includes('streaming') || lower.some((file) => file.includes('joiner') || file.includes('encoder'))
    return {
      ...base,
      kind: name.includes('sensevoice') || has('model.onnx') && has('config.yaml') ? 'onnx-sensevoice' : 'zipformer',
      capabilities: ['asr'],
      usable: true,
      format: name.includes('sensevoice') ? 'SenseVoice' : streaming ? 'Zipformer 流式' : 'Zipformer',
    }
  }
  if (bytes > 0 && lower.some((file) => /\.(onnx|pt|ort|bin|gguf|mlmodelc)$/.test(file))) {
    return { ...base, kind: 'unknown', capabilities: ['other'], usable: false, format: '未识别权重' }
  }
  return null
}

export function scanLibrary(dir: string): AsrModel[] {
  const resolved = path.resolve(dir)
  if (!existsSync(resolved)) return []
  const self = classifyModel(resolved)
  const children = self ? [] : namesIn(resolved)
    .filter((name) => !name.startsWith('.') && name !== 'README.md')
    .map((name) => path.join(resolved, name))
    .filter((child) => {
      try {
        return statSync(child).isDirectory()
      } catch {
        return false
      }
    })
  const found = (self ? [resolved] : children).map((child) => {
    const classified = classifyModel(child)
    if (!classified) return null
    return {
      id: stableId(classified.path),
      addedAt: '',
      source: 'library' as const,
      ...classified,
      summary: classified.summary || describe(classified),
    }
  }).filter((item): item is AsrModel => item !== null)
  found.sort((a, b) => a.name.localeCompare(b.name))
  return found
}

function readStore(home: string): { selectedId: string | null; library: string | null; models: AsrModel[] } {
  const file = path.join(home, FILE)
  if (!existsSync(file)) return { selectedId: null, library: null, models: [] }
  try {
    const parsed = asRecord(JSON.parse(readFileSync(file, 'utf8')))
    const models = Array.isArray(parsed.models) ? parsed.models.map(normalize).filter((item): item is AsrModel => item !== null) : []
    const selectedId = typeof parsed.selectedId === 'string' ? parsed.selectedId : null
    const library = typeof parsed.library === 'string' && parsed.library.trim()
      ? parsed.library
      : null
    return { selectedId, library, models }
  } catch {
    return { selectedId: null, library: null, models: [] }
  }
}

function normalize(raw: unknown): AsrModel | null {
  const record = asRecord(raw)
  const id = String(record.id ?? '').trim()
  const modelPath = String(record.path ?? '').trim()
  if (!id || !modelPath) return null
  const kind = KINDS.includes(record.kind as AsrModelKind) ? record.kind as AsrModelKind : 'unknown'
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.map(String).filter((item): item is ModelCapability => item === 'asr' || item === 'tts' || item === 'detect' || item === 'vad' || item === 'other')
    : kind === 'coreml-sensevoice' || kind === 'onnx-sensevoice' ? ['asr' as const] : ['other' as const]
  return {
    id,
    name: String(record.name || path.basename(modelPath)),
    path: modelPath,
    kind,
    capabilities,
    usable: record.usable === true || kind === 'coreml-sensevoice',
    format: typeof record.format === 'string' ? record.format : kind,
    source: 'manual',
    ...(Number.isFinite(Number(record.bytes)) ? { bytes: Number(record.bytes) } : {}),
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date().toISOString(),
    summary: typeof record.summary === 'string' && record.summary ? record.summary : describe({ kind, name: String(record.name || path.basename(modelPath)), format: typeof record.format === 'string' ? record.format : kind }),
    ...(typeof record.note === 'string' && record.note ? { note: record.note } : {}),
  }
}

export class AsrModelRegistry {
  private readonly home: string

  constructor(home: string) {
    this.home = home
  }

  bundledDir(): string {
    ensureDir(bundledModelsDir(this.home))
    return bundledModelsDir(this.home)
  }

  list(): { selectedId: string | null; library: string | null; models: AsrModel[]; bundledDir: string; suggestion: ModelProbe | null } {
    const store = readStore(this.home)
    const suggestion = null
    return {
      selectedId: store.selectedId,
      library: store.library,
      models: this.catalog(store),
      bundledDir: this.bundledDir(),
      suggestion: suggestion && !store.models.some((model) => model.path === suggestion.path) ? suggestion : null,
    }
  }

  selected(): AsrModel | null {
    const store = readStore(this.home)
    return this.catalog(store).find((model) => model.id === store.selectedId) ?? null
  }

  ensureLibrary(fallback: string): string {
    const store = readStore(this.home)
    const root = store.library || fallback
    ensureDir(root)
    if (store.library !== root) {
      store.library = root
      this.write(store)
    }
    return root
  }

  setLibrary(inputPath: string): string {
    const resolved = path.resolve(inputPath)
    ensureDir(resolved)
    const store = readStore(this.home)
    store.library = resolved
    this.write(store)
    return resolved
  }

  add(inputPath: string, name?: string): AsrModel {
    const scanned = scanLibrary(inputPath)
    const probe = probeModel(inputPath)
    if (scanned.length > 1 || (scanned.length === 1 && scanned[0].path !== path.resolve(inputPath))) {
      this.setLibrary(inputPath)
      return scanned[0]
    }
    if (!probe.ok && !classifyModel(inputPath)) {
      throw new Error(probe.missing.length ? `模型不完整：${probe.missing.join('、')}` : '无法识别这个模型目录')
    }
    const store = readStore(this.home)
    const existing = store.models.find((model) => model.path === probe.path)
    if (existing) {
      if (existing.usable) this.select(existing.id)
      return existing
    }
    const classified = classifyModel(probe.path)
    const model: AsrModel = {
      id: `model-${randomUUID()}`,
      name: (name || probe.name).trim() || probe.name,
      path: probe.path,
      kind: classified?.kind ?? probe.kind,
      capabilities: classified?.capabilities ?? (probe.kind === 'coreml-sensevoice' ? ['asr'] : ['other']),
      usable: classified?.usable ?? probe.kind === 'coreml-sensevoice',
      format: classified?.format ?? probe.kind,
      summary: describe({
        kind: classified?.kind ?? probe.kind,
        name: (name || probe.name).trim() || probe.name,
        format: classified?.format ?? probe.kind,
      }),
      source: 'manual',
      ...(classified?.bytes ? { bytes: classified.bytes } : {}),
      addedAt: new Date().toISOString(),
      ...(probe.vocab ? { note: `${probe.vocab} tokens` } : {}),
    }
    store.models.unshift(model)
    if (model.usable) store.selectedId = model.id
    this.write(store)
    return model
  }

  select(id: string): AsrModel {
    const store = readStore(this.home)
    const model = this.catalog(store).find((item) => item.id === id)
    if (!model) throw new Error('模型不存在')
    if (!model.usable) throw new Error('这个模型已识别，但当前录音运行时还接不上。ASR 可切换 Core ML、sherpa-onnx SenseVoice / Zipformer / Moonshine。')
    store.selectedId = id
    this.write(store)
    return model
  }

  remove(id: string): void {
    const store = readStore(this.home)
    store.models = store.models.filter((model) => model.id !== id)
    if (store.selectedId === id) store.selectedId = store.models[0]?.id ?? null
    this.write(store)
  }

  private catalog(store: { library: string | null; models: AsrModel[] }): AsrModel[] {
    const library = store.library ? scanLibrary(store.library) : []
    const manual = store.models.filter((model) => !library.some((item) => item.path === model.path))
    return [...library, ...manual]
  }

  private write(store: { selectedId: string | null; library: string | null; models: AsrModel[] }): void {
    writeAtomic(path.join(this.home, FILE), `${JSON.stringify({ version: 1, ...store }, null, 2)}\n`)
  }
}
