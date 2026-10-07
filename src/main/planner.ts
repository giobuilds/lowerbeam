import type { GgufMetadata } from './gguf.js'
import type { KvCacheType } from '@shared/types.js'
import { activeParameters } from './speed.js'

/**
 * Estimates what a launch will cost in VRAM.
 *
 * The KV-cache figure is exact arithmetic, not a guess — it reproduces
 * llama.cpp's own reported size to the byte. The weight and compute figures are
 * approximations, and the UI labels them as such: the point is to catch "this
 * will not fit" before a 20-second load ends in an allocation failure, not to
 * predict allocator behaviour precisely.
 */

const MiB = 1024 * 1024

/**
 * Bytes per element for each KV cache type. Quantised types are ggml block
 * formats: q4_0 packs 32 elements into 18 bytes, q8_0 into 34, and so on.
 */
const KV_BYTES_PER_ELEMENT: Record<KvCacheType, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  iq4_nl: 18 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32
}

/**
 * How the installed llama.cpp sizes its compute buffer. Older builds materialise
 * logits for the whole physical batch; newer ones only for the tokens they
 * actually output, which is an ~8x difference (310 MiB vs 38 MiB measured on the
 * same model), far too large to ignore in a "will it fit" answer.
 */
export type ComputeProfile = 'classic' | 'modern'

export interface PlanInput {
  meta: GgufMetadata
  gpuLayers: number
  contextSize: number
  cacheTypeK: KvCacheType
  cacheTypeV: KvCacheType
  /** -ub, physical batch size. Drives the logits buffer. Defaults to llama.cpp's 512. */
  ubatch?: number
  parallel?: number
  computeProfile?: ComputeProfile
  /** True when a GPU backend will be initialised, which reserves memory of its own. */
  hasGpuBackend?: boolean
  /** Experts kept in system RAM: 0 none, -1 every layer's, N the first N layers'. */
  cpuMoeLayers?: number
}

export interface VramPlan {
  /** Layers actually offloaded, after clamping to what the model has. */
  offloadedLayers: number
  totalLayers: number
  weightsMiB: number
  kvCacheMiB: number
  computeMiB: number
  /** Memory the GPU runtime reserves regardless of model, when offloading. */
  backendOverheadMiB: number
  totalMiB: number
  /** Free VRAM at the time of planning, if a device was supplied. */
  freeMiB: number | null
  fits: boolean | null
  /** Largest -ngl that is expected to fit, or null without a device. */
  maxGpuLayers: number | null
  /** Context each concurrent conversation actually gets: total / slots. */
  contextPerSlot: number
  slots: number
  /** Blocks with experts on a mixture-of-experts model; null on a dense one. */
  moeBlocks: number | null
  /** Expert weights held in system RAM by --cpu-moe / --n-cpu-moe. */
  expertsOnCpuMiB: number
  /** Human-readable arithmetic, shown in the UI so the estimate is auditable. */
  notes: string[]
}

/**
 * The blocks that hold a KV cache. Every block on an ordinary transformer;
 * on a hybrid, every Nth — the others keep a fixed state that does not
 * grow with context — and never the next-token-prediction blocks, which
 * the server loads and does not run. Ornith 1.5 9B: 33 blocks, one of
 * them nextn, one in four with a cache, so 8. Estimating with 33 was
 * four times the truth.
 */
export function attentionLayers(meta: GgufMetadata): number {
  const blocks = Math.max(0, (meta.blockCount ?? 0) - (meta.nextnLayers ?? 0))
  const interval = meta.fullAttentionInterval ?? 1
  return interval > 1 ? Math.floor(blocks / interval) : blocks
}

/**
 * KV cache size. This is exact: llama.cpp allocates
 *   2 (K and V) x n_layer x n_ctx x n_embd_gqa x bytes_per_element
 * where n_embd_gqa = head_dim x n_head_kv and n_layer counts the blocks
 * that hold a cache.
 */
