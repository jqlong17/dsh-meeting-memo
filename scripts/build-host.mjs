#!/usr/bin/env node
/**
 * Host-half build: bundle src/index.ts to lib/index.js.
 *
 * esbuild lookup order: $ESBUILD_BIN, this package's node_modules, a sibling
 * plugin checkout, then PATH. Host-only imports stay external (they resolve
 * from the DSH installation at runtime).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findEsbuild() {
  if (process.env.ESBUILD_BIN && existsSync(process.env.ESBUILD_BIN)) return process.env.ESBUILD_BIN
  const local = path.join(repo, 'node_modules', '.bin', 'esbuild')
  if (existsSync(local)) return local
  for (const sibling of ['dsh-ashare', 'dsh-chat-lens', 'dsh-onto-builder']) {
    const bin = path.resolve(repo, '..', sibling, 'node_modules', '.bin', 'esbuild')
    if (existsSync(bin)) return bin
  }
  const onPath = spawnSync('sh', ['-lc', 'command -v esbuild'], { encoding: 'utf8' })
  const found = onPath.status === 0 ? onPath.stdout.trim() : ''
  return found && existsSync(found) ? found : null
}

const bin = findEsbuild()
if (!bin) {
  console.error('[dsh-meeting-minutes] esbuild not found; run `npm install` in this package or set ESBUILD_BIN')
  process.exit(1)
}
console.log(`[dsh-meeting-minutes] building host with ${bin}`)

const result = spawnSync(
  bin,
  ['src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node20', '--outfile=lib/index.js', '--packages=external', '--log-level=warning'],
  { cwd: repo, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
