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

/** 读当天的说话人分配（缺失时返回空）。 */
function readAssignments(home: string, day: string): Record<string, { speaker: string; name?: string }> {
  try {
    const file = new URL(`file://${home}/speaker-assignments.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      days?: Record<string, Record<string, { speaker: string; name?: string }>>
    }
    return parsed.days?.[day] ?? {}
  } catch {
    return {}
  }
}

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

/** 今日的密度时间轴，服务端直出，不依赖前端脚本。 */
function renderTimeline(buckets: Array<{ m: number; s: number }>, windowStart: number, windowEnd: number): string {
  const bin = 5
  const span = Math.max(bin, windowEnd - windowStart)
  const count = Math.ceil(span / bin)
  const sums = new Array<number>(count).fill(0)
  for (const bucket of buckets) {
    if (bucket.m < windowStart || bucket.m >= windowEnd) continue
    const index = Math.min(count - 1, Math.floor((bucket.m - windowStart) / bin))
    sums[index] += Math.max(0, bucket.s)
  }
  const width = 1000
  const height = 120
  const barWidth = width / count
  const bars = sums.map((seconds, index) => {
    const density = Math.min(1, seconds / (bin * 60))
    const h = Math.max(1, density * (height - 6))
    const x = index * barWidth
    return `<rect x="${x.toFixed(1)}" y="${(height - h).toFixed(1)}" width="${Math.max(0.8, barWidth - 0.8).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="#4176e6" opacity="${(0.25 + density * 0.7).toFixed(2)}"/>`
  }).join('')
  const ticks: string[] = []
  for (let minute = Math.ceil(windowStart / 180) * 180; minute <= windowEnd; minute += 180) {
    const x = ((minute - windowStart) / span) * width
    const label = `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`
    ticks.push(`<text x="${x.toFixed(1)}" y="${height + 14}" font-size="20" fill="#8e8e93" text-anchor="middle">${label}</text>`)
  }
  return `<div class="timeline"><svg viewBox="0 0 ${width} ${height + 20}" width="100%" height="110" preserveAspectRatio="none">${bars}${ticks.join('')}</svg></div>`
}

/** 倒序转写：最新的在最前，带时间、说话人和正文。 */
function renderTranscript(
  segments: Array<{ s: number; e: number; track: string; text: string; line?: number; lines?: number[] }>,
  assignments: Record<string, { speaker: string; name?: string }>,
  limit = 150,
): string {
  const rows = [...segments].reverse().slice(0, limit)
  if (!rows.length) return '<p class="empty">这段时间还没有转写。</p>'
  const html = rows.map((segment) => {
    const line = segment.line ?? segment.lines?.[0]
    const assigned = line ? assignments[String(line)] : undefined
    const speaker = assigned?.name ? assigned.name.split(/[（(]/)[0] : ''
    const track = segment.track === 'system' ? '系统' : segment.track === 'mic' ? '麦克风' : '合并'
    return `<article class="row">
  <div class="meta"><span class="time">${escapeHtml(formatClock(segment.s, true))}</span>`
      + `<span class="tag">${escapeHtml(track)}</span>`
      + (speaker ? `<span class="tag spk">${escapeHtml(speaker)}</span>` : '')
      + `</div>
  <p>${escapeHtml(segment.text)}</p>
</article>`
  }).join('\n')
  return html + (segments.length > limit ? `<p class="empty">只显示最近 ${limit} 条</p>` : '')
}

function renderPage(sections: { today: string; minutes: string }, token: string): string {
  const page = asset('page.html')
  const style = asset('style.css')
  return page
    .replaceAll('{{TITLE}}', '会议纪要')
    .replaceAll('{{HINT}}', '本机录音与本地转写')
    .replaceAll('{{STYLE}}', style)
    .replaceAll('{{TODAY}}', sections.today)
    .replaceAll('{{MINUTES}}', sections.minutes)
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

      let sections: { today: string; minutes: string }
      try {
        const payload = service.dayPayload(undefined)
        const assignments = readAssignments(service.config.home, payload.day)
        const recent = collectItems(service, [...payload.days].reverse())
        sections = {
          today: `${renderStats(payload.stats)}`
            + renderTimeline(payload.buckets, payload.window.start, payload.window.end)
            + `<h2 class="group">转写</h2>${renderTranscript(payload.segments, assignments)}`,
          minutes: `<h2 class="group">最近纪要</h2>${renderItems(recent)}`,
        }
      } catch (error) {
        // 数据读不出来也要让人看懂发生了什么，而不是白屏。
        const message = error instanceof Error ? error.message : String(error)
        const broken = `<p class="empty"><strong>读取失败</strong>${escapeHtml(message)}<br>在桌面端确认「转写服务」和纪要文件都正常。</p>`
        sections = { today: broken, minutes: broken }
      }
      return send(200, renderPage(sections, token), 'text/html; charset=utf-8')
    },
  })
}