export function kvCacheBytes(
  meta: GgufMetadata,
  contextSize: number,
  cacheTypeK: KvCacheType,
  cacheTypeV: KvCacheType,
  layers?: number
): number | null {
  const { embeddingLength, headCount, headCountKv, blockCount } = meta
  if (!embeddingLength || !headCount || !headCountKv || !blockCount) return null
  // Explicit head dimensions win where the file sets them: Qwen 3 uses 128
  // where the division implies 64.
  const headDim = meta.keyLength ?? embeddingLength / headCount
  const embdGqa = headDim * headCountKv
  const n = layers ?? attentionLayers(meta)
  const cells = contextSize * embdGqa * n
  return cells * KV_BYTES_PER_ELEMENT[cacheTypeK] + cells * KV_BYTES_PER_ELEMENT[cacheTypeV]
}

/**
 * Compute buffer.
 *
 * 'classic' builds allocate a logits buffer of n_vocab x n_ubatch floats, which
 * on a small model dwarfs the KV cache. 'modern' builds only produce logits for
 * emitted tokens, so the buffer is dominated by graph activations instead.
 *
 * Both branches are anchored to measurements of the same model on the same GPU
 * (310.01 MiB classic, 37.76 MiB modern, qwen2.5-0.5b Q4_K_M at ubatch 512), so
 * the activation multiplier is empirical rather than derived. It is the least
 * reliable term in the plan, and the UI says so.
 */
export function computeBufferBytes(
  meta: GgufMetadata,
  ubatch = 512,
  profile: ComputeProfile = 'modern'
): number | null {
  if (profile === 'classic') {
    if (!meta.vocabSize) return null
    return Math.round(meta.vocabSize * ubatch * 4 * 1.05)
  }
  if (!meta.embeddingLength) return null
  const ACTIVATION_TENSORS = 20
  const activations = meta.embeddingLength * ubatch * 4 * ACTIVATION_TENSORS
  const logits = (meta.vocabSize ?? 0) * 4
  return Math.round(activations + logits)
}

/**
 * A GPU backend reserves context memory before any model data is placed in it.
 * Measured at roughly 190 MiB for ROCm/HIP on this class of card; it is a large
 * enough share of an 8 GB budget that leaving it out makes the plan optimistic
 * in exactly the situation where being optimistic is most harmful.
 */
const BACKEND_OVERHEAD_MIB = 190

/**
 * Weights are spread over the transformer blocks plus an output layer, which is
 * the unit `-ngl` counts (llama.cpp reports "offloaded 25/25 layers" for a
 * 24-block model). Treating the file as evenly divided across those units
 * overestimates the GPU share somewhat, because the token-embedding tensor
 * tends to stay resident on the host.
 */
export function weightBytesOnGpu(meta: GgufMetadata, gpuLayers: number): number {
  const blocks = meta.blockCount ?? 0
  const units = blocks + 1
  if (units <= 1) return gpuLayers > 0 ? meta.fileSize : 0
  const offloaded = Math.max(0, Math.min(gpuLayers, units))
  if (offloaded === 0) return 0

  // The token-embedding tensor stays mapped on the host even at full offload
  // (measured: 89 MiB of a 463 MiB file). Its share of the file is estimated
  // from its share of the parameters, which avoids modelling per-tensor
  // quantisation while still being much closer than ignoring it.
  // Read from the tensor table where it was, which is exact, does not need a
  // parameter count many files leave out, and knows when the embedding is tied
  // to the output (then the GPU holds a copy) or comes with a per-layer table.
  const embdParams = (meta.vocabSize ?? 0) * (meta.embeddingLength ?? 0)
  const embdBytes =
    meta.embeddingBytes ??
    (embdParams > 0 && meta.parameterCount
      ? Math.min(meta.fileSize * (embdParams / meta.parameterCount), meta.fileSize * 0.5)
      : 0)
  // Next-token-prediction blocks are in the file but never loaded.
  const body = meta.fileSize - embdBytes - (meta.unusedBytes ?? 0)

  // Blocks offload proportionally; the final unit is the output layer.
  const blockShare = blocks > 0 ? (body * Math.min(offloaded, blocks)) / units : 0
  const outputShare = offloaded > blocks ? body / units : 0
  return blockShare + outputShare
}

