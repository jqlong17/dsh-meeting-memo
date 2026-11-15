import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MinutesJobStore } from '../src/jobs.ts'

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mm-jobs-'))
}

function cancelled(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'CANCELLED' })
}

test('start returns before the model finishes and a reload still sees the job', async () => {
  const dir = home()
  try {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const store = new MinutesJobStore(dir, async () => {
      await gate
      return { added: 1, topic: '权限', model: 'fake/fake', elapsedMs: 12 }
    })
    const started = store.start({ day: '2026-11-10', start: 600, end: 660, backgroundIds: ['bg-1'] })
    assert.equal(started.status, 'running')
    assert.equal(store.start({ day: '2026-11-10', start: 600, end: 660 }).id, started.id)

    const raw = JSON.parse(readFileSync(path.join(dir, 'jobs.json'), 'utf8')) as { jobs: Array<{ status: string }> }
    assert.equal(raw.jobs[0].status, 'running')

    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const done = store.get(started.id)
    assert.equal(done?.status, 'done')
    assert.equal(done?.added, 1)
    assert.equal(done?.topic, '权限')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('queued and running jobs can be cancelled, freeing the slot', async () => {
  const dir = home()
  try {
    const store = new MinutesJobStore(dir, async (_job, signal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(cancelled())
          return
        }
        signal.addEventListener('abort', () => reject(cancelled()), { once: true })
      })
      return { added: 1 }
    })
    const first = store.start({ day: '2026-11-10', start: 600, end: 620 })
    const second = store.start({ day: '2026-11-10', start: 700, end: 720 })
    const third = store.start({ day: '2026-11-10', start: 800, end: 820 })
    assert.equal(store.get(first.id)?.status, 'running')
    assert.equal(store.get(second.id)?.status, 'running')
    assert.equal(store.get(third.id)?.status, 'queued')

    assert.equal(store.cancel(third.id).status, 'cancelled')
    assert.equal(store.cancel(first.id).status, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(store.get(first.id)?.status, 'cancelled')
    assert.equal(store.get(second.id)?.status, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Host restart marks in-flight jobs interrupted instead of leaving them running', () => {
  const dir = home()
  try {
    writeFileSync(path.join(dir, 'jobs.json'), `${JSON.stringify({
      version: 1,
      jobs: [{
        id: 'job-old',
        day: '2026-11-10',
        start: 600,
        end: 660,
        backgroundIds: [],
        status: 'running',
        createdAt: '2026-11-10T10:00:00.000Z',
        startedAt: '2026-11-10T10:00:01.000Z',
      }],
    })}\n`, 'utf8')
    const store = new MinutesJobStore(dir, async () => ({ added: 1 }))
    const job = store.get('job-old')
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error?.code, 'INTERRUPTED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
