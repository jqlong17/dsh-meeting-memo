/**
 * 「某天某行是谁说的」的落库文件，面板和移动端都读它。
 *
 * 三种来源写这里：实时匹配（live）、批量分离（batch）、人工标签回填（label，置信度 1）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Assignment {
  speaker: string
  name?: string
  track: string
  score?: number
  source?: 'live' | 'batch' | 'label'
}

export type AssignmentDays = Record<string, Record<string, Assignment>>

const FILE = 'speaker-assignments.json'

function fileOf(home: string): string {
  return path.join(home, FILE)
}

export function readAssignments(home: string): AssignmentDays {
  try {
    const parsed = JSON.parse(readFileSync(fileOf(home), 'utf8')) as { days?: AssignmentDays }
    return parsed.days ?? {}
  } catch {
    return {}
  }
}

export function writeAssignments(home: string, days: AssignmentDays): void {
  mkdirSync(home, { recursive: true })
  const tmp = `${fileOf(home)}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, days }, null, 2)}\n`, 'utf8')
  renameSync(tmp, fileOf(home))
}

/** 给一天里的一行写分配，读-改-写，避免并发覆盖。 */
export function setAssignment(home: string, day: string, line: number | string, entry: Assignment): void {
  const days = readAssignments(home)
  const bucket = days[day] ?? {}
  bucket[String(line)] = entry
  days[day] = bucket
  writeAssignments(home, days)
}

export function hasAssignments(home: string): boolean {
  return existsSync(fileOf(home))
}
