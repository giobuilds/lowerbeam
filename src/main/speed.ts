import type { GgufMetadata } from './gguf.js'

/**
 * Predicts generation speed for a model on this machine.
 *
 * Token generation is memory-bandwidth-bound: every token requires reading the
 * weights that participate in it, so throughput is roughly
 * `bytes_read_per_token / bandwidth`. Measured on an RX 6600, two models an
 * order of magnitude apart in size agreed on ~171 GB/s effective, which is 76%
 * of that card's theoretical 224 GB/s — a realistic achieved figure.
 *
 * Two things make this more than a division:
 *
 *  - A mixture-of-experts model reads only its active experts per token, so a
 *    30B model can behave like a 3B one. Judging it by file size would predict
 *    2 tok/s where reality is closer to 20, which is the difference between
 *    "pointless" and "usable".
 *  - A model too large for VRAM is not simply unusable. llama.cpp can keep
 *    attention on the GPU and experts in system RAM, so the honest answer
 *    blends both bandwidths rather than refusing to answer.
 */

export interface MachineProfile {
  /** Effective GPU read bandwidth in bytes/sec, measured from benchmarks. */
  gpuBytesPerSecond: number | null
  /** Effective CPU read bandwidth in bytes/sec. */
  cpuBytesPerSecond: number
  /** Free VRAM in bytes, or 0 with no usable GPU. */
  vramBytes: number
  /** Free system RAM in bytes. */
  ramBytes: number
  /**
   * Ceiling below which throughput stops scaling with size, because small
   * models are bound by per-token overhead rather than bandwidth. Measured at
   * roughly 600 tok/s on this class of card.
   */
  overheadCeilingTokensPerSecond: number
}

export type Placement =
  /** Everything resident in VRAM. */
  | 'gpu'
  /** Attention on the GPU, experts in system RAM — llama.cpp's --cpu-moe. */
  | 'hybrid-moe'
  /** Layers split between GPU and CPU. */
  | 'partial'
  /** Nothing on the GPU. */
  | 'cpu'
  /** Larger than VRAM and RAM combined. */
  | 'wont-load'

export interface SpeedEstimate {
  tokensPerSecond: number | null
  placement: Placement
  /** Weights actually read per token, which is what governs speed. */
  activeBytes: number
  totalBytes: number
  /** True when the model is a mixture of experts. */
  moe: boolean
  expertsUsed: number | null
  expertsTotal: number | null
  /** Plain-language reasons, shown so the number can be judged. */
  notes: string[]
  /** Set when no useful estimate can be made. */
  unknownReason: string | null
}

/** Parameters read for a single token, and the model's total. */
export interface ActiveParams {
  active: number
  total: number
  moe: boolean
  /**
   * Of the active parameters, those held in expert blocks. This is the share
   * that can be moved to system RAM, and in a sparse MoE it is most of them —
   * which is why it decides the speed of a hybrid placement.
   */
  activeExpert: number
  /** All parameters held in expert blocks, used or not: what --cpu-moe moves out of VRAM. */
  expert: number
}

/**
 * Split a model's parameters into what every token reads and what it does not.
 *
 * For a dense model these are the same. For a mixture of experts, only
 * `expert_used_count` of `expert_count` experts contribute, while attention and
 * the output projection are read in full — the output projection matters more
 * than it looks, because a large vocabulary makes it a substantial share.
 */
export function activeParameters(meta: GgufMetadata): ActiveParams | null {
  const { blockCount, embeddingLength, headCount, headCountKv, vocabSize } = meta
  if (!blockCount || !embeddingLength) return null

  const embd = embeddingLength
  // Head dimensions are taken from the header when given: some models set them
  // larger than embedding/head_count, and assuming the division halves the
  // attention weights.
  const keyDim = meta.keyLength ?? (headCount ? embd / headCount : 0)
  const valueDim = meta.valueLength ?? keyDim
  const heads = headCount ?? 0
  const kvHeads = headCountKv ?? heads
  const qOut = heads * keyDim
  const kvOut = kvHeads * keyDim
  const vOut = kvHeads * valueDim
  // q projects in, k and v are narrower under grouped-query attention, o projects back.
  const attnPerLayer =
    heads > 0 ? embd * qOut + embd * kvOut + embd * vOut + heads * valueDim * embd : embd * embd * 4

  const expertsTotal = meta.expertCount ?? 0
  const expertsUsed = meta.expertUsedCount ?? 0
  const expertFf = meta.expertFeedForwardLength ?? 0
  const denseFf = meta.feedForwardLength ?? 0
  const moe = expertsTotal > 1 && expertsUsed > 0 && expertFf > 0

  // Gated feed-forward blocks have three matrices: gate, up and down.
  const GATED = 3
  const expertsPerLayer = moe ? GATED * embd * expertFf * expertsTotal : 0
  const activeExpertsPerLayer = moe ? GATED * embd * expertFf * expertsUsed : 0
  // In a pure MoE the advertised feed_forward_length describes the expert
  // block rather than an additional dense one, so counting it again would
  // inflate both totals.
  const densePerLayer = moe ? 0 : GATED * embd * denseFf

  // The output projection is read in full for every token's logits.
  const outputProjection = (vocabSize ?? 0) * embd

  const total = blockCount * (attnPerLayer + densePerLayer + expertsPerLayer) + outputProjection
  const active =
    blockCount * (attnPerLayer + densePerLayer + activeExpertsPerLayer) + outputProjection
  if (total <= 0) return null
  return { active, total, moe, activeExpert: blockCount * activeExpertsPerLayer, expert: blockCount * expertsPerLayer }
}

