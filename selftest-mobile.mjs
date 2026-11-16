#!/usr/bin/env node
/**
 * 移动端页面自测：不用手机，直接 curl。
 *
 *   node scripts/check-plugin-mobile.mjs                    # 默认 http://127.0.0.1:56283
 *   node scripts/check-plugin-mobile.mjs --base http://127.0.0.1:3091
 *
 * 只验页面本身：token 由 App 签发，插件侧只校验格式，所以这里用一个
 * 格式合法的占位串就够了。返回非 0 表示有问题。
 */
import assert from 'node:assert/strict'

const args = process.argv.slice(2)
const baseArg = args[args.indexOf('--base') + 1]
const BASE = (args.includes('--base') && baseArg ? baseArg : process.env.DSH_BASE || 'http://127.0.0.1:56283')
  .replace(/\/$/, '')
const PATH = '/dsh-meeting-memo/mobile'
const TOKEN = 'A'.repeat(32)

async function get(path) {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: 'text/html' } })
  return { status: response.status, body: await response.text() }
}

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push(['✓', name, ''])
  } catch (error) {
    checks.push(['✗', name, error instanceof Error ? error.message : String(error)])
  }
}

const missing = await get(PATH)
check('缺 token 返回 401', () => assert.equal(missing.status, 401))

const page = await get(`${PATH}?mt=${TOKEN}`)
check('带 token 返回 200', () => assert.equal(page.status, 200))
check('是 HTML', () => assert.match(page.body, /^<!doctype html>/i))
check('标题是「会议纪要」', () => assert.match(page.body, /<h1>会议纪要<\/h1>/))
check('注入了 window.__MT__', () => assert.ok(page.body.includes('window.__MT__')))
check('没有「读取失败」', () => assert.ok(!page.body.includes('读取失败')))
check('样式已内联', () => assert.ok(page.body.includes('.stat') && page.body.includes('prefers-color-scheme')))
check('页面没有 fetch RPC', () => assert.ok(!/fetch\(/.test(page.body)))

for (const [mark, name, detail] of checks) console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
const failed = checks.filter(([mark]) => mark === '✗').length
console.log(`\n${checks.length} 项：${checks.length - failed} 通过，${failed} 失败  (${BASE}${PATH})`)
process.exit(failed ? 1 : 0)
