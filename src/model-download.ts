/**
 * Download one catalog model into the single library directory.
 * Partial files stay under .downloads so a scan never treats them as models.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

import type { AsrModelRegistry } from './asr-models.ts'
import { MODEL_OFFERS, defaultDownloadRoot, type ModelOffer } from './model-catalog.ts'

export interface DownloadJob {
  id: string
  name: string
  status: 'running' | 'done' | 'failed'
  received: number
  total: number | null
  message: string
}

export class ModelDownloads {
  private jobs = new Map<string, DownloadJob>()
  private readonly models: AsrModelRegistry

  constructor(models: AsrModelRegistry) {
    this.models = models
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()]
  }

  start(id: string): DownloadJob {
    const offer = MODEL_OFFERS.find((item) => item.id === id)
    if (!offer) throw new Error('没有这个模型的官方下载地址')
    const current = this.jobs.get(id)
    if (current?.status === 'running') return current
    const root = this.models.ensureLibrary(defaultDownloadRoot())
    const job: DownloadJob = {
      id,
      name: offer.name,
      status: 'running',
      received: 0,
      total: offer.bytesHint,
      message: '正在下载',
    }
    this.jobs.set(id, job)
    void this.run(offer, root, job)
    return job
  }

  private async run(offer: ModelOffer, root: string, job: DownloadJob): Promise<void> {
    const staging = path.join(root, '.downloads')
    mkdirSync(staging, { recursive: true })
    const partial = path.join(staging, `${offer.id}.partial`)
    const archive = path.join(staging, `${offer.id}.archive`)
    try {
      await this.curl(offer.url, partial, job)
      renameSync(partial, archive)
      if (offer.archive === 'file') {
        const destDir = path.join(root, offer.folder)
        mkdirSync(destDir, { recursive: true })
        renameSync(archive, path.join(destDir, offer.fileName || path.basename(offer.url)))
      } else {
        await this.extract(archive, root)
      }
      job.status = 'done'
      job.message = '已下载到模型目录'
    } catch (error) {
      job.status = 'failed'
      job.message = error instanceof Error ? error.message : String(error)
    }
  }

  private curl(url: string, dest: string, job: DownloadJob): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'ignore', 'pipe'] })
      const timer = setInterval(() => {
        try {
          job.received = statSync(dest).size
        } catch {
          job.received = 0
        }
      }, 1000)
      let err = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => { err += chunk })
      child.on('error', (error) => {
        clearInterval(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearInterval(timer)
        try {
          job.received = statSync(dest).size
        } catch {
          job.received = 0
        }
        if (code === 0) resolve()
        else reject(new Error(err.trim().slice(-200) || `下载失败 ${code}`))
      })
    })
  }

  private extract(archive: string, root: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xjf', archive, '-C', root], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => { err += chunk })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(err.trim().slice(-200) || `解压失败 ${code}`))
      })
    })
  }
}