export function estimateSpeed(
  meta: GgufMetadata,
  machine: MachineProfile,
  /** Total size on disk; for a split model, of every shard. */
  fileBytes = meta.fileSize
): SpeedEstimate {
  const params = activeParameters(meta)
  const notes: string[] = []

  if (!params) {
    return {
      tokensPerSecond: null, placement: 'gpu', activeBytes: 0, totalBytes: fileBytes,
      moe: false, expertsUsed: null, expertsTotal: null, notes,
      unknownReason: 'The model header did not describe its shape.'
    }
  }

  const activeFraction = params.active / params.total
  const activeBytes = fileBytes * activeFraction
  const gpuBw = machine.gpuBytesPerSecond
  // The share of each token's reading that experts account for. In a sparse
  // MoE this is most of it, which is what makes system-RAM bandwidth the
  // limiting factor once the experts no longer fit in VRAM.
  const expertShare = params.moe && params.active > 0 ? params.activeExpert / params.active : 0

  if (params.moe) {
    notes.push(
      `${meta.expertUsedCount} of ${meta.expertCount} experts run per token, ` +
        `so it reads about ${(activeFraction * 100).toFixed(0)}% of its weights each time`
    )
  }

  // --- where the weights can live -----------------------------------------
  let placement: Placement
  if (fileBytes <= machine.vramBytes && gpuBw) {
    placement = 'gpu'
  } else if (fileBytes > machine.vramBytes + machine.ramBytes) {
    placement = 'wont-load'
  } else if (!gpuBw || machine.vramBytes === 0) {
    placement = 'cpu'
  } else if (params.moe) {
    placement = 'hybrid-moe'
  } else {
    placement = 'partial'
  }

  if (placement === 'wont-load') {
    notes.push('Larger than VRAM and system RAM together.')
    return {
      tokensPerSecond: null, placement, activeBytes, totalBytes: fileBytes,
      moe: params.moe, expertsUsed: meta.expertUsedCount ?? null,
      expertsTotal: meta.expertCount ?? null, notes,
      unknownReason: 'It will not load on this machine.'
    }
  }

  // --- how long a token takes ----------------------------------------------
  let seconds: number
  switch (placement) {
    case 'gpu':
      seconds = activeBytes / gpuBw!
      notes.push('Fits entirely in VRAM.')
      break
    case 'hybrid-moe': {
      // Experts to system RAM, everything else resident on the GPU — what
      // llama.cpp's --cpu-moe does. The experts dominate the transfer.
      const expertBytes = activeBytes * expertShare
      const residentBytes = activeBytes - expertBytes
      seconds = residentBytes / gpuBw! + expertBytes / machine.cpuBytesPerSecond
      notes.push(
        'Too large for VRAM, but the experts can sit in system RAM with attention ' +
          'on the GPU (--cpu-moe), which is far better than splitting layers.'
      )
      break
    }
    case 'partial': {
      // Layers divide by capacity; each token still reads all of them.
      const onGpu = Math.min(1, machine.vramBytes / fileBytes)
      seconds =
        (activeBytes * onGpu) / gpuBw! + (activeBytes * (1 - onGpu)) / machine.cpuBytesPerSecond
      notes.push(
        `Only about ${(onGpu * 100).toFixed(0)}% fits in VRAM; the rest is read from ` +
          'system RAM every token, which dominates the time.'
      )
      break
    }
    default:
      seconds = activeBytes / machine.cpuBytesPerSecond
      notes.push('Runs on the CPU.')
  }

  const raw = 1 / seconds
  const tokensPerSecond = Math.min(raw, machine.overheadCeilingTokensPerSecond)
  if (tokensPerSecond < raw) {
    notes.push('Small enough that per-token overhead, not bandwidth, sets the pace.')
  }

  return {
    tokensPerSecond,
    placement,
    activeBytes,
    totalBytes: fileBytes,
    moe: params.moe,
    expertsUsed: meta.expertUsedCount ?? null,
    expertsTotal: meta.expertCount ?? null,
    notes,
    unknownReason: null
  }
}

/**
 * How comfortable a speed feels in conversation. Reading pace is around 5–10
 * tokens per second, so anything above that keeps up with a person; below it,
 * waiting becomes the experience.
 */
export function comfortOf(tokensPerSecond: number | null): 'fast' | 'comfortable' | 'slow' | 'painful' | 'unknown' {
  if (tokensPerSecond === null) return 'unknown'
  if (tokensPerSecond >= 40) return 'fast'
  if (tokensPerSecond >= 15) return 'comfortable'
  if (tokensPerSecond >= 5) return 'slow'
  return 'painful'
}
