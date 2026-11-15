import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDay, hourlySummary, sliceRange } from '../src/lifelog.ts'
import { renderMarkdown, readDoc, writeDoc } from '../src/minutes.ts'
import { clipText, hasSwitchMarker, parseMeetings } from '../src/ai.ts'
import { buildIndexCopy, compressLineRanges } from '../src/copy-index.ts'
import { parseFootprint } from '../src/memory-sample.ts'

function dayFixture(rows: { activity: string[]; snippets: string[] }): { root: string; day: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-test-'))
  const day = '2026-11-10'
  mkdirSync(path.join(root, day), { recursive: true })
  writeFileSync(path.join(root, day, 'activity.jsonl'), `${rows.activity.join('\n')}\n`, 'utf8')
  writeFileSync(path.join(root, day, 'snippets.jsonl'), `${rows.snippets.join('\n')}\n`, 'utf8')
  return { root, day, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const activity = (iso: string, speech: number, chars: number): string => JSON.stringify({
  day: '2026-11-10',
  startAt: iso,
  endAt: iso,
  micSpeechSeconds: speech,
  systemSpeechSeconds: 0,
  meetingSpeechSeconds: 0,
  micChars: chars,
  systemChars: 0,
  meetingChars: 0,
  snippetCount: 1,
})

const snippet = (start: string, end: string, text: string, track = 'mic'): string => JSON.stringify({
  day: '2026-11-10',
  id: String(Math.random()),
  startAt: start,
  endAt: end,
  track,
  text,
})

test('readDay maps UTC instants into local minutes of the day', () => {
  const fixture = dayFixture({
    activity: [
      activity('2026-11-09T16:24:00Z', 60, 20), // 00:24 Asia/Shanghai
      activity('2026-11-09T23:59:00Z', 30, 10), // 07:59
      activity('2026-11-10T16:00:00Z', 12, 5), // next local day — ignored
    ],
    snippets: [
      snippet('2026-11-10T01:00:00Z', '2026-11-10T01:00:30Z', '今天先过一下插件面板', 'mic'),
      snippet('2026-11-10T01:01:00Z', '2026-11-10T01:01:20Z', '时间轴用组件实现', 'system'),
    ],
  })
  try {
    const data = readDay(fixture.root, fixture.day, 'Asia/Shanghai')
    assert.equal(data.buckets.length, 4)
    const seven = data.buckets.find((bucket) => bucket.m === 7 * 60 + 59)
    assert.ok(seven)
    assert.equal(seven.s, 30)
    assert.equal(data.segments.length, 2)
    assert.equal(data.segments[0].line, 1)
    assert.equal(data.segments[1].line, 2)
    assert.equal(data.segments[0].track, 'mic')
    assert.equal(data.segments[1].track, 'system')
    assert.ok(Math.abs(data.segments[0].s - 9 * 60) < 0.01)
    const hourly = hourlySummary(data, 6, 24)
    assert.equal(hourly.find((row) => row.hour === 9)?.segments, 2)
    assert.equal(hourly.find((row) => row.hour === 7)?.speechMinutes, 0.5)
  } finally {
    fixture.cleanup()
  }
})

test('sliceRange clips to the requested clock window', () => {
  const fixture = dayFixture({
    activity: [activity('2026-11-10T01:00:00Z', 30, 6)],
    snippets: [
      snippet('2026-11-10T01:00:00Z', '2026-11-10T01:00:30Z', '九点整的转写'),
      snippet('2026-11-10T01:10:00Z', '2026-11-10T01:10:30Z', '九点十分的转写'),
    ],
  })
  try {
    const data = readDay(fixture.root, fixture.day, 'Asia/Shanghai')
    const slice = sliceRange(data, 8 * 60 + 59, 9 * 60 + 5)
    assert.equal(slice.segments.length, 1)
    assert.match(slice.text, /九点整的转写/)
    assert.equal(hourlySummary(data, 6, 24).find((row) => row.hour === 9)?.chars >= 12, true)
  } finally {
    fixture.cleanup()
  }
})

test('AI reply parsing keeps one meeting unless the transcript switches', () => {
  const reply = '```json\n' + JSON.stringify({
    meetings: [{
      start: '09:00',
      end: '09:20',
      topic: '可执行与可编辑权限',
      content: '> 💡 **本场背景与目标**\n> 确认行为测试里的权限边界。\n\n### 核心结论\n- 可执行与可编辑是两套权限\n- 新建行为时也要判断可执行\n\n### TODO\n- [ ] 补一个只读角色的用例',
    }],
  }) + '\n```'
  const one = parseMeetings(reply, { start: 540, end: 560 }, false)
  assert.equal(one.length, 1)
  assert.equal(one[0].start, 540)
  assert.equal(one[0].end, 560)
  assert.match(one[0].content, /补一个只读角色的用例/)

  const splitReply = JSON.stringify({
    meetings: [
      { start: '09:00', end: '09:10', topic: '权限', content: '> 权限边界' },
      { start: '09:10', end: '09:20', topic: '测试', content: '> 补用例' },
    ],
  })
  const merged = parseMeetings(splitReply, { start: 540, end: 560 }, false)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].topic, '权限')
  assert.match(merged[0].content, /权限边界/)
  assert.match(merged[0].content, /补用例/)

  const split = parseMeetings(splitReply, { start: 540, end: 560 }, true)
  assert.equal(split.length, 2)
  assert.equal(hasSwitchMarker('今天先到这，下一个议题是排期'), true)
  assert.equal(hasSwitchMarker('我们看一下这个权限'), false)
})

