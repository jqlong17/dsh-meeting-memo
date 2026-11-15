/**
 * Group a macOS `footprint` summary into the few buckets that explain the
 * ASR process: the mapped model file versus capture buffers versus fixed cost.
 */

export interface MemoryParts {
  /** Resident set. Includes file cache, so it looks larger than the charge. */
  rss: number
  /** phys_footprint: what the kernel actually charges. */
  footprint: number
  /**
   * What the panel calls 实际占用. Live charge, plus external-model weights
   * when they are not already inside `footprint` (the ONNX process is short-lived).
   */
  occupied: number
  /** Weights copied into a private inference heap. Zero when the model is only mapped. */
  model: number
  /** Clean mapped model file. Not part of the charge. */
  mapped: number
  /** ScreenCaptureKit / audio IOSurface buffers. */
  audio: number
  /** Malloc heap used by the helper itself. */
  heap: number
  /** dyld, stacks, page tables. */
  fixed: number
}

export interface MemorySample extends MemoryParts {
  at: string
}

const KB = 1024
const MB = 1024 * 1024

function parseSize(raw: string): number {
  const match = /^([\d.]+)\s*(KB|MB|GB|B)?$/i.exec(raw.trim())
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  const unit = (match[2] || 'B').toUpperCase()
  if (unit === 'GB') return value * 1024 * MB
  if (unit === 'MB') return value * MB
  if (unit === 'KB') return value * KB
  return value
}

function isModelArena(name: string): boolean {
  return /App-Specific Tag|Neural Engine|IOAccelerator|CoreML|ANE|GPU|Metal/i.test(name)
}

export function parseFootprint(text: string, rss = 0): MemoryParts {
  let mapped = 0
  let model = 0
  let audio = 0
  let heap = 0
  let dirtyOther = 0
  let footprint = 0
  for (const line of text.split('\n')) {
    const foot = /phys_footprint:\s*([\d.]+\s*(?:KB|MB|GB|B))/i.exec(line)
    if (foot) footprint = parseSize(foot[1])
    const row = /^\s*([\d.]+\s*(?:KB|MB|GB|B))\s+([\d.]+\s*(?:KB|MB|GB|B))\s+([\d.]+\s*(?:KB|MB|GB|B))\s+\d+\s+(.+)$/.exec(line)
    if (!row) continue
    const dirty = parseSize(row[1])
    const clean = parseSize(row[2])
    const name = row[4].trim()
    // 汇总行（TOTAL）已经体现在 phys_footprint 里，再计入分类就会翻倍。
    if (/^TOTAL$/i.test(name)) continue
    if (name === 'mapped file') {
      mapped += dirty + clean
      model += dirty
      continue
    }
    if (/^IOSurface/.test(name)) {
      audio += dirty
      continue
    }
    if (/^Malloc/.test(name)) {
      heap += dirty
      continue
    }
    if (isModelArena(name)) {
      model += dirty
      continue
    }
    dirtyOther += dirty
  }
  return {
    rss,
    footprint,
    occupied: footprint,
    model,
    mapped,
    audio,
    heap,
    fixed: dirtyOther,
  }
}

/** Keep the last real footprint reading when the loader process has already exited. */
export function applyMeasured(parts: MemoryParts, measured: number): MemoryParts {
  const occupied = Math.max(parts.footprint, measured > 0 ? measured : 0)
  return {
    ...parts,
    occupied,
    model: parts.model + Math.max(0, occupied - parts.footprint),
  }
}

/** Add another process's charged model memory, without mixing in its file map. */
export function addChargedModel(base: MemoryParts, extra: MemoryParts): MemoryParts {
  return {
    ...base,
    footprint: base.footprint + extra.footprint,
    model: base.model + extra.model + Math.max(0, extra.footprint - extra.model - extra.audio - extra.heap - extra.fixed),
    audio: base.audio + extra.audio,
    heap: base.heap + extra.heap,
    fixed: base.fixed + extra.fixed,
  }
}

export function trimMemory(samples: MemorySample[], now = Date.now(), windowMs = 60_000): MemorySample[] {
  return samples.filter((sample) => now - Date.parse(sample.at) <= windowMs).slice(-16)
}
