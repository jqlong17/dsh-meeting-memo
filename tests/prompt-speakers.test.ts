/**
 * 回归：交给模型的转写必须带说话人。
 * 出过的问题：generateMinutes 忘了传 speakerOf，模型只看到「麦克风/系统」，
 * 生成出来的纪要用「产品负责人」这种模糊指代代替人名。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MeetingService } from '../src/service.ts'

const DAY = '2026-11-18'

function makeService(): { service: MeetingService; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-prompt-'))
  const dir = path.join(home, 'asr-log', DAY)
  mkdirSync(dir, { recursive: true })
  const rows = [
    { id: 'a', day: DAY, startAt: `${DAY}T01:35:00.000Z`, endAt: `${DAY}T01:35:05.000Z`, track: 'mic', text: '这个方案我弄完了我们先对一下吧', source: 'asr' },
    { id: 'b', day: DAY, startAt: `${DAY}T01:36:00.000Z`, endAt: `${DAY}T01:36:05.000Z`, track: 'mic', text: '代码量太大了应该跑不动的', source: 'asr' },
  ]
  writeFileSync(path.join(dir, 'snippets.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  mkdirSync(path.join(home, 'speaker-assignments'), { recursive: true })
  writeFileSync(path.join(home, 'speaker-assignments', `${DAY}.json`), JSON.stringify({
    version: 1,
    day: DAY,
    map: {
      '1': { speaker: 'live', name: '周剑杰', track: 'mic', score: 0.79, source: 'live' },
      '2': { speaker: 'live', name: '龙嘉奇', track: 'mic', score: 0.68, source: 'live' },
    },
  }))
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
  return { service: new MeetingService(config as never, home), home }
}

test('交给模型的转写带说话人名字和相似度', () => {
  const { service, home } = makeService()
  try {
    // 01:35 UTC = 09:35 本地
    const result = service.promptTranscript(DAY, 9 * 60 + 30, 9 * 60 + 40)
    assert.ok(result.segments >= 1, '应该取到片段')
    assert.match(result.text, /周剑杰\(0\.79\)/, `文本里应有名字：${result.text}`)
    assert.match(result.text, /龙嘉奇\(0\.68\)/)
    assert.doesNotMatch(result.text, /麦克风\//, '不该再出现「麦克风/名字」这种会被当成两个人的写法')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有归属时不伪造名字，只给轨道', () => {
  const { service, home } = makeService()
  try {
    rmSync(path.join(home, 'speaker-assignments'), { recursive: true, force: true })
    const result = service.promptTranscript(DAY, 9 * 60 + 30, 9 * 60 + 40)
    assert.doesNotMatch(result.text, /周剑杰|龙嘉奇/)
    // 没人名时用〔麦克风〕标轨道，方括号形式不会再被当成人名
    assert.match(result.text, /〔麦克风〕：/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
