/**
 * 回归：rpc.ts 里漏 import 时 esbuild 不会报错，只有真调用才炸
 * （线上就出现过 `parseRows is not defined`）。
 * 这里直接跑一次路由处理器，确保 speaker.rebuild 这条链路是通的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { encodeVector } from '../src/speaker-live.ts'
import { MeetingService } from '../src/service.ts'
import { registerMeetingRoutes } from '../src/rpc.ts'

const DAY = '2026-11-17'
const VECTOR = Float32Array.from([1, 0, 0, 0])

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-rpc-'))
  const dayDir = path.join(home, 'asr-log', DAY)
  mkdirSync(dayDir, { recursive: true })
  const emb = encodeVector(VECTOR)
  const rows = [
    { day: DAY, startAt: `${DAY}T01:00:00.000Z`, endAt: `${DAY}T01:00:05.000Z`, track: 'mic', text: '第一句', source: 'asr', emb, input: 'builtin' },
    { day: DAY, startAt: `${DAY}T01:01:00.000Z`, endAt: `${DAY}T01:01:05.000Z`, track: 'mic', text: '第二句', source: 'asr', emb, input: 'builtin' },
  ]
  writeFileSync(path.join(dayDir, 'snippets.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(path.join(home, 'source.json'), JSON.stringify({ version: 1, root: path.join(home, 'asr-log') }))
  writeFileSync(path.join(home, 'speaker-labels.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'spk-1',
      day: DAY,
      start: 60,
      end: 62,
      label: '苏晴',
      lines: [1, 2],
      createdAt: `${DAY}T02:00:00.000Z`,
    }],
  }))
  return home
}

async function callRoute(home: string, op: string, payload: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null
  const ctx = {
    webServer: { register: (spec: { handler: typeof handler }) => { handler = spec.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    effect: (fn: () => unknown) => fn(),
  }
  const config = {
    lifelogRoot: null,
    home,
    timeZone: 'Asia/Shanghai',
    autoUpdate: false,
    windowStart: 0,
    windowEnd: 1440,
    provider: null,
    model: null,
  }
  const service = new MeetingService(config as never, home)
  registerMeetingRoutes(ctx as never, service)

  const body = JSON.stringify({ op, payload })
  const req = {
    url: '/dsh-mm/rpc',
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  let text = ''
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk?: string) => { text = String(chunk ?? '') },
  }
  assert.ok(handler, '路由处理器没注册')
  await handler(req as never, res as never)
  return JSON.parse(text) as { ok: boolean; value?: unknown; error?: { message?: string } }
}

test('speaker.rebuild 通过真实路由跑通（防漏 import）', async () => {
  const home = makeHome()
  try {
    const result = await callRoute(home, 'speaker.rebuild', { day: DAY })
    assert.equal(result.ok, true, `调用失败：${result.error?.message ?? ''}`)
    const value = result.value as { matched: number; withEmbedding: number; names: Record<string, number> }
    assert.equal(value.withEmbedding, 2)
    assert.equal(value.matched, 2)
    assert.equal(value.names['苏晴'], 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
