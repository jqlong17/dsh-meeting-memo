/**
 * 回归：rpc 里 `imports` 变量必须在 dispatch 作用域里。
 * 出过的事故：把它写进了 modelPayload，结果面板一点「离线导入」就报 `imports is not defined`。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MeetingService } from '../src/service.ts'
import { ImportService } from '../src/import-service.ts'
import { registerMeetingRoutes } from '../src/rpc.ts'

test('imports.list 通过真实路由可用', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-rpc-imp-'))
  try {
    const config = {
      lifelogRoot: null, home, timeZone: 'Asia/Shanghai', autoUpdate: false,
      windowStart: 0, windowEnd: 1440, provider: null, model: null,
    }
    const service = new MeetingService(config as never, home)
    const imports = new ImportService(service, '/nonexistent/asr-helper', () => '', () => 'zhen')
    let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null
    const ctx = {
      webServer: { register: (spec: { handler: typeof handler }) => { handler = spec.handler; return () => {} } },
      connection: { requestRejection: () => undefined },
      effect: (fn: () => unknown) => fn(),
    }
    registerMeetingRoutes(ctx as never, service, undefined, {
      models: { list: () => ({ selectedId: null, models: [] }) } as never,
      runtime: { status: () => ({ mode: 'tracks', language: 'zhen' }) } as never,
      imports,
    })
    const body = JSON.stringify({ op: 'imports.list', payload: {} })
    const req = { url: '/dsh-mm/rpc', method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
    let out = ''
    assert.ok(handler)
    await handler(req as never, { statusCode: 0, setHeader: () => {}, end: (chunk?: string) => { out = String(chunk ?? '') } } as never)
    const parsed = JSON.parse(out) as { ok: boolean; value?: { items: unknown[] }; error?: { message: string } }
    assert.equal(parsed.ok, true, `调用失败：${parsed.error?.message ?? ''}`)
    assert.deepEqual(parsed.value?.items, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
