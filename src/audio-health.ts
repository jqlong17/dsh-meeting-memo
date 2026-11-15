/**
 * Audio health for the capture helper.
 *
 * "No speech" and "no audio at all" look identical in the activity log: both are
 * zero seconds. The helper now reports how many buffers it received and how loud
 * the loudest sample was, which separates a quiet room from a dead input tap.
 */

export type TrackHealth = 'ok' | 'silent' | 'dead' | 'off'

export interface AudioTick {
  micBuffers: number
  systemBuffers: number
  micPeak: number
  systemPeak: number
}

export interface AudioHealth {
  mic: TrackHealth
  system: TrackHealth
  /** Consecutive minutes with digital silence (or no buffers) on the microphone. */
  silentMinutes: number
}

/** Below this the input is a muted or disconnected device, not a quiet room. */
export const DIGITAL_SILENCE = 0.0005

function tickOf(sample: Record<string, unknown>): AudioTick | null {
  const micBuffers = Number(sample.micBuffers)
  if (!Number.isFinite(micBuffers)) return null
  return {
    micBuffers,
    systemBuffers: Number(sample.systemBuffers) || 0,
    micPeak: Number(sample.micPeak) || 0,
    systemPeak: Number(sample.systemPeak) || 0,
  }
}

export function audioHealthOf(samples: Record<string, unknown>[], systemOn: boolean): AudioHealth {
  const ticks = samples.map(tickOf).filter((tick): tick is AudioTick => tick !== null)
  const last = ticks.at(-1)
  if (!last) return { mic: 'off', system: systemOn ? 'off' : 'off', silentMinutes: 0 }

  const mic: TrackHealth = last.micBuffers <= 0
    ? 'dead'
    : last.micPeak <= DIGITAL_SILENCE ? 'silent' : 'ok'
  const system: TrackHealth = !systemOn
    ? 'off'
    : last.systemBuffers <= 0
      ? 'dead'
      : last.systemPeak <= DIGITAL_SILENCE ? 'silent' : 'ok'

  let silentMinutes = 0
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index]
    const micDead = tick.micBuffers <= 0 || tick.micPeak <= DIGITAL_SILENCE
    const systemDead = !systemOn || tick.systemBuffers <= 0 || tick.systemPeak <= DIGITAL_SILENCE
    if (!micDead && !systemDead) break
    silentMinutes += 1
  }
  return { mic, system, silentMinutes }
}

/** A run of digital silence means the tap died even though the process is alive. */
export function audioNeedsRestart(health: AudioHealth, minutes = 3): boolean {
  return health.mic === 'dead' || health.mic === 'silent' && health.silentMinutes >= minutes
}
