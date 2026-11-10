import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildPrompt, renderBackgrounds } from '../src/ai.ts'
import {
  deleteBackground,
  readBackgroundSelection,
  readBackgrounds,
  upsertBackground,
  writeBackgroundSelection,
} from '../src/backgrounds.ts'
import { resolveConfig } from '../src/config.ts'
import { readDoc } from '../src/minutes.ts'
import { MeetingService } from '../src/service.ts'
import type { LlmRuntimeLike } from '../src/service.ts'

const DAY = '2026-11-10'

test('background cards support create, edit, tag normalization and delete', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-bg-'))
  try {
    const created = upsertBackground(home, {
      title: '本体平台项目',
      tags: 'alpha, beta，alpha',
      content: '  这是背景正文  ',
    })
    assert.equal(created.item.title, '本体平台项目')
    assert.deepEqual(created.item.tags, ['alpha', 'beta'])
    assert.equal(created.item.content, '这是背景正文')

    const updated = upsertBackground(home, {
      id: created.item.id,
      title: '本体平台项目（更新）',
      tags: ['alpha'],
      content: '新正文',
    })
    assert.equal(updated.items.length, 1)
    assert.equal(updated.item.id, created.item.id)
    assert.equal(updated.item.title, '本体平台项目（更新）')
    assert.deepEqual(updated.item.tags, ['alpha'])
    assert.equal(readBackgrounds(home)[0].content, '新正文')

    writeBackgroundSelection(home, [created.item.id, 'missing'])
    assert.deepEqual(readBackgroundSelection(home), [created.item.id, 'missing'])

    const removed = deleteBackground(home, created.item.id)
    assert.deepEqual(removed.items, [])
    assert.deepEqual(removed.selection, [])
    assert.deepEqual(readBackgrounds(home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('selected backgrounds are rendered into the prompt without crowding it', () => {
  const prompt = buildPrompt({
    day: DAY,
    range: { start: 540, end: 560 },
    transcript: '[09:00:00] 麦克风：过一下权限设计。',
    truncated: false,
    backgrounds: [
      { title: '本体平台', tags: ['项目', '权限'], content: '平台里「行为」是可编排的动作单元。' },
      { title: '空卡片', content: '' },
    ],
  })
  assert.match(prompt.user, /背景资料/)
  assert.match(prompt.user, /本体平台/)
  assert.match(prompt.user, /行为/)
  assert.match(prompt.system, /不要照抄/)
  assert.equal(renderBackgrounds([]), '')
  assert.equal(renderBackgrounds([{ title: 'x', content: 'y'.repeat(5000) }]).length <= 6100, true)
})

test('generation attaches the selected cards and records them on the entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-bg-log-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-bg-home-'))
  try {
    mkdirSync(path.join(root, DAY), { recursive: true })
    const utc = new Date(Date.UTC(2026, 10, 10, 1, 0, 0)) // 09:00 Asia/Shanghai
    writeFileSync(path.join(root, DAY, 'snippets.jsonl'), JSON.stringify({
      day: DAY,
      id: 's1',
      startAt: utc.toISOString(),
      endAt: new Date(utc.getTime() + 20_000).toISOString(),
      track: 'mic',
      text: '这里讨论本体平台的行为权限。',
    }), 'utf8')
    const card = upsertBackground(home, {
      title: '本体平台',
      tags: ['项目'],
      content: '行为是可编排的动作单元，权限分可执行/可编辑。',
    }).item

    let captured = ''
    const llm: LlmRuntimeLike = {
      async *stream(options) {
        const messages = Array.isArray(options.messages) ? options.messages as Array<Record<string, unknown>> : []
        const content = Array.isArray(messages[0]?.content) ? messages[0].content as Array<Record<string, unknown>> : []
        captured = String(content[0]?.text ?? '')
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            meetings: [{ start: '09:00', end: '09:10', topic: '行为权限', summary: '确认权限边界。', points: ['行为是可编排单元'], todos: [] }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => [{ id: 'fake' }],
      listModels: async () => [{ id: 'fake' }],
      currentSelection: () => ({ provider: 'fake', model: 'fake' }),
    }
    const config = resolveConfig({ home, lifelogRoot: root })
    config.provider = 'fake'
    config.model = 'fake'
    const service = new MeetingService(config)
    service.attachLlm(llm)

    const result = await service.generateMinutes(DAY, '09:00', '09:10', undefined, [card.id])
    assert.match(captured, /本体平台/)
    assert.match(captured, /行为是可编排的动作单元/)
    assert.deepEqual(result.sessions[0].backgrounds, ['本体平台'])
    assert.deepEqual(readDoc(home, DAY).sessions[0].backgrounds, ['本体平台'])
    const markdown = readFileSync(path.join(home, 'minutes', `${DAY}.md`), 'utf8')
    assert.match(markdown, /参考背景.*本体平台/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