test('transcript clipping keeps both ends', () => {
  const text = 'A'.repeat(1000) + 'B'.repeat(1000)
  const clipped = clipText(text, 400)
  assert.equal(clipped.truncated, true)
  assert.ok(clipped.text.startsWith('A'))
  assert.ok(clipped.text.endsWith('B'))
  assert.ok(clipped.text.includes('中间省略'))
  assert.equal(clipText('short', 400).truncated, false)
})

test('minutes round-trip to JSON and Markdown', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-home-'))
  try {
    const stored = writeDoc(home, '2026-11-10', {
      day: '2026-11-10',
      title: '11-10 会议纪要',
      note: '测试',
      updatedAt: '',
      sessions: [{
        id: 's1',
        start: 540,
        end: 560,
        topic: '插件面板',
        content: '> 确认时间轴与转写联动。\n\n### 核心结论\n- 时间轴用组件实现\n- 选区默认两小时\n\n### TODO\n- [ ] 补暗色模式截图',
        source: 'agent',
        updatedAt: '',
      }],
    }, 'Asia/Shanghai')
    assert.equal(stored.doc.sessions.length, 1)
    const md = renderMarkdown(stored.doc, 'Asia/Shanghai')
    assert.match(md, /## 09:00–09:20 · 插件面板/)
    assert.match(md, /- \[ \] 补暗色模式截图/)
    const read = readDoc(home, '2026-11-10')
    assert.equal(read.sessions[0].topic, '插件面板')
    assert.match(read.sessions[0].content, /补暗色模式截图/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('copy index points at the exact snippets.jsonl lines', () => {
  assert.equal(compressLineRanges([12, 3, 4, 4, 6, 7, 8, 20]), '3-4, 6-8, 12, 20')
  const text = buildIndexCopy({
    day: '2026-11-10',
    file: '/Users/me/Documents/notta生活日志/2026-11-10/snippets.jsonl',
    segments: [
      { s: 1103.25, e: 1103.7, line: 1203 },
      { s: 1104, e: 1105.5, line: 1204 },
      { s: 1120, e: 1121, line: 1210 },
    ],
    selection: { start: 1060, end: 1132 },
    trackLabel: '全部',
    filtered: false,
  })
  assert.match(text, /文件: \/Users\/me\/Documents\/notta生活日志\/2026-11-10\/snippets.jsonl/)
  assert.match(text, /要读的行: 1203-1204, 1210/)
  assert.match(text, /选区: 2026-11-10 17:40:00 – 18:52:00/)
  assert.match(text, /这些行实际覆盖: 2026-11-10 18:23:15 – 18:41:00/)
  assert.match(text, /片段数: 3/)

  const filtered = buildIndexCopy({
    day: '2026-11-10',
    file: '/tmp/snippets.jsonl',
    segments: [{ s: 600, e: 601, line: 7 }],
    selection: { start: 600, end: 700 },
    trackLabel: '麦克风',
    filtered: true,
  })
  assert.match(filtered, /轨道筛选: 麦克风（行号只含该轨道）/)
  assert.match(filtered, /背景资料: 无/)
  const withBackground = buildIndexCopy({
    day: '2026-11-10',
    file: '/tmp/snippets.jsonl',
    segments: [{ s: 600, e: 601, line: 7 }],
    selection: { start: 600, end: 700 },
    trackLabel: '全部',
    filtered: false,
    backgrounds: [{ title: '本体产研交流背景', tags: ['本体'], content: '近端：龙嘉奇' }],
  })
  assert.match(withBackground, /### 本体产研交流背景（标签：本体）/)
  assert.match(withBackground, /近端：龙嘉奇/)
})

test('footprint parsing skips the TOTAL row so buckets do not double count', () => {
  const text = [
    '    1000 KB        0 B          0 B          3    Malloc Small',
    '    2000 KB        0 B          0 B          1    Untagged',
    '       0 B      512 KB          0 B          1    mapped file',
    '    phys_footprint: 3 MB',
    '       3 MB     512 KB        64 KB    TOTAL',
  ].join('\n')
  const parts = parseFootprint(text, 0)
  assert.equal(parts.heap, 1000 * 1024)
  assert.equal(parts.fixed, 2000 * 1024)
  assert.equal(parts.mapped, 512 * 1024)
  assert.equal(parts.footprint, 3 * 1024 * 1024)
})
