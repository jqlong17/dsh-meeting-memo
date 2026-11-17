/**
 * 插件自更新：查 npm 最新版本，必要时用 dsh CLI 升级 profile 里的依赖。
 *
 * 两条硬约束：
 *   1. 开发模式（依赖写成 link:）不做任何更新动作，否则会把自己换成 npm 版。
 *   2. 升级只改 profile 的依赖并提示重启，不擅自重启 DSH —— 重启会中断正在进行的录音和会话。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface UpdateStatus {
  /** link = 本地开发目录；npm = 装的包。 */
  mode: 'link' | 'npm' | 'unknown'
  current: string
  latest: string | null
  hasUpdate: boolean
  /** 最近一次成功的检查时间。 */
  checkedAt: string | null
  error?: string
  /** 升级用的命令，方便用户复制。 */
  command: string
}

const REGISTRY = 'https://registry.npmjs.org'
const TTL_MS = 6 * 60 * 60 * 1000

interface Cache {
  at: number
  latest: string | null
  error?: string
}

let cache: Cache | null = null

/** semver 比较：只看 主.次.修订，够用。 */
export function compareVersion(a: string, b: string): number {
  const parse = (value: string): number[] => value.replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 读 profile 里这个包的依赖写法：link: 是本地开发，其余按 npm 包处理。 */
export function readDependency(profileDir: string | undefined, name: string): { mode: 'link' | 'npm' | 'unknown'; spec: string | null } {
  if (!profileDir) return { mode: 'unknown', spec: null }
  try {
    const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const spec = pkg.dependencies?.[name] ?? null
    if (!spec) return { mode: 'unknown', spec: null }
    return { mode: spec.startsWith('link:') || spec.startsWith('file:') ? 'link' : 'npm', spec }
  } catch {
    return { mode: 'unknown', spec: null }
  }
}

async function fetchLatest(name: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4_000)
  try {
    const response = await fetch(`${REGISTRY}/${name}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function checkUpdate(input: {
  name: string
  current: string
  profileDir?: string
  profile?: string
  /** 强制跳过缓存。 */
  force?: boolean
}): Promise<UpdateStatus> {
  const dependency = readDependency(input.profileDir, input.name)
  const command = `dsh plugin --profile ${input.profile || '<profile>'} add ${input.name}@latest`
  const base: UpdateStatus = {
    mode: dependency.mode,
    current: input.current,
    latest: null,
    hasUpdate: false,
    checkedAt: null,
    command,
  }
  // 开发模式不联网：更新会把本地目录换成 npm 版
  if (dependency.mode === 'link') return base

  if (!input.force && cache && Date.now() - cache.at < TTL_MS) {
    return {
      ...base,
      latest: cache.latest,
      hasUpdate: Boolean(cache.latest && compareVersion(cache.latest, input.current) > 0),
      checkedAt: new Date(cache.at).toISOString(),
      ...(cache.error ? { error: cache.error } : {}),
    }
  }

  const latest = await fetchLatest(input.name)
  cache = { at: Date.now(), latest, ...(latest ? {} : { error: '取不到 npm 上的版本' }) }
  return {
    ...base,
    latest,
    hasUpdate: Boolean(latest && compareVersion(latest, input.current) > 0),
    checkedAt: new Date(cache.at).toISOString(),
    ...(latest ? {} : { error: '取不到 npm 上的版本' }),
  }
}


/** 每天检查一次：状态落盘，重启后不会重复打扰，也不会漏掉一整天。 */
export interface UpdateState {
  /** 最近一次检查时间（ISO）。 */
  checkedAt?: string
  /** 最近一次自动升级完成的时间。 */
  appliedAt?: string
  /** 自动升级到的版本。 */
  appliedVersion?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function stateFile(home: string): string {
  return path.join(home, 'update-state.json')
}

export function readUpdateState(home: string): UpdateState {
  try {
    return JSON.parse(readFileSync(stateFile(home), 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

export function writeUpdateState(home: string, state: UpdateState): void {
  try {
    writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 写不进去只是会多查一次
  }
}

/** 距上次检查是否已满一天。 */
export function dueForCheck(state: UpdateState, now = Date.now(), intervalMs = DAY_MS): boolean {
  if (!state.checkedAt) return true
  const last = Date.parse(state.checkedAt)
  if (!Number.isFinite(last)) return true
  return now - last >= intervalMs
}

export interface TickResult {
  checked: boolean
  applied: boolean
  status: UpdateStatus
  state: UpdateState
}

/**
 * 每天跑一次：检查新版本，必要时自动升级。
 * 自动升级失败不影响使用，下一次检查会再试。
 */
export async function updateTick(input: {
  home: string
  name: string
  current: string
  profileDir?: string
  profile?: string
  autoUpdate: boolean
  now?: number
}): Promise<TickResult> {
  const now = input.now ?? Date.now()
  const state = readUpdateState(input.home)
  if (!dueForCheck(state, now)) {
    const status = await checkUpdate({
      name: input.name,
      current: input.current,
      profileDir: input.profileDir,
      profile: input.profile,
    })
    return { checked: false, applied: false, status, state }
  }

  const status = await checkUpdate({
    name: input.name,
    current: input.current,
    profileDir: input.profileDir,
    profile: input.profile,
    force: true,
  })
  const next: UpdateState = { ...state, checkedAt: new Date(now).toISOString() }

  let applied = false
  if (input.autoUpdate && status.hasUpdate && status.latest && status.mode === 'npm') {
    const result = await applyUpdate({ name: input.name, profile: input.profile, cwd: input.profileDir })
    if (result.ok) {
      applied = true
      next.appliedAt = new Date().toISOString()
      next.appliedVersion = status.latest
    }
  }
  writeUpdateState(input.home, next)
  return { checked: true, applied, status, state: next }
}

export interface ApplyResult {
  ok: boolean
  output: string
}

/** 真正升级：跑 dsh CLI，把 profile 里的依赖指到最新版。 */
export function applyUpdate(input: { name: string; profile?: string; cwd?: string }): Promise<ApplyResult> {
  const profile = input.profile || ''
  if (!profile) return Promise.resolve({ ok: false, output: '拿不到当前 profile，无法自动升级' })
  return new Promise((resolve) => {
    execFile('dsh', ['plugin', '--profile', profile, 'add', `${input.name}@latest`], {
      cwd: input.cwd,
      timeout: 180_000,
      env: process.env,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim().slice(-600)
      if (error) {
        resolve({ ok: false, output: output || String(error.message) })
        return
      }
      cache = null
      resolve({ ok: true, output })
    })
  })
}
