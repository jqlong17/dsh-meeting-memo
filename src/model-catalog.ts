/**
 * Official download addresses for people who do not already have a model library.
 * Only URLs that answered HTTP 200 are listed. Whisper .pt mirrors 404, so they are omitted.
 */
import os from 'node:os'
import path from 'node:path'

import type { ModelCapability } from './asr-models.ts'

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
  url: string
  archive: 'tar.bz2' | 'file'
  fileName?: string
}

export function defaultDownloadRoot(): string {
  return path.join(os.homedir(), 'Downloads', 'meeting-minutes-models')
}

export const MODEL_OFFERS: ModelOffer[] = [
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

export function offerMatches(offer: ModelOffer, modelPath: string): boolean {
  const name = path.basename(modelPath)
  return name === offer.folder || offer.aliases.includes(name)
}
