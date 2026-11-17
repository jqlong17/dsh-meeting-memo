import assert from 'node:assert/strict'
import test from 'node:test'

import { DEMO_DATA, demoResponse, isDemoOp, isDemoWrite, setDemoActive } from '../src/client/demo.ts'

// 演示模式默认关闭；测试里显式打开，验证的是「开启后」的行为
setDemoActive(true)

test('夹具日期和规模稳定', () => {
  assert.equal(DEMO_DATA.day.day, '2026-11-17')
  assert.ok(DEMO_DATA.day.segments.length >= 30, `四场会应有 30 条以上转写，实际 ${DEMO_DATA.day.segments.length}`)
  assert.ok(DEMO_DATA.day.stats.speechMinutes > 0)
  assert.ok(DEMO_DATA.day.buckets.length > 0)
})

test('转写覆盖四种形态：有名字、未识别、系统轨、麦克风轨', () => {
  const segs = DEMO_DATA.day.segments
  assert.ok(segs.some((s) => s.speaker && s.speakerScore !== undefined))
  // 全部是虚构数据：既不能出现真实同事姓名，也不能出现真实业务词汇
  const dump = JSON.stringify(DEMO_DATA)
  for (const forbidden of [
    '张思齐', '肖晓东', '龙嘉奇', '龙佳奇',
    '本体', '客座率', '合同评审', '航信', '中航信', '文档解析', '数据治理',
  ]) {
    assert.ok(!dump.includes(forbidden), `夹具里不能出现真实数据痕迹：${forbidden}`)
  }
  assert.ok(segs.some((s) => !s.speaker))
  assert.ok(segs.some((s) => s.track === 'system'))
  assert.ok(segs.some((s) => s.track === 'mic'))
})

test('六个页面需要的读操作都返回夹具', () => {
  const reads = [
    'day',
    'minutes.list',
    'minutes.range',
    'minutes.index',
    'backgrounds.list',
    'jobs.list',
    'asr.status',
    'asr.models',
    'speaker.list',
    'speaker.assignments',
    'skills.list',
    'update.check',
  ]
  for (const op of reads) {
    const result = demoResponse(op, {})
    assert.ok(result, `${op} 应该有夹具`)
    assert.equal(result.ok, true, `${op} 应该成功`)
  }
})

test('写操作在演示模式下被拦成空实现', () => {
  const writes = [
    'minutes.upsert',
    'minutes.delete',
    'minutes.clear',
    'minutes.generate',
    'jobs.start',
    'jobs.cancel',
    'jobs.clear',
    'speaker.add',
    'speaker.delete',
    'speaker.enrollRecent',
    'asr.set',
    'models.select',
    'update.apply',
  ]
  for (const op of writes) {
    assert.ok(isDemoWrite(op), `${op} 应判定为写操作`)
    const result = demoResponse(op, {})
    assert.ok(result, `${op} 应被拦截`)
    assert.equal(result.ok, true)
  }
})

test('未列出的操作返回 null，交给真实 RPC', () => {
  assert.equal(demoResponse('unknown.op', {}), null)
  assert.equal(demoResponse('system.reveal', {}), null)
  assert.equal(isDemoOp('unknown.op'), false)
})

test('纪要范围有两场、背景有两张、任务有进行中', () => {
  const range = demoResponse('minutes.range', { mode: 'week' })
  assert.ok(range && range.ok)
  const total = (range.value as { total: number }).total
  assert.ok(total >= 2)

  const backgrounds = demoResponse('backgrounds.list', {})
  assert.ok(backgrounds && backgrounds.ok)
  assert.ok((backgrounds.value as { items: unknown[] }).items.length >= 2)

  const jobs = demoResponse('jobs.list', {})
  assert.ok(jobs && jobs.ok)
  const list = (jobs.value as { jobs: Array<{ status: string }> }).jobs
  assert.ok(list.some((job) => job.status === 'running' || job.status === 'done'))
})
