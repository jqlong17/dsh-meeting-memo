#!/usr/bin/env node
/**
 * 维护：删掉归属表里超出转写文件行数的键。
 *
 * 这些键来自历史上的行号漂移（插件自己数行号时跨天/重启会错位）。
 * 行号现在由 appendSnippet 返回真实值，不会再产生新的越界键，所以这是收尾清理。
 *
 * 用法：node scripts/prune-assignments.mjs [--dry]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = path.join(os.homedir(), '.dsh', 'meeting-memo')
const dry = process.argv.includes('--dry')
const root = path.join(home, 'speaker-assignments')
if (!existsSync(root)) {
  console.log('没有 speaker-assignments 目录')
  process.exit(0)
}

let totalRemoved = 0
for (const name of readdirSync(root).sort()) {
  if (!name.endsWith('.json') || name === 'index.json') continue
  const day = name.slice(0, -'.json'.length)
  const file = path.join(root, name)
  const snippets = path.join(home, 'asr-log', day, 'snippets.jsonl')
  if (!existsSync(snippets)) continue
  const lines = readFileSync(snippets, 'utf8').split('\n').filter((line) => line.trim()).length
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const map = doc.map ?? {}
  const stale = Object.keys(map).filter((key) => Number(key) > lines)
  if (!stale.length) {
    console.log(`${day}: 干净（${Object.keys(map).length} 条，文件 ${lines} 行）`)
    continue
  }
  if (dry) {
    console.log(`${day}: 将删除 ${stale.length} 条越界键（文件 ${lines} 行）`)
    continue
  }
  for (const key of stale) delete map[key]
  doc.map = map
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  totalRemoved += stale.length
  console.log(`${day}: 删除 ${stale.length} 条越界键，保留 ${Object.keys(map).length} 条`)
}
if (!dry) console.log(totalRemoved ? `共清理 ${totalRemoved} 条` : '全部干净，无需清理')
