#!/usr/bin/env node
/**
 * 一次性数据迁移（幂等，可重复跑）：
 *   1. 声纹：snippets.jsonl 内联的 emb → 同目录 emb.jsonl（正文缩水、可 grep）
 *   2. 归属：speaker-assignments.json 单文件 → speaker-assignments/<day>.json
 *
 * 用法：node scripts/migrate-data.mjs [--dry]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = path.join(os.homedir(), '.dsh', 'meeting-memo')
const dry = process.argv.includes('--dry')

const { migrateDay } = await import('../src/emb-store.ts')
const { splitLegacy, listDays } = await import('../src/speaker-assignments.ts')

const logRoot = path.join(home, 'asr-log')
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`

if (existsSync(logRoot)) {
  const days = readdirSync(logRoot).filter((name) => statSync(path.join(logRoot, name)).isDirectory())
  for (const day of days.sort()) {
    const dir = path.join(logRoot, day)
    if (!existsSync(path.join(dir, 'snippets.jsonl'))) continue
    if (dry) {
      console.log(`[dry] ${day}: 会检查内联声纹`)
      continue
    }
    const result = migrateDay(dir, day)
    if (!result.moved) {
      console.log(`${day}: 无需迁移（${result.rows} 行）`)
      continue
    }
    console.log(`${day}: 移出 ${result.moved} 条声纹 | 正文 ${kb(result.beforeBytes)} → ${kb(result.afterBytes)} | 声纹 ${kb(result.embBytes)}`)
  }
}

if (dry) {
  console.log('[dry] 归属文件：', listDays(home).join('、') || '（无）')
} else {
  const split = splitLegacy(home)
  if (split.days) console.log(`归属：拆出 ${split.days} 天 / ${split.entries} 条，旧文件备份为 ${path.basename(split.backup)}`)
  else console.log('归属：无需迁移')
}
