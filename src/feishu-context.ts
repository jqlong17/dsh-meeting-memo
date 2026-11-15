/**
 * Pull Feishu docs and spreadsheets named in a meeting's extra notes, so the
 * minutes model can use them as context. Read-only. A failed link is reported,
 * not fatal.
 */
import { spawn } from 'node:child_process'

const URL_RE = /https?:\/\/[^\s)）]+/g
const FEISHU_RE = /feishu\.cn|larksuite\.com|larkoffice\.com/

export function feishuUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  return [...new Set(found.map((url) => url.replace(/[.,，。]+$/, '')).filter((url) => FEISHU_RE.test(url)))].slice(0, 4)
}

function run(args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('读取飞书超时'))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim().slice(-300) || out.trim().slice(-300) || `lark-cli 退出 ${code}`))
    })
  })
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}

async function fetchDoc(url: string): Promise<string> {
  const raw = await run(['docs', '+fetch', '--as', 'user', '--doc', url, '--doc-format', 'markdown', '--format', 'json'])
  const parsed = JSON.parse(raw) as { ok?: boolean; data?: { document?: { content?: string } }; error?: { message?: string } }
  if (parsed.ok === false) throw new Error(parsed.error?.message || '文档读取失败')
  return parsed.data?.document?.content || raw
}

async function fetchSheet(url: string): Promise<string> {
  const infoRaw = await run(['sheets', '+workbook-info', '--as', 'user', '--url', url, '--format', 'json'])
  const info = JSON.parse(infoRaw) as { data?: { title?: string; sheets?: Array<{ sheet_id?: string; sheet_name?: string }> } }
  const title = info.data?.title || url
  const sheets = (info.data?.sheets ?? []).slice(0, 4)
  const parts = [`# ${title}`]
  for (const sheet of sheets) {
    if (!sheet.sheet_id) continue
    const csvRaw = await run([
      'sheets', '+csv-get', '--as', 'user', '--url', url,
      '--sheet-id', sheet.sheet_id, '--range', 'A1:T40', '--max-chars', '12000', '--format', 'json',
    ])
    const csv = JSON.parse(csvRaw) as { data?: { csv?: string; content?: string } }
    const body = csv.data?.csv || csv.data?.content || csvRaw
    parts.push(`## ${sheet.sheet_name || sheet.sheet_id}\n${clip(body, 4000)}`)
  }
  return parts.join('\n\n')
}

export async function fetchFeishuNotes(text: string): Promise<string> {
  const urls = feishuUrls(text)
  if (!urls.length) return ''
  const blocks: string[] = []
  for (const url of urls) {
    try {
      const doc = await fetchDoc(url)
      blocks.push(`来源 ${url}\n${clip(doc, 6000)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/sheet|spreadsheet|表格/i.test(message)) {
        blocks.push(`来源 ${url}\n未能读取：${message}`)
        continue
      }
      try {
        blocks.push(`来源 ${url}\n${clip(await fetchSheet(url), 8000)}`)
      } catch (sheetError) {
        const detail = sheetError instanceof Error ? sheetError.message : String(sheetError)
        blocks.push(`来源 ${url}\n未能读取：${detail}`)
      }
    }
  }
  return blocks.join('\n\n')
}
