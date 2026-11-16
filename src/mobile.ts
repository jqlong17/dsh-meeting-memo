/**
 * DSH Pocket iOS「插件」面板里的页面。
 *
 * 两条路径，都在 MOBILE_CHANNEL 前缀下：
 *   POST <MOBILE_CHANNEL>/token   换 token（走 DSH 认证，App 带 cookie）
 *   GET  <MOBILE_CHANNEL>?mt=xxx  页面
 *
 * 两条硬规则（来自 dsh-plugin-panel 的接入文档）：
 *   1. token 只验格式，不自建 token 表——App 在每个插件之间共用同一个 token。
 *   2. 页面数据服务端直出，页面里不 fetch 自己的 RPC——WebView 没有 cookie。
 *
 * 模板和样式放在 resources/mobile/，每次请求重读，改文案不用重载插件。
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

import type { MeetingService } from './service.ts'
import { formatClock } from './lifelog.ts'

/** 必须和 package.json 的 dsh.mobile.path 完全一致。 */
export const MOBILE_CHANNEL = '/dsh-meeting-memo/mobile'

/** App 统一签发 32 位 base64url，插件只验格式。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

/** 打包后 __dirname 是 lib/，资源在 ../resources/mobile/。 */
const ASSET_DIR = new URL('../resources/mobile/', import.meta.url)

function asset(name: string): string {
  return readFileSync(new URL(name, ASSET_DIR), 'utf8')
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function mintToken(): string {
  // 只要 32 位 base64url，App 不校验来源。
  return randomBytes(24).toString('base64url').slice(0, 32)
}

/** 纪要正文是 Markdown，手机上只取开头几行做摘要。 */
function summarize(markdown: string, max = 120): string {
  const plain = markdown
    .split('\n')
    .map((line) => line.replace(/^>\s?/, '').replace(/^[-*]\s+/, '').trim())
    // 标题行和 💡 那行只是结构，摘要里读起来是噪音
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('💡'))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

interface MobileItem {
  day: string
  when: string
  topic: string
  summary: string
}

function renderStats(stats: { captureMinutes: number; speechMinutes: number; segments: number }): string {
  const cell = (value: string, label: string): string =>
    `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`
  return `<section class="stats">${
    cell(String(Math.round(stats.captureMinutes)), '今天已采集')
  }${cell(String(Math.round(stats.speechMinutes)), '语音分钟')
  }${cell(String(stats.segments), '转写片段')}</section>`
}

function renderItems(items: MobileItem[]): string {
  if (!items.length) {
    return `<p class="empty"><strong>还没有纪要</strong>在 DSH 桌面端的「会议纪要」里选一段时间，生成之后这里就能看。</p>`
  }
  const groups = new Map<string, MobileItem[]>()
  for (const item of items) {
    const list = groups.get(item.day) ?? []
    list.push(item)
    groups.set(item.day, list)
  }
  const parts: string[] = []
  for (const [day, list] of groups) {
    parts.push(`<h2 class="day">${escapeHtml(day)}</h2>`)
    for (const item of list) {
      parts.push(
        `<article class="item"><h3><span class="when">${escapeHtml(item.when)}</span>${escapeHtml(item.topic)}</h3>`
        + (item.summary ? `<p>${escapeHtml(item.summary)}</p>` : '')
        + '</article>',
      )
    }
  }
  return parts.join('\n')
}

function renderPage(body: string, token: string): string {
  const page = asset('page.html')
  const style = asset('style.css')
  return page
    .replaceAll('{{TITLE}}', '会议纪要')
    .replaceAll('{{HINT}}', '本机录音与本地转写')
    .replaceAll('{{STYLE}}', style)
    .replaceAll('{{BODY}}', body)
    .replaceAll('{{TOKEN}}', JSON.stringify(token))
}

/** 最近几天的纪要，新的在前；没有纪要的日期直接跳过。 */
function collectItems(service: MeetingService, days: string[], limitDays = 6, limitSessions = 12): MobileItem[] {
  const items: MobileItem[] = []
  let filledDays = 0
  for (const day of days) {
    if (filledDays >= limitDays || items.length >= limitSessions) break
    let sessions: Array<{ start: number; end: number; topic: string; content: string }> = []
    try {
      sessions = service.minutesForDay(day).sessions
    } catch {
      continue
    }
    if (!sessions.length) continue
    for (const session of sessions) {
      if (items.length >= limitSessions) break
      items.push({
        day,
        when: `${formatClock(session.start)}–${formatClock(session.end)}`,
        topic: session.topic,
        summary: summarize(session.content ?? ''),
      })
    }
    filledDays += 1
  }
  return items
}

/**
 * 注册移动端路由。
 * @returns 取消注册的函数；宿主没有 webServer 时返回空操作。
 */
export function registerMobile(ctx: Context, service: MeetingService): () => void {
  const webServer = (ctx as unknown as { webServer?: { register?: (spec: unknown) => () => void } }).webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  return webServer.register({
    kind: 'prefix',
    path: MOBILE_CHANNEL,
    handler: async (req: { method?: string; url?: string }, res: {
      writeHead: (status: number, headers: Record<string, string>) => void
      end: (body?: string) => void
    }) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const send = (status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      }
      const connection = (ctx as unknown as {
        connection?: { requestRejection?: (req: unknown) => number | undefined }
      }).connection

      // ① 换 token：这条要过 DSH 认证，App 的 URLSession 带 cookie
      if (url.pathname === `${MOBILE_CHANNEL}/token`) {
        if (req.method !== 'POST') return send(405, 'method not allowed')
        const rejection = connection?.requestRejection?.(req)
        if (rejection !== undefined) return send(rejection, 'unauthorized')
        return send(200, JSON.stringify({ token: mintToken(), expiresIn: 300 }), 'application/json; charset=utf-8')
      }

      // ② 页面：只验格式
      const token = url.searchParams.get('mt') ?? ''
      if (!TOKEN_RE.test(token)) return send(401, '请从 DSH Pocket App 内打开')

      if (url.pathname !== MOBILE_CHANNEL) return send(404, 'not found')

      let body: string
      try {
        const payload = service.dayPayload(undefined)
        const recent = collectItems(service, [...payload.days].reverse())
        body = `${renderStats(payload.stats)}<h2 class="group">最近纪要</h2>${renderItems(recent)}`
      } catch (error) {
        // 数据读不出来也要让人看懂发生了什么，而不是白屏。
        const message = error instanceof Error ? error.message : String(error)
        body = `<p class="empty"><strong>读取失败</strong>${escapeHtml(message)}<br>在桌面端确认「转写服务」和纪要文件都正常。</p>`
      }
      return send(200, renderPage(body, token), 'text/html; charset=utf-8')
    },
  })
}
