#!/usr/bin/env node
/**
 * 发 npm 前的自检。任何一项不过就中断发布。
 *
 *   1. 版本号：src/version.ts 与 package.json 必须一致
 *   2. 工作区：必须干净（避免发出没进 git 的代码）
 *   3. 构建：host / client 都能编过
 *   4. 测试：node --test 全绿
 *   5. 客户端冒烟：check-client 的 tab/文案/渲染检查
 *
 * 由 package.json 的 prepublishOnly 自动调用。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const problems = []

function step(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.log(`✗ ${name}`)
    problems.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe', encoding: 'utf8' })

step('版本号一致', () => {
  const versionTs = readFileSync(path.join(root, 'src/version.ts'), 'utf8').match(/PLUGIN_VERSION = '([^']+)'/)?.[1]
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!versionTs) throw new Error('src/version.ts 里没找到 PLUGIN_VERSION')
  if (versionTs !== pkg.version) throw new Error(`version.ts=${versionTs} != package.json=${pkg.version}`)
})

step('工作区干净', () => {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  if (status) throw new Error(`有未提交改动：\n${status}`)
})

step('构建 host', () => run(['scripts/build-host.mjs']))
step('构建 client', () => run(['scripts/build-client.mjs']))

step('测试', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--test', ...listTests()], {
    cwd: root, encoding: 'utf8',
  })
  const fail = out.match(/# fail (\d+)/)?.[1]
  if (fail && fail !== '0') throw new Error(`有 ${fail} 项测试失败`)
})

step('客户端冒烟', () => run(['scripts/check-client.mjs']))

function listTests() {
  const dir = path.join(root, 'tests')
  return execFileSync('ls', [dir], { encoding: 'utf8' })
    .split('\n').filter((name) => name.endsWith('.test.ts')).map((name) => path.join('tests', name))
}

if (problems.length) {
  console.error('\n发布前自检未通过：')
  for (const item of problems) console.error(` - ${item}`)
  process.exit(1)
}
console.log('\n发布前自检全部通过。')
