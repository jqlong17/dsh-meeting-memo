import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { readDoc } from '../src/minutes.ts'
import { registerMeetingRoutes } from '../src/rpc.ts'
import { MeetingService } from '../src/service.ts'
import type { LlmRuntimeLike } from '../src/service.ts'

const DAY = '2026-11-10'

function snippet(localHour: number, localMinute: number, text: string): string {
  // Asia/Shanghai is UTC+8; schedule the UTC instant for the local clock.
  const utc = new Date(Date.UTC(2026, 10, 10, localHour - 8, localMinute, 0))
  return JSON.stringify({
    day: DAY,
    id: `${localHour}-${localMinute}`,
    startAt: utc.toISOString(),
    endAt: new Date(utc.getTime() + 20_000).toISOString(),
    track: 'mic',
    text,
  })
}

function fakeLlm(): LlmRuntimeLike {
  return {
    async *stream(options: Record<string, unknown>) {
      const messages = Array.isArray(options.messages) ? options.messages as Array<Record<string, unknown>> : []
      const content = Array.isArray(messages[0]?.content) ? messages[0].content as Array<Record<string, unknown>> : []
      const prompt = String(content[0]?.text ?? '')
      const range = /区间：(\d{2}:\d{2})–(\d{2}:\d{2})/.exec(prompt)
      const start = range?.[1] ?? '09:00'
      const end = range?.[2] ?? '09:20'
      const json = JSON.stringify({
        meetings: [{ start, end, topic: `会议 ${start}`, content: `> 并发写入测试 ${start}` }],
      })
      yield { type: 'text-delta', text: json }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'fake' }],
    listModels: async () => [{ id: 'fake' }],
    currentSelection: () => ({ provider: 'fake', model: 'fake' }),
  }
}

test('concurrent generations keep every finished range', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-concurrent-log-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-concurrent-home-'))
  try {
    mkdirSync(path.join(root, DAY), { recursive: true })
    writeFileSync(path.join(root, DAY, 'snippets.jsonl'), [
      snippet(7, 0, '早上第一个议题：确认权限模型。'),
      snippet(10, 0, '十点这一段讨论接口回显。'),
    ].join('\n'), 'utf8')

    const config = resolveConfig({ home, lifelogRoot: root })
    config.provider = 'fake'
    config.model = 'fake'
    const service = new MeetingService(config)
    service.attachLlm(fakeLlm())

    const [first, second] = await Promise.all([
      service.generateMinutes(DAY, '07:00', '07:10'),
      service.generateMinutes(DAY, '10:00', '10:10'),
    ])
    assert.equal(first.added, 1)
    assert.equal(second.added, 1)

    const doc = readDoc(home, DAY)
    assert.equal(doc.sessions.length, 2)
    assert.deepEqual(doc.sessions.map((session) => session.topic).sort(), ['会议 07:00', '会议 10:00'])
    assert.equal(doc.sessions.every((session) => session.source === 'ai'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('concurrent generations of the same range leave one entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-concurrent-log-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-concurrent-home-'))
  try {
    mkdirSync(path.join(root, DAY), { recursive: true })
    writeFileSync(path.join(root, DAY, 'snippets.jsonl'), snippet(9, 0, '同一段被重复提交，不应产生两条。'), 'utf8')
    const config = resolveConfig({ home, lifelogRoot: root })
    config.provider = 'fake'
    config.model = 'fake'
    const service = new MeetingService(config)
    service.attachLlm(fakeLlm())

    await Promise.all([
      service.generateMinutes(DAY, '09:00', '09:20'),
      service.generateMinutes(DAY, '09:00', '09:20'),
    ])
    const doc = readDoc(home, DAY)
    assert.equal(doc.sessions.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('the RPC route awaits async generation and returns the full payload', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-rpc-log-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-rpc-home-'))
  try {
    mkdirSync(path.join(root, DAY), { recursive: true })
    writeFileSync(path.join(root, DAY, 'snippets.jsonl'), snippet(8, 0, '八点这段用来验证 RPC 返回体。'), 'utf8')
    const config = resolveConfig({ home, lifelogRoot: root })
    config.provider = 'fake'
    config.model = 'fake'
    const service = new MeetingService(config)
    service.attachLlm(fakeLlm())

    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
    const ctx = {
      webServer: {
        register(route: { handler: (req: unknown, res: unknown) => Promise<void> }) {
          handler = route.handler
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
    }
    const dispose = registerMeetingRoutes(ctx as never, service)
    assert.ok(dispose)
    assert.ok(handler)

    const request = {
      method: 'POST',
      url: '/dsh-mm/rpc',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ op: 'minutes.generate', payload: { day: DAY, start: '08:00', end: '08:10' } }))
      },
    }
    let payload = ''
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => { finish = resolve })
    const response = {
      statusCode: 0,
      setHeader() {},
      end(chunk?: string) {
        payload += chunk ?? ''
        finish()
      },
    }
    const running = handler(request, response)
    await Promise.race([running, done])
    const body = JSON.parse(payload) as { ok: boolean; value: { added?: number; sessions?: unknown[] } }
    assert.equal(body.ok, true)
    assert.equal(body.value.added, 1)
    assert.equal(body.value.sessions?.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
