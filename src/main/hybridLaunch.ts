import type { GgufMetadata } from './gguf.js'
import { hybridKvNote } from './remoteFit.js'
import { planVram } from './planner.js'
import type { LaunchConfig } from '@shared/types.js'

const MiB = 1024 * 1024
/** Same share of system RAM the speed estimate treats as usable. */
const RAM_SHARE = 0.65

export interface HybridServeChoice {
  config: LaunchConfig
  /** Printed before the model loads. Null when the saved launch is left as it is. */
  note: string | null
}

/**
 * A saved launch that never moved experts off the GPU, for a mixture of
 * experts that does not fit in VRAM.
 *
 * `lowerbeam serve` replays that launch. Leaving it unchanged starts the slow
 * partial offload. Experts in system RAM is the setup that actually runs on
 * an 8–12 GB card. A launch that already chose a placement is not touched,
 * and neither is a model that fits on the GPU or that is larger than VRAM
 * and system RAM together.
 */
export function withHybridExperts(
  config: LaunchConfig,
  meta: GgufMetadata,
  freeMiB: number | null,
  ramBytes: number,
  flags: readonly string[]
): HybridServeChoice {
  if (config.cpuMoeLayers !== 0) return { config, note: null }
  const all = flags.includes('--cpu-moe')
  const counted = flags.includes('--n-cpu-moe')
  if (!all && !counted) return { config, note: null }
  if (!meta.expertCount || meta.expertCount < 2) return { config, note: null }
  if (freeMiB == null) return { config, note: null }

  const full = planVram(
    {
      meta,
      gpuLayers: 999,
      contextSize: config.contextSize > 0 ? config.contextSize : 4096,
      cacheTypeK: config.cacheTypeK,
      cacheTypeV: config.cacheTypeV,
      parallel: config.parallel,
      cpuMoeLayers: 0,
      hasGpuBackend: true
    },
    freeMiB
  )
  if (full.fits !== false) return { config, note: null }
  if (meta.fileSize > freeMiB * MiB + ramBytes * RAM_SHARE) return { config, note: null }

  const cpuMoeLayers = all ? -1 : Math.max(1, meta.blockCount ?? 1)
  let next: LaunchConfig = { ...config, cpuMoeLayers }
  let cache = ''
  // Quantised KV needs flash attention, or llama.cpp cannot create the context.
  if (
    config.cacheTypeK === 'f16' &&
    config.cacheTypeV === 'f16' &&
    flags.includes('--flash-attn') &&
    hybridKvNote(meta, freeMiB)
  ) {
    next = { ...next, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', flashAttn: true }
    cache = ' KV cache is q8_0 so the trained context does not fill the card.'
  }
  const name = meta.name || meta.fileName
  return {
    config: next,
    note:
      `${name} does not fit in ${Math.round(freeMiB).toLocaleString()} MiB of VRAM. ` +
      `Serving with experts in system RAM (${cpuMoeLayers === -1 ? '--cpu-moe' : `--n-cpu-moe ${cpuMoeLayers}`}).${cache}`
  }
}
