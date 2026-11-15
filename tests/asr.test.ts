import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { audioHealthOf, audioNeedsRestart } from '../src/audio-health.ts'
import { AsrModelRegistry, probeModel, scanLibrary } from '../src/asr-models.ts'
import { applyMeasured, parseFootprint, trimMemory } from '../src/memory-sample.ts'
import { appendActivity, appendSnippet, asrLogRoot } from '../src/asr-log.ts'
import { readDay } from '../src/lifelog.ts'
import { readSelectedRoot, writeSelectedRoot } from '../src/source.ts'

test('digital silence is told apart from a dead input tap', () => {
  const loud = { micBuffers: 12, systemBuffers: 4, micPeak: 0.2, systemPeak: 0.1 }
  assert.equal(audioHealthOf([loud], true).mic, 'ok')
  assert.equal(audioNeedsRestart(audioHealthOf([loud], true)), false)

  // Buffers keep arriving but carry no signal: a muted or detached device.
  const zeros = { micBuffers: 12, systemBuffers: 0, micPeak: 0, systemPeak: 0 }
  const silent = audioHealthOf([zeros, zeros, zeros], false)
  assert.equal(silent.mic, 'silent')
  assert.equal(silent.system, 'off')
  assert.equal(silent.silentMinutes, 3)
  assert.equal(audioNeedsRestart(silent), true)
  assert.equal(audioNeedsRestart(silent, 5), false)

  // No frames at all is a dead tap and reconnects immediately.
  const dead = audioHealthOf([{ micBuffers: 0, systemBuffers: 0, micPeak: 0, systemPeak: 0 }], false)
  assert.equal(dead.mic, 'dead')
  assert.equal(audioNeedsRestart(dead), true)

  // Rows written before this field existed must not look dead.
  assert.equal(audioHealthOf([{ micSpeechSeconds: 0 }], true).mic, 'off')
})

test('probe accepts the ContextDay Core ML layout and rejects a random directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-model-'))
  try {
    assert.equal(probeModel(dir).ok, false)
    mkdirSync(path.join(dir, 'SenseVoiceSmall_int8.mlmodelc'))
    mkdirSync(path.join(dir, 'SenseVoicePreprocessor.mlmodelc'))
    writeFileSync(path.join(dir, 'vocab.json'), JSON.stringify(['<blank>', '你']))
    const probe = probeModel(dir)
    assert.equal(probe.ok, true)
    assert.equal(probe.kind, 'coreml-sensevoice')
    assert.equal(probe.vocab, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('footprint output splits the model map from capture buffers', () => {
  const text = `
    7296 KB        0 B       960 KB         10    Malloc Small
    6528 KB        0 B          0 B         16    IOSurface
     538 MB        0 B          0 B       3954    App-Specific Tag 14
       0 B     451 MB          0 B         12    mapped file
    phys_footprint: 20 MB
  `
  const parts = parseFootprint(text, 474 * 1024 * 1024)
  assert.ok(parts.mapped > 400 * 1024 * 1024)
  assert.ok(parts.model > 500 * 1024 * 1024)
  assert.ok(parts.audio > 6 * 1024 * 1024)
  assert.equal(parts.footprint, 20 * 1024 * 1024)
  const measured = 1144 * 1024 * 1024
  const held = applyMeasured(parts, measured)
  assert.equal(held.occupied, measured)
  assert.equal(applyMeasured(parts, 0).occupied, parts.footprint)
  assert.equal(applyMeasured({ ...parts, footprint: 1200 * 1024 * 1024 }, measured).occupied, 1200 * 1024 * 1024)
  const now = Date.parse('2026-11-11T00:01:05.000Z')
  const kept = trimMemory([
    { at: '2026-11-11T00:00:00.000Z', ...parts },
    { at: '2026-11-11T00:00:30.000Z', ...parts },
  ], now)
  assert.equal(kept.length, 1)
})

test('a model library is tagged by capability instead of treated as one ASR model', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mm-lib-'))
  try {
    const asr = path.join(root, 'sensevoice-small')
    mkdirSync(asr)
    writeFileSync(path.join(asr, 'model.onnx'), '')
    writeFileSync(path.join(asr, 'tokens.txt'), 'a')
    writeFileSync(path.join(asr, 'config.yaml'), 'sensevoice')
    const boxes = path.join(root, 'screenparser')
    mkdirSync(boxes)
    writeFileSync(path.join(boxes, 'best.pt'), '')
    const found = scanLibrary(root)
    const sense = found.find((model) => model.name === 'sensevoice-small')
    const detect = found.find((model) => model.name === 'screenparser')
    assert.equal(sense?.capabilities.includes('asr'), true)
    assert.equal(sense?.usable, true)
    assert.match(sense?.summary ?? '', /可以用来录音/)
    assert.equal(detect?.capabilities.includes('detect'), true)
    assert.match(detect?.summary ?? '', /文本框/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adding a model selects it, and the ASR log is readable by the today view', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mm-asr-'))
  const model = mkdtempSync(path.join(os.tmpdir(), 'mm-coreml-'))
  try {
    mkdirSync(path.join(model, 'SenseVoiceSmall_int8.mlmodelc'))
    mkdirSync(path.join(model, 'SenseVoicePreprocessor.mlmodelc'))
    writeFileSync(path.join(model, 'vocab.json'), JSON.stringify(['a']))
    const registry = new AsrModelRegistry(home)
    const added = registry.add(model, 'SenseVoice')
    assert.equal(registry.selected()?.id, added.id)
    assert.equal(registry.list().models.some((item) => item.id === added.id), true)

    const root = asrLogRoot(home)
    appendSnippet(root, {
      day: '2026-11-10',
      startAt: '2026-11-10T10:23:15.000Z',
      endAt: '2026-11-10T10:23:18.000Z',
      track: 'mic',
      text: '刚才说了一句话',
    })
    appendActivity(root, {
      day: '2026-11-10',
      startAt: '2026-11-10T10:23:00.000Z',
      micSpeechSeconds: 2.4,
      snippetCount: 1,
    })
    const data = readDay(root, '2026-11-10', 'Asia/Shanghai')
    assert.equal(data.segments.length, 1)
    assert.equal(data.segments[0].text, '刚才说了一句话')
    assert.ok(data.buckets.some((bucket) => bucket.s > 0))

    writeSelectedRoot(home, root)
    assert.equal(readSelectedRoot(home), root)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(model, { recursive: true, force: true })
  }
})
