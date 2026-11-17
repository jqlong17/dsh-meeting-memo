/**
 * 声纹旁挂存储。
 *
 * 一条声纹是 192 维 float16 → 384 字节，编码成 base64 是 512 字符。
 * 以前直接塞在 snippets.jsonl 的每一行里，结果「文本日志」里 68% 是声纹，
 * 既不便于 grep，也让文件大了三倍。
 *
 * 现在按行号对齐存到同目录的 emb.jsonl：
 *   {"line":12,"emb":"<base64>"}
 * 正文文件保持干净，读的时候按行号把声纹合回来。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function embFile(dir: string): string {
  return path.join(dir, 'emb.jsonl')
}

/** 记一行声纹；line 与 snippets.jsonl 的行号一致（1 起）。 */
export function appendEmb(dir: string, line: number, emb: string): void {
  appendFileSync(embFile(dir), `${JSON.stringify({ line, emb })}\n`, 'utf8')
}

/** 读出当天的「行号 → 声纹」。文件不存在就是空的。 */
export function readEmbMap(dir: string): Map<number, string> {
  const map = new Map<number, string>()
  const file = embFile(dir)
  if (!existsSync(file)) return map
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return map
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const row = JSON.parse(raw) as { line?: number; emb?: string }
      if (typeof row.line === 'number' && typeof row.emb === 'string' && row.emb) map.set(row.line, row.emb)
    } catch {
      // 坏行跳过
    }
  }
  return map
}

/** 数一下正文有多少行，用来给新声纹编号。 */
export function countSnippetLines(file: string): number {
  if (!existsSync(file)) return 0
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length
  } catch {
    return 0
  }
}

export interface MigrateResult {
  day: string
  rows: number
  moved: number
  beforeBytes: number
  afterBytes: number
  embBytes: number
}

/**
 * 把旧的「声纹写在正文里」迁移成旁挂文件。
 * 幂等：已经是新格式（行里没有 emb）时什么也不做。
 */
export function migrateDay(dir: string, day: string, { backup = true }: { backup?: boolean } = {}): MigrateResult {
  const file = path.join(dir, 'snippets.jsonl')
  const result: MigrateResult = { day, rows: 0, moved: 0, beforeBytes: 0, afterBytes: 0, embBytes: 0 }
  if (!existsSync(file)) return result
  const before = readFileSync(file, 'utf8')
  result.beforeBytes = Buffer.byteLength(before)
  const lines = before.split('\n')
  const kept: string[] = []
  const moved: Array<{ line: number; emb: string }> = []
  let index = 0
  for (const raw of lines) {
    if (!raw.trim()) continue
    index += 1
    let row: Record<string, unknown>
    try {
      row = JSON.parse(raw) as Record<string, unknown>
    } catch {
      kept.push(raw)
      continue
    }
    const emb = typeof row.emb === 'string' ? row.emb : ''
    if (emb) {
      moved.push({ line: index, emb })
      delete row.emb
      result.moved += 1
    }
    kept.push(JSON.stringify(row))
  }
  result.rows = index
  if (!moved.length) {
    result.afterBytes = result.beforeBytes
    return result
  }
  if (backup) writeFileSync(`${file}.premigrate`, before, 'utf8')
  // 先写声纹，再写正文：中途崩了也不会丢声纹
  const embText = moved.map((row) => `${JSON.stringify(row)}\n`).join('')
  appendFileSync(embFile(dir), embText, 'utf8')
  result.embBytes = Buffer.byteLength(embText)
  writeFileSync(file, `${kept.join('\n')}\n`, 'utf8')
  result.afterBytes = Buffer.byteLength(`${kept.join('\n')}\n`)
  return result
}