/**
 * Expert weights per block, and how many of them --cpu-moe / --n-cpu-moe keep
 * off the GPU. Bytes come from the file's tensor table when it was read —
 * exact, and necessary: a UD quantisation keeps experts at far fewer bits than
 * attention, so a share of the parameters put 400 MiB too little on the GPU
 * for Qwen3-Coder-30B-A3B. Without the table, the parameter share is the
 * fallback.
 *
 * -ngl offloads the last layers and --n-cpu-moe keeps the first N layers'
 * experts on the CPU, so the experts that leave VRAM are those of layers in
 * both sets: the overlap of [blocks - offloaded, blocks) with [0, N).
 */
export function expertPlacement(
  meta: GgufMetadata,
  offloadedBlocks: number,
  cpuMoeLayers: number
): { moeBlocks: number | null; onCpuBlocks: number; onCpuBytes: number; offGpuBytes: number } {
  const blocks = meta.blockCount ?? 0
  const params = activeParameters(meta)
  const measured = meta.expertBytesPerBlock?.length === blocks ? meta.expertBytesPerBlock : null
  if ((!params?.moe && !measured) || blocks <= 0) return { moeBlocks: null, onCpuBlocks: 0, onCpuBytes: 0, offGpuBytes: 0 }
  const estimate = params?.moe ? (meta.fileSize * (params.expert / params.total)) / blocks : 0
  const bytesOf = (b: number): number => measured?.[b] ?? estimate
  const onCpuBlocks = cpuMoeLayers === -1 ? blocks : Math.max(0, Math.min(cpuMoeLayers, blocks))
  const firstOnGpu = blocks - Math.max(0, Math.min(offloadedBlocks, blocks))
  let onCpuBytes = 0
  let offGpuBytes = 0
  for (let b = 0; b < onCpuBlocks; b++) {
    onCpuBytes += bytesOf(b)
    if (b >= firstOnGpu) offGpuBytes += bytesOf(b)
  }
  return { moeBlocks: blocks, onCpuBlocks, onCpuBytes, offGpuBytes }
}

