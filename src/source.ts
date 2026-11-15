/**
 * Which life-log root the Today view reads. Null means auto-detect.
 * The plugin ASR log is one of the choices; it is never written into notta's folder.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { lifelogCandidates, listDayDirs, type MeetingConfig } from './config.ts'
import { asrLogRoot } from './asr-log.ts'

export interface SourceOption {
  id: string
  label: string
  root: string
  exists: boolean
  dayCount: number
  active: boolean
}

function fileOf(home: string): string {
  return path.join(home, 'source.json')
}

export function readSelectedRoot(home: string): string | null {
  const file = fileOf(home)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { root?: unknown }
    return typeof parsed.root === 'string' && parsed.root.trim() ? path.resolve(parsed.root) : null
  } catch {
    return null
  }
}

export function writeSelectedRoot(home: string, root: string | null): void {
  mkdirSync(home, { recursive: true })
  const file = fileOf(home)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, root }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function listSources(config: MeetingConfig, activeRoot: string | null): SourceOption[] {
  const selected = readSelectedRoot(config.home)
  const candidates = [
    { id: 'asr', label: '本插件转写', root: asrLogRoot(config.home) },
    ...lifelogCandidates({ ...config, lifelogRoot: null }).map((root, index) => ({
      id: `notta-${index}`,
      label: sourceLabel(root),
      root,
    })),
  ]
  if (selected && !candidates.some((item) => item.root === selected)) {
    candidates.push({ id: 'custom', label: '自定义', root: selected })
  }
  return candidates.flatMap((item) => {
    const exists = existsSync(item.root)
    if (item.id !== 'asr' && !exists) return []
    const days = exists ? listDayDirs(item.root) : []
    return [{
      ...item,
      exists,
      dayCount: days.length,
      active: activeRoot === item.root,
    }]
  })
}

function sourceLabel(root: string): string {
  const name = path.basename(root) || root
  const parent = path.basename(path.dirname(root))
  if (!parent || parent === name) return name
  return `${parent}/${name}`
}
