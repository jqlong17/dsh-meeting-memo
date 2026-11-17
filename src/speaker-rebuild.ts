/**
 * 用已登记的声纹把某天的转写整体重判一遍。
 *
 * 和实时识别用同一套算法（192 维声纹 + 质心余弦 + 领先第二名一定差距），
 * 区别只是数据来源：实时是边转边判，这里是回头把当天所有带声纹的行重算。
 *
 * 为什么需要它：早期片段是在「还没有实时识别」或「麦克风换了」的时候录的，
 * 只有重算才能用上后来补的标注。
 */
import { matchSpeaker, type CentroidSet, type Vector } from './speaker-live.ts'
import type { SpeakerLabel } from './speaker-labels.ts'

export interface RebuildRow {
  /** snippets.jsonl 的行号（1 起）。 */
  line: number
  track: string
  /** 麦克风设备名；system 轨为空。 */
  input?: string
  emb?: string
}

export interface RebuildResult {
  /** 行号 → 分配 */
  map: Record<string, { speaker: string; name?: string; track: string; score?: number; source: 'live' | 'batch' }>
  /** 参与判定的行（有声纹的）。 */
  total: number
  /** 成功归到某个人的行。 */
  matched: number
  /** 每个人的命中条数。 */
  names: Record<string, number>
}

/** 解析 snippets.jsonl 文本，只留重算需要的字段。 */
export function parseRows(text: string): RebuildRow[] {
  const rows: RebuildRow[] = []
  let index = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    index += 1
    let row: { track?: unknown; input?: unknown; emb?: unknown }
    try {
      row = JSON.parse(raw) as { track?: unknown; input?: unknown; emb?: unknown }
    } catch {
      continue
    }
    rows.push({
      line: index,
      track: typeof row.track === 'string' ? row.track : 'mic',
      ...(typeof row.input === 'string' && row.input ? { input: row.input } : {}),
      ...(typeof row.emb === 'string' && row.emb ? { emb: row.emb } : {}),
    })
  }
  return rows
}

export interface RebuildInput {
  rows: RebuildRow[]
  /** 按「轨道|设备」预建好的质心；麦克风按设备分开，系统轨不分设备。 */
  centroidSets: Map<string, CentroidSet>
  /** 把 base64 声纹解成向量。 */
  decode: (base64: string) => Vector | null
  threshold?: number
  margin?: number
}

/**
 * 逐行判定。没声纹、或没匹配上的行**不写入 map**——
 * 调用方据此把旧的错误归属删掉，而不是留着。
 */
export function rebuildAssignments(input: RebuildInput): RebuildResult {
  const map: RebuildResult['map'] = {}
  const names: Record<string, number> = {}
  let total = 0
  let matched = 0

  for (const row of input.rows) {
    if (!row.emb) continue
    total += 1
    const vector = input.decode(row.emb)
    if (!vector) continue
    const key = row.track === 'system' ? 'system|' : `${row.track}|${row.input ?? ''}`
    const set = input.centroidSets.get(key)
    if (!set || !set.centroids.size) continue
    const hit = matchSpeaker(vector, set, input.threshold, input.margin)
    if (!hit) continue
    matched += 1
    names[hit.name] = (names[hit.name] ?? 0) + 1
    map[String(row.line)] = {
      speaker: 'rebuild',
      name: hit.name,
      track: row.track,
      score: Math.round(hit.score * 1000) / 1000,
      source: 'live',
    }
  }
  return { map, total, matched, names }
}

/** 质心集的键必须和 rebuildAssignments 取键的方式一致。 */
export function centroidKey(track: string, device?: string): string {
  return track === 'system' ? 'system|' : `${track}|${device ?? ''}`
}

/** 这一天里出现过哪些「轨道|设备」组合，用来决定要建几套质心。 */
export function neededScopes(rows: RebuildRow[]): Array<{ track: string; device?: string }> {
  const seen = new Map<string, { track: string; device?: string }>()
  for (const row of rows) {
    if (!row.emb) continue
    const key = centroidKey(row.track, row.input)
    if (!seen.has(key)) seen.set(key, { track: row.track, ...(row.input ? { device: row.input } : {}) })
  }
  return [...seen.values()]
}

/** 标签里这个人的样本数（给面板显示「登记够不够」）。 */
export function labelSampleCount(labels: SpeakerLabel[]): number {
  return labels.reduce((sum, label) => sum + (label.lines?.length ?? 0), 0)
}