export function planVram(input: PlanInput, freeMiB: number | null): VramPlan {
  const { meta, cacheTypeK, cacheTypeV } = input
  // A context of 0 is not no context: llama.cpp takes the model's trained
  // length, 262,144 tokens for the 9B, which on an 8 GB card is the whole
  // card. The estimate has to say so rather than show an empty cache.
  const contextSize = input.contextSize > 0 ? input.contextSize : (meta.contextLength ?? 0)
  const ubatch = input.ubatch ?? 512
  const parallel = input.parallel ?? 1
  const totalLayers = (meta.blockCount ?? 0) + 1
  const offloadedLayers = Math.max(0, Math.min(input.gpuLayers, totalLayers))
  const anyOffload = offloadedLayers > 0

  const experts = expertPlacement(meta, Math.min(offloadedLayers, meta.blockCount ?? 0), input.cpuMoeLayers ?? 0)
  const weights = Math.max(0, weightBytesOnGpu(meta, input.gpuLayers) - experts.offGpuBytes)
  const expertsOnCpu = experts.onCpuBytes
  // KV lives with the layers it belongs to, so a partial offload only puts a
  // proportional slice of the cache in VRAM.
  // Only the blocks that hold a cache count, and only the offloaded share of them.
  const cached = attentionLayers(meta)
  const kvLayers = Math.min(Math.round((cached * offloadedLayers) / Math.max(1, meta.blockCount ?? 1)), cached)
  // -c is the TOTAL context, which llama.cpp divides across slots: `-c 16384
  // --parallel 4` gives each slot 4096 and allocates one 16384-cell cache, not
  // four. Multiplying here would overstate the KV cache by the slot count.
  const kv = kvCacheBytes(meta, contextSize, cacheTypeK, cacheTypeV, kvLayers) ?? 0
  const contextPerSlot = Math.floor(contextSize / Math.max(1, parallel))
  const compute = anyOffload
    ? (computeBufferBytes(meta, ubatch, input.computeProfile ?? 'modern') ?? 0)
    : 0
  const overheadMiB = anyOffload && (input.hasGpuBackend ?? true) ? BACKEND_OVERHEAD_MIB : 0

  const weightsMiB = weights / MiB
  const kvCacheMiB = kv / MiB
  const computeMiB = compute / MiB
  const totalMiB = weightsMiB + kvCacheMiB + computeMiB + overheadMiB

  const notes: string[] = []
  notes.push(`weights: ${fmt(meta.fileSize / MiB)} MiB x ${offloadedLayers}/${totalLayers} layers`)
  if (experts.onCpuBlocks > 0) {
    notes.push(
      `experts of ${experts.onCpuBlocks === experts.moeBlocks ? 'every' : `the first ${experts.onCpuBlocks}`} layer${experts.onCpuBlocks === 1 ? '' : 's'} in system RAM: ` +
        `${fmt(expertsOnCpu / MiB)} MiB${meta.expertBytesPerBlock ? ', from the tensor table' : ', estimated from the parameter share'}`
    )
  }
  if (input.contextSize <= 0 && contextSize > 0) notes.push(`context 0 means the model's trained length: ${contextSize} tokens`)
  if (kv > 0 && meta.embeddingLength && meta.headCount && meta.headCountKv) {
    const headDim = meta.keyLength ?? meta.embeddingLength / meta.headCount
    notes.push(
      `KV: 2 x ${kvLayers} layers${(meta.fullAttentionInterval ?? 1) > 1 ? ` (one in ${meta.fullAttentionInterval} holds a cache)` : ''} x ${contextSize} ctx x ` +
        `${headDim * meta.headCountKv} embd_gqa (${cacheTypeK}/${cacheTypeV})`
    )
    if (parallel > 1) {
      notes.push(`split across ${parallel} slots: ${contextPerSlot} tokens per conversation`)
    }
  }
  if (compute > 0) {
    notes.push(
      (input.computeProfile ?? 'modern') === 'classic'
        ? `compute: ${(meta.vocabSize ?? 0).toLocaleString()} vocab x ${ubatch} ubatch x 4 bytes`
        : `compute: activations for ${ubatch} ubatch (logits only for emitted tokens)`
    )
  }
  if (overheadMiB > 0) notes.push(`GPU backend reserve: ~${overheadMiB} MiB before any model data`)

  let maxGpuLayers: number | null = null
  if (freeMiB !== null) {
    maxGpuLayers = 0
    for (let n = totalLayers; n >= 0; n--) {
      const p = planVram({ ...input, gpuLayers: n }, null)
      if (p.totalMiB <= freeMiB) {
        maxGpuLayers = n
        break
      }
    }
  }

  return {
    offloadedLayers,
    totalLayers,
    weightsMiB,
    kvCacheMiB,
    computeMiB,
    backendOverheadMiB: overheadMiB,
    totalMiB,
    freeMiB,
    fits: freeMiB === null ? null : totalMiB <= freeMiB,
    maxGpuLayers,
    contextPerSlot,
    slots: parallel,
    moeBlocks: experts.moeBlocks,
    expertsOnCpuMiB: expertsOnCpu / MiB,
    notes
  }
}

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

/**
 * The worst case for a router: the `modelsMax` largest plans resident at
 * once. Each model runs in its own process, so nothing is shared between
 * them — not the weights, not the cache, not the backend's own overhead.
 */
export function routerWorstCase(plans: Array<{ id: string; totalMiB: number }>, modelsMax: number, freeMiB: number | null): { worstCase: string[]; worstCaseMiB: number; fits: boolean | null } {
  const largest = [...plans].sort((a, b) => b.totalMiB - a.totalMiB).slice(0, Math.max(1, modelsMax))
  const worstCaseMiB = largest.reduce((n, p) => n + p.totalMiB, 0)
  return { worstCase: largest.map((p) => p.id), worstCaseMiB, fits: freeMiB === null ? null : worstCaseMiB <= freeMiB }
}
