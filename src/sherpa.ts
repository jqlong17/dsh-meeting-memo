/**
 * Official sherpa-onnx CLI (k2-fsa). The DSH Python cannot load the pip wheel
 * because of a macOS Team ID mismatch, so transcription goes through the
 * standalone release binary.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const RELEASE = 'sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts'

export function sherpaHome(home: string): string {
  return path.join(home, 'runtimes', RELEASE)
}

export function sherpaReady(home: string): boolean {
  return existsSync(path.join(sherpaHome(home), 'bin', 'sherpa-onnx-offline'))
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function findFile(dir: string, pattern: RegExp): string | null {
  const name = files(dir).find((item) => pattern.test(item))
  return name ? path.join(dir, name) : null
}

export function sherpaCommand(home: string, modelDir: string, kind: string, wav: string, language = 'auto'): { bin: string; args: string[]; lib: string } | null {
  const root = sherpaHome(home)
  const bin = path.join(root, 'bin', 'sherpa-onnx-offline')
  if (!existsSync(bin)) return null
  const tokens = findFile(modelDir, /^tokens\.txt$/)
  if (!tokens) return null
  const args = [`--tokens=${tokens}`, '--num-threads=2']
  if (kind === 'onnx-sensevoice') {
    const model = findFile(modelDir, /^model\.onnx$/) ?? findFile(modelDir, /^model.*\.onnx$/)
    if (!model) return null
    const lid = language === 'zh' || language === 'en' ? language : 'auto'
    args.push(`--sense-voice-model=${model}`, `--sense-voice-language=${lid}`, '--sense-voice-use-itn=true')
  } else if (kind === 'moonshine') {
    const encoder = findFile(modelDir, /encoder.*\.(onnx|ort)$/)
    const merged = findFile(modelDir, /decoder_model_merged\.(onnx|ort)$/)
    if (!encoder || !merged) return null
    args.push(`--moonshine-encoder=${encoder}`, `--moonshine-merged-decoder=${merged}`)
  } else if (kind === 'zipformer') {
    const encoder = findFile(modelDir, /^encoder.*\.onnx$/)
    const decoder = findFile(modelDir, /^decoder.*int8\.onnx$/) ?? findFile(modelDir, /^decoder.*\.onnx$/)
    const joiner = findFile(modelDir, /^joiner.*\.onnx$/)
    if (encoder && decoder && joiner) {
      args.push(`--encoder=${encoder}`, `--decoder=${decoder}`, `--joiner=${joiner}`)
    } else {
      const model = findFile(modelDir, /model.*\.onnx$/)
      if (!model) return null
      args.push(`--zipformer-ctc-model=${model}`)
    }
  } else {
    return null
  }
  args.push(wav)
  return { bin, args, lib: path.join(root, 'lib') }
}

export function transcribeWav(home: string, modelDir: string, kind: string, wav: string, language = 'zhen', onSpawn?: (child: ChildProcess) => void): Promise<string> {
  const command = sherpaCommand(home, modelDir, kind, wav, language)
  if (!command) return Promise.reject(new Error('sherpa-onnx 运行时还没装好，或这个模型文件不完整'))
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      env: { ...process.env, DYLD_LIBRARY_PATH: command.lib },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    onSpawn?.(child)
    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim().slice(-300) || `sherpa-onnx 退出 ${code}`))
        return
      }
      const line = out.trim().split('\n').reverse().find((item) => item.trim().startsWith('{'))
      if (!line) {
        reject(new Error('sherpa-onnx 没有返回文本'))
        return
      }
      try {
        const parsed = JSON.parse(line) as { text?: string }
        resolve(String(parsed.text || '').trim())
      } catch {
        reject(new Error('无法解析 sherpa-onnx 输出'))
      }
    })
  })
}
