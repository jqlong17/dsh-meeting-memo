/**
 * Official download addresses for people who do not already have a model library.
 * Only URLs that answered HTTP 200 are listed. Whisper .pt mirrors 404, so they are omitted.
 */
import os from 'node:os'
import path from 'node:path'

import type { ModelCapability } from './asr-models.ts'

export interface ModelFile {
  /** 相对 offer.folder 的落盘路径。 */
  path: string
  url: string
}

export interface ModelOffer {
  id: string
  folder: string
  aliases: string[]
  name: string
  summary: string
  capabilities: ModelCapability[]
  usable: boolean
  format: string
  bytesHint: number
  /** 单文件或单个压缩包。与 files 二选一。 */
  url?: string
  archive?: 'tar.bz2' | 'file'
  fileName?: string
  /** 多文件分发（Hugging Face 这类没有整包的地方）。 */
  files?: ModelFile[]
  /** 只在指定平台出现；缺省表示所有平台。 */
  platform?: 'darwin'
}

export function defaultDownloadRoot(): string {
  return path.join(os.homedir(), 'Downloads', 'meeting-minutes-models')
}

export const MODEL_OFFERS: ModelOffer[] = [
  {
    id: 'sensevoice-coreml-int8',
    folder: 'SenseVoiceSmall_int8-coreml',
    aliases: ['sensevoice-coreml-int8', 'SenseVoiceSmall_int8'],
    name: 'SenseVoiceSmall_int8 苹果 Core ML',
    summary: 'Mac 专用，走 Apple Core ML 与神经引擎。约 240 MB，占内存比 ONNX 小很多。',
    capabilities: ['asr'],
    usable: true,
    format: 'Apple Core ML',
    bytesHint: 240 * 1024 * 1024,
    platform: 'darwin',
    files: [
      'SenseVoiceSmall_int8.mlmodelc/coremldata.bin',
      'SenseVoiceSmall_int8.mlmodelc/model.mil',
      'SenseVoiceSmall_int8.mlmodelc/weights/weight.bin',
      'SenseVoiceSmall_int8.mlmodelc/analytics/coremldata.bin',
      'SenseVoicePreprocessor.mlmodelc/coremldata.bin',
      'SenseVoicePreprocessor.mlmodelc/model.mil',
      'SenseVoicePreprocessor.mlmodelc/weights/weight.bin',
      'SenseVoicePreprocessor.mlmodelc/analytics/coremldata.bin',
      'vocab.json',
    ].map((file) => ({
      path: file,
      url: `https://huggingface.co/FluidInference/sensevoice-small-coreml/resolve/main/${file}`,
    })),
  },
  {
    id: 'sensevoice-small',
    folder: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    aliases: ['sensevoice-small', 'sensevoice-small-fp32', 'sensevoice-small-fp32-2024-07-17'],
    name: 'sensevoice-small ONNX fp32',
    summary: '跨平台 SenseVoice fp32。约 894 MB 权重，非苹果机器下载这份。',
    capabilities: ['asr'],
    usable: true,
    format: 'ONNX fp32',
    bytesHint: 894 * 1024 * 1024,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2',
    archive: 'tar.bz2',
  },
]

/** 只暴露当前平台能用的 offer：Core ML 是 Mac 专属。 */
export function offersForPlatform(platform: NodeJS.Platform = process.platform): ModelOffer[] {
  return MODEL_OFFERS.filter((offer) => !offer.platform || offer.platform === platform)
}

export function offerMatches(offer: ModelOffer, modelPath: string): boolean {
  const name = path.basename(modelPath)
  return name === offer.folder || offer.aliases.includes(name)
}
