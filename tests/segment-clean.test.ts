import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanSegments, isLatinNoise, isNoiseText, meaningfulLength } from '../src/segment-clean.ts'

test('pure punctuation counts as noise', () => {
  for (const text of ['.', '。', '...', '、', '  ', '！？']) {
    assert.equal(isNoiseText(text), true, `${JSON.stringify(text)} 应当算噪声`)
  }
  assert.equal(isNoiseText('好。'), false)
  assert.equal(meaningfulLength('The.'), 3)
  assert.equal(isLatinNoise('The.'), true)
  assert.equal(isLatinNoise('Okay.'), true)
})

test('drops punctuation-only rows and keeps the rest in order', () => {
  const input = [
    { s: 10, e: 10.2, track: 'mic', text: '.', line: 1 },
    { s: 11, e: 11.5, track: 'mic', text: '今天对一下发布流程', line: 2 },
    { s: 12, e: 12.1, track: 'mic', text: '。', line: 3 },
    { s: 13, e: 13.4, track: 'mic', text: '先把版本号定下来', line: 4 },
  ]
  const { segments, dropped } = cleanSegments(input)
  assert.equal(dropped, 2)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map((s) => s.text), ['今天对一下发布流程', '先把版本号定下来'])
})

test('merges a short fragment into the previous segment', () => {
  const input = [
    { s: 10, e: 10.5, track: 'mic', text: '这段先按现有方案做', line: 1 },
    { s: 10.6, e: 10.9, track: 'mic', text: '好的', line: 2 },
  ]
  const { segments, merged } = cleanSegments(input)
  assert.equal(merged, 1)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].text, '这段先按现有方案做好的')
  assert.deepEqual(segments[0].lines, [1, 2])
})

test('merges a leading short fragment forward when there is no previous one', () => {
  const input = [
    { s: 10, e: 10.3, track: 'mic', text: '嗯。', line: 1 },
    { s: 10.4, e: 11, track: 'mic', text: '下周把模型下载链路补上', line: 2 },
  ]
  const { segments, merged } = cleanSegments(input)
  assert.equal(merged, 1)
  assert.equal(segments[0].text, '嗯。下周把模型下载链路补上')
  assert.deepEqual(segments[0].lines, [1, 2])
})

test('does not merge across tracks or across a long gap', () => {
  const input = [
    { s: 10, e: 10.5, track: 'mic', text: '先过一下今天的进展', line: 1 },
    { s: 10.6, e: 10.9, track: 'system', text: '好', line: 2 },
    { s: 30, e: 30.4, track: 'mic', text: '嗯', line: 3 },
  ]
  const { segments } = cleanSegments(input)
  // 跨轨与超时的不合并；两条短碎片因为找不到像样的邻居被丢掉。
  assert.equal(segments.length, 1)
  assert.equal(segments[0].text, '先过一下今天的进展')
})
