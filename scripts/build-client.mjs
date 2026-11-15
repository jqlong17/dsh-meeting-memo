#!/usr/bin/env node
/**
 * Browser-half build for `dsh-meeting-memo`.
 *
 * The DSH web shell loads the bundle as a classic script that only registers a
 * factory: `window.__ModuleLoader__.load({ id, factory })`. Only the platform
 * seed modules (`react`, `react/jsx-runtime`) may be required at runtime, and
 * no CSS is allowed — all styles are inline theme tokens.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ID = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).name
const PLATFORM_REQUIRES = ['react', 'react/jsx-runtime']
const ENTRY = path.join(repo, 'src/client/index.ts')
const RAW = path.join(repo, 'lib/client.raw.js')
const OUTFILE = path.join(repo, 'lib/client.js')

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

function wrap(body) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body.split('\n').map((line) => (line ? `    ${line}` : line)).join('\n')}
    return module.exports;
  }
});
`
}

const bin = findEsbuild()
if (!bin) {
  console.error('[build-client] esbuild not found; run `npm install` in this package or set ESBUILD_BIN')
  process.exit(1)
}
await mkdir(path.dirname(OUTFILE), { recursive: true })
const result = spawnSync(bin, [
  ENTRY,
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--charset=utf8',
  '--external:react',
  '--external:react/jsx-runtime',
  `--outfile=${RAW}`,
  '--log-level=warning',
], { cwd: repo, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

const body = (await readFile(RAW, 'utf8')).trimEnd()
const requires = [...new Set([...body.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]))]
const unexpected = requires.filter((name) => !PLATFORM_REQUIRES.includes(name))
if (unexpected.length) {
  console.error(`[build-client] unexpected requires: ${unexpected.join(', ')}`)
  process.exit(1)
}
if (/^\s*(?:import|export)\s/m.test(body)) {
  console.error('[build-client] output contains a top-level ESM statement; the Host concatenates bundles as classic scripts')
  process.exit(1)
}
const wrapped = wrap(body)
await writeFile(OUTFILE, wrapped, 'utf8')
await unlink(RAW)
console.log(`[build-client] wrote ${path.relative(repo, OUTFILE)} (${(Buffer.byteLength(wrapped) / 1024).toFixed(1)} KiB) requires=[${requires.join(', ')}]`)
