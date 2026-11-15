/**
 * 转写碎片的清理规则。
 *
 * 本地 ASR 在没声音或只有噪声时会吐出两类垃圾：只剩标点的片段（`.`、`。`），
 * 以及一两个字到几个字母的空词（`The.`、`爱成飞。`）。这类内容并进正文只会让
 * 转写更乱，所以：
 *
 * 1. 只剩标点的 → 丢
 * 2. 纯拉丁字母的短词（没有中日韩字）→ 丢
 * 3. 少于 5 个字的碎片 → 并进相邻同轨的**像样片段**；周围没有像样片段时直接丢
 *
 * 原始 snippets.jsonl 不改，只在读取时整理。合并后的片段保留所有原始行号，
 * 复制索引仍然能把每一行指出来。
 */

/** 去掉标点、符号和空白之后还剩几个字。 */
export function meaningfulLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}

/** 只剩标点或空白的片段。 */
export function isNoiseText(text: string): boolean {
  return meaningfulLength(text) === 0
}

/** 是否含有中日韩文字或假名。 */
export function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

/** `The.`、`Okay.` 这类没有中日韩字的短英文词，多半是噪声。 */
export function isLatinNoise(text: string): boolean {
  const chars = meaningfulLength(text)
  return chars > 0 && chars <= 6 && !hasCjk(text)
}

export interface CleanableSegment {
  s: number
  e: number
  track: string
  text: string
  line?: number
  lines?: number[]
  source?: string
}

/** 少于这个字数的片段算碎片。 */
const SHORT_CHARS = 5
/** 合并目标至少要这么长，才值得把碎片挂上去。 */
const SOLID_CHARS = 8
/** 相隔超过这个分钟数就不再合并，避免把两句话粘在一起。 */
const MERGE_GAP_MINUTES = 1

export interface CleanResult<T extends CleanableSegment> {
  segments: T[]
  dropped: number
  merged: number
}

function linesOf(segment: CleanableSegment): number[] {
  if (segment.lines?.length) return segment.lines
  return typeof segment.line === 'number' ? [segment.line] : []
}

function absorb(target: CleanableSegment, source: CleanableSegment, prepend: boolean): void {
  target.text = prepend ? `${source.text}${target.text}` : `${target.text}${source.text}`
  target.s = Math.min(target.s, source.s)
  target.e = Math.max(target.e, source.e)
  target.lines = [...new Set([...linesOf(target), ...linesOf(source)])].sort((a, b) => a - b)
}

function canJoin(a: CleanableSegment, b: CleanableSegment): boolean {
  return a.track === b.track && b.s - a.e <= MERGE_GAP_MINUTES
}

/**
 * 丢掉噪声与孤立碎片，把剩下的短碎片并进相邻的像样片段。
 * 输入应当已按时间排序。
 */
export function cleanSegments<T extends CleanableSegment>(input: T[]): CleanResult<T> {
  let dropped = 0
  let merged = 0

  const filtered = input.filter((segment) => {
    if (isNoiseText(segment.text)) {
      dropped += 1
      return false
    }
    if (isLatinNoise(segment.text)) {
      dropped += 1
      return false
    }
    return true
  })

  const output: T[] = []
  for (let index = 0; index < filtered.length; index += 1) {
    const current = { ...filtered[index], lines: linesOf(filtered[index]) } as T
    const short = meaningfulLength(current.text) < SHORT_CHARS
    if (!short) {
      output.push(current)
      continue
    }
    const previous = output[output.length - 1]
    if (previous && canJoin(previous, current) && meaningfulLength(previous.text) >= SOLID_CHARS) {
      absorb(previous, current, false)
      merged += 1
      continue
    }
    const next = filtered[index + 1]
    if (next && canJoin(current, next) && meaningfulLength(next.text) >= SOLID_CHARS) {
      absorb(filtered[index + 1], current, true)
      merged += 1
      continue
    }
    // 周围没有值得挂靠的片段，这种碎片留着只会干扰阅读。
    dropped += 1
  }

  return { segments: output, dropped, merged }
}
