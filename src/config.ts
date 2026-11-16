import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Local calendar day key, matching notta's `yyyy-MM-dd` folder names. */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface MeetingConfig {
  /** Explicit log root; null means auto-detect. */
  lifelogRoot: string | null
  /** Plugin-owned data directory: minutes JSON/Markdown + selection state. */
  home: string
  /** IANA time zone used to turn notta's UTC timestamps into local clock time. */
  timeZone: string
  /** Chart window (minutes of day). */
  windowStart: number
  windowEnd: number
  /** Optional explicit model route for AI minutes; otherwise the Host default is used. */
  provider: string | null
  model: string | null
}

export function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

function resolveTimeZone(value: unknown): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  if (typeof value !== 'string' || !value.trim()) return fallback
  const candidate = value.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date())
    return candidate
  } catch {
    return fallback
  }
}

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): MeetingConfig {
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const dshHome = (env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  const homeInput = typeof config.home === 'string' && config.home.trim()
    ? config.home.trim()
    : (env.MEETING_MINUTES_HOME || '').trim()
  const rootInput = typeof config.lifelogRoot === 'string' && config.lifelogRoot.trim()
    ? config.lifelogRoot.trim()
    : (env.MEETING_MINUTES_LIFELOG || '').trim()
  return {
    lifelogRoot: rootInput ? path.resolve(expandHome(rootInput)) : null,
    home: homeInput ? path.resolve(expandHome(homeInput)) : path.join(dshHome, 'meeting-memo'),
    timeZone: resolveTimeZone(config.timeZone),
    // 一天就是 00:00–24:00：跨零点后数据才不会落进窗口之前
    windowStart: 0,
    windowEnd: 24 * 60,
    provider: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : null,
    model: typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null,
  }
}

/** Candidate log roots, in priority order. The default mirrors notta-input's own defaults. */
export function lifelogCandidates(config: MeetingConfig): string[] {
  if (config.lifelogRoot) return [config.lifelogRoot]
  const home = os.homedir()
  return [
    path.join(home, 'Downloads', 'notta'),
    path.join(home, 'Documents', 'notta生活日志'),
    path.join(home, 'Documents', 'notta'),
  ]
}

export function listDayDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => DAY_RE.test(name))
      .filter((name) => {
        try {
          return statSync(path.join(root, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

export interface DetectedRoot {
  root: string | null
  /** The log root that actually has the newest day folder. */
  latestDay: string | null
  dayCount: number
  inspected: { root: string; exists: boolean; dayCount: number; latestDay: string | null }[]
}

/** Prefer an explicit root; otherwise the candidate holding the newest day. */
export function detectLifelogRoot(config: MeetingConfig): DetectedRoot {
  const inspected = lifelogCandidates(config).map((root) => {
    if (!existsSync(root)) return { root, exists: false, dayCount: 0, latestDay: null }
    const days = listDayDirs(root)
    return { root, exists: true, dayCount: days.length, latestDay: days[days.length - 1] ?? null }
  })
  const usable = inspected.filter((entry) => entry.exists && entry.dayCount > 0)
  if (config.lifelogRoot) {
    const explicit = inspected[0]
    return {
      root: explicit.exists ? explicit.root : explicit.root,
      latestDay: explicit.latestDay,
      dayCount: explicit.dayCount,
      inspected,
    }
  }
  const best = usable.sort((a, b) => {
    const byDay = String(b.latestDay || '').localeCompare(String(a.latestDay || ''))
    if (byDay !== 0) return byDay
    return b.dayCount - a.dayCount
  })[0]
  return {
    root: best?.root ?? null,
    latestDay: best?.latestDay ?? null,
    dayCount: best?.dayCount ?? 0,
    inspected,
  }
}
