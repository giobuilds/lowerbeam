import type { GgufMetadata } from './gguf.js'
import type { KvCacheType } from '@shared/types.js'

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
  const embdParams = (meta.vocabSize ?? 0) * (meta.embeddingLength ?? 0)
  const embdBytes =
    embdParams > 0 && meta.parameterCount
      ? Math.min(meta.fileSize * (embdParams / meta.parameterCount), meta.fileSize * 0.5)
      : 0
  const body = meta.fileSize - embdBytes

  // Blocks offload proportionally; the final unit is the output layer.
  const blockShare = blocks > 0 ? (body * Math.min(offloaded, blocks)) / units : 0
  const outputShare = offloaded > blocks ? body / units : 0
  return blockShare + outputShare
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

  const weights = weightBytesOnGpu(meta, input.gpuLayers)
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
    notes
  }
}

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
