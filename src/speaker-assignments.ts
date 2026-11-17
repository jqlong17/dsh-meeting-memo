/**
 * 「某天某行是谁说的」的落库。
 *
 * 历史上是一个大文件 `speaker-assignments.json`：
 *   { version: 1, days: { "2026-11-17": { "1": {...} } } }
 * 一天 500 条、一天 50 KB，全部天挤在一个文件里——读一天要把整年历史读进内存，
 * 重算一天要重写整年，还会和 `speaker-labels.json` 的行号互相牵制。
 *
 * 现在按天拆开：
 *   speaker-assignments/index.json          {"version":2,"days":["2026-11-16", ...]}
 *   speaker-assignments/2026-11-17.json     {"version":1,"day":"...","map":{...}}
 *
 * 读取只碰当天那一个文件；写入只重写当天。旧的大文件仍然兼容读取（见 readDayAssignments），
 * 迁移脚本跑完后就不再依赖它。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Assignment {
  speaker: string
  name?: string
  track: string
  score?: number
  source?: 'live' | 'batch' | 'label'
}

export type AssignmentMap = Record<string, Assignment>
/** 兼容旧接口：日期 → 当天的分配表。 */
export type AssignmentDays = Record<string, AssignmentMap>

const LEGACY_FILE = 'speaker-assignments.json'
const DIR = 'speaker-assignments'
const INDEX = 'index.json'

function dirOf(home: string): string {
  return path.join(home, DIR)
}

function fileOf(home: string, day: string): string {
  return path.join(dirOf(home), `${day}.json`)
}

function legacyFile(home: string): string {
  return path.join(home, LEGACY_FILE)
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 旧大文件里某一天的分配，仅用于兼容；没有就返回 null（区别于「空表」）。 */
function readLegacyDay(home: string, day: string): AssignmentMap | null {
  const parsed = readJson<{ days?: AssignmentDays }>(legacyFile(home))
  const bucket = parsed?.days?.[day]
  return bucket ?? null
}

/**
 * 读一天的分配表。返回 null 表示「这天从来没有归属记录」——
 * 调用方据此区分「没判过」和「判过但一个人都没认出来」。
 */
export function readDayAssignments(home: string, day: string): AssignmentMap | null {
  const parsed = readJson<{ map?: AssignmentMap }>(fileOf(home, day))
  if (parsed?.map) return parsed.map
  return readLegacyDay(home, day)
}

/** 读一天，拿不到就给空表（大多数调用只关心内容）。 */
export function readDayMap(home: string, day: string): AssignmentMap {
  return readDayAssignments(home, day) ?? {}
}

/** 覆盖写一天；只动这一个文件。 */
export function writeDay(home: string, day: string, map: AssignmentMap): void {
  writeAtomic(fileOf(home, day), `${JSON.stringify({ version: 1, day, map }, null, 2)}\n`)
  touchIndex(home, day)
}

/** 给一行写分配：读当天、改一行、写回当天。 */
export function setAssignment(home: string, day: string, line: number | string, entry: Assignment): void {
  const map = readDayMap(home, day)
  map[String(line)] = entry
  writeDay(home, day, map)
}

/** 有哪些天有归属记录（索引 + 目录 + 旧文件一起算）。 */
export function listDays(home: string): string[] {
  const days = new Set<string>()
  const parsed = readJson<{ days?: string[] }>(path.join(dirOf(home), INDEX))
  for (const day of parsed?.days ?? []) days.add(day)
  try {
    for (const name of readdirSync(dirOf(home))) {
      if (name === INDEX || !name.endsWith('.json')) continue
      days.add(name.slice(0, -'.json'.length))
    }
  } catch {
    // 目录还不存在
  }
  const legacy = readJson<{ days?: AssignmentDays }>(legacyFile(home))
  for (const day of Object.keys(legacy?.days ?? {})) days.add(day)
  return [...days].sort()
}

/** 全量读出（只为兼容旧调用方，正式路径应该用 readDayMap）。 */
export function readAssignments(home: string): AssignmentDays {
  const days: AssignmentDays = {}
  for (const day of listDays(home)) {
    const map = readDayAssignments(home, day)
    if (map) days[day] = map
  }
  return days
}

export function hasAssignments(home: string): boolean {
  if (existsSync(legacyFile(home))) return true
  return listDays(home).length > 0
}

function touchIndex(home: string, day: string): void {
  const file = path.join(dirOf(home), INDEX)
  const parsed = readJson<{ days?: string[] }>(file)
  const days = new Set(parsed?.days ?? [])
  if (days.has(day)) return
  days.add(day)
  writeAtomic(file, `${JSON.stringify({ version: 2, days: [...days].sort() }, null, 2)}\n`)
}

export interface SplitResult {
  days: number
  entries: number
  backup: string | null
}

/**
 * 把旧大文件拆成按天文件。
 * 幂等：没有旧文件时返回 0。拆完把旧文件改名成 `.premigrate.json` 留底。
 */
export function splitLegacy(home: string): SplitResult {
  const file = legacyFile(home)
  const parsed = readJson<{ days?: AssignmentDays }>(file)
  if (!parsed?.days) return { days: 0, entries: 0, backup: null }
  let entries = 0
  let days = 0
  for (const [day, map] of Object.entries(parsed.days)) {
    const current = readJson<{ map?: AssignmentMap }>(fileOf(home, day))
    // 已经有按天文件的，以按天文件为准，不拿旧的覆盖
    if (current?.map) continue
    writeDay(home, day, map)
    entries += Object.keys(map).length
    days += 1
  }
  const backup = `${file}.premigrate`
  try {
    renameSync(file, backup)
  } catch {
    return { days, entries, backup: null }
  }
  return { days, entries, backup }
}

/** 删掉某一天的分配（用户清理某天时用）。 */
export function dropDay(home: string, day: string): void {
  const file = fileOf(home, day)
  if (existsSync(file)) unlinkSync(file)
  const indexFile = path.join(dirOf(home), INDEX)
  const parsed = readJson<{ days?: string[] }>(indexFile)
  if (!parsed?.days) return
  const rest = parsed.days.filter((item) => item !== day)
  if (rest.length === parsed.days.length) return
  writeAtomic(indexFile, `${JSON.stringify({ version: 2, days: rest }, null, 2)}\n`)
}
