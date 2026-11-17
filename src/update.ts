/**
 * 插件自更新：查 npm 最新版本，必要时用 dsh CLI 升级 profile 里的依赖。
 *
 * 两条硬约束：
 *   1. 开发模式（依赖写成 link:）不做任何更新动作，否则会把自己换成 npm 版。
 *   2. 升级只改 profile 的依赖并提示重启，不擅自重启 DSH —— 重启会中断正在进行的录音和会话。
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
