import { basename } from 'node:path'
import { parseGgufHeader } from './gguf.js'
import type { GgufMetadata } from './gguf.js'
import { planVram, type ComputeProfile } from './planner.js'
import type { BinaryInfo, FitVerdict, HfFile, RemoteFit } from '@shared/types.js'
import { estimateSpeed, comfortOf, type MachineProfile } from './speed.js'

/**
 * Works out whether a model will run well on this machine *before* downloading
 * it — which is the question that actually matters when choosing between eight
 * quantisations of the same model.
 *
 * The GGUF header is fetched with an HTTP Range request rather than pulling the
 * whole file: a megabyte carries the architecture, layer count, embedding size
 * and head counts, which is everything the planner needs. Only the tail of the
 * tokenizer arrays is lost, and that barely moves the estimate.
 */

const HEADER_BYTES = 1024 * 1024
const CONTEXT_FOR_ESTIMATE = 4096

function resolveUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Quantisations of one model share a shape, differing only in file_type, so the
 * header is fetched once per base model rather than once per file. Stripping the
 * quant suffix groups them, which also keeps repos holding several different
 * models correct.
 */
export function baseModelName(file: string): string {
  return basename(file)
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/[.\-_](?:IQ|Q)\d[A-Z0-9_]*$/i, '')
    .replace(/[.\-_](?:F16|BF16|F32|FP16)$/i, '')
    .toLowerCase()
}

async function fetchHeader(repo: string, file: string): Promise<Partial<GgufMetadata> | null> {
  try {
    const res = await fetch(resolveUrl(repo, file), {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}` },
      signal: AbortSignal.timeout(20_000)
    })
    // 206 is the expected answer; a 200 means the whole (small) file came back.
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const { kv, arrayLengths } = parseGgufHeader(buf, { allowTruncated: true })
    const arch = typeof kv.get('general.architecture') === 'string'
      ? (kv.get('general.architecture') as string)
      : 'unknown'
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null

    const blockCount = num(kv.get(`${arch}.block_count`))
    if (blockCount === null) return null // without layers there is nothing to plan

    return {
      architecture: arch,
      blockCount,
      contextLength: num(kv.get(`${arch}.context_length`)),
      embeddingLength: num(kv.get(`${arch}.embedding_length`)),
      headCount: num(kv.get(`${arch}.attention.head_count`)),
      headCountKv: num(kv.get(`${arch}.attention.head_count_kv`)),
      vocabSize: arrayLengths.get('tokenizer.ggml.tokens') ?? null,
      feedForwardLength: num(kv.get(`${arch}.feed_forward_length`)),
      keyLength: num(kv.get(`${arch}.attention.key_length`)),
      valueLength: num(kv.get(`${arch}.attention.value_length`)),
      expertCount: num(kv.get(`${arch}.expert_count`)),
      expertUsedCount: num(kv.get(`${arch}.expert_used_count`)),
      expertFeedForwardLength: num(kv.get(`${arch}.expert_feed_forward_length`)),
      fullAttentionInterval: num(kv.get(`${arch}.full_attention_interval`)),
      nextnLayers: num(kv.get(`${arch}.nextn_predict_layers`))
    }
  } catch {
    return null
  }
}

function verdictFor(offloaded: number, total: number): FitVerdict {
  if (offloaded >= total) return 'full'
  if (offloaded > 0) return 'partial'
  return 'cpu'
}

/**
 * Estimate each file in a repo. Headers are fetched once per base model and
 * reused across its quantisations, so a repo with eight quants costs one
 * request rather than eight.
 */
export async function estimateRepoFit(
  repo: string,
  files: HfFile[],
  freeMiB: number | null,
  binary: BinaryInfo,
  /** Measured throughput of this machine; without it no speed is claimed. */
  machine?: MachineProfile
): Promise<RemoteFit[]> {
  const profile: ComputeProfile = binary.kind === 'unified' ? 'modern' : 'classic'
  const hasGpu = binary.devices.length > 0

  const groups = new Map<string, HfFile[]>()
  for (const f of files) {
    const key = baseModelName(f.path)
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }

  const out: RemoteFit[] = []
  await Promise.all(
    [...groups.values()].map(async (group) => {
      // Read the header from the smallest file in the group: same shape, least
      // to transfer if the server ignores the range.
      const smallest = [...group].sort((a, b) => a.size - b.size)[0]!
      const shape = await fetchHeader(repo, smallest.path)

      for (const file of group) {
        if (!shape || freeMiB === null) {
          out.push({
            file: file.path, verdict: 'unknown', totalMiB: null, maxGpuLayers: null, note: null,
            tokensPerSecond: null, comfort: 'unknown', moe: false, placement: 'gpu', speedNotes: []
          })
          continue
        }
        const meta = {
          path: file.path,
          fileName: basename(file.path),
          fileSize: file.size,
          name: basename(file.path),
          quant: null,
          parameterCount: null,
          hasChatTemplate: false,
          ...shape
        } as GgufMetadata

        const plan = planVram(
          {
            meta,
            gpuLayers: 999,
            contextSize: CONTEXT_FOR_ESTIMATE,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            parallel: 1,
            computeProfile: profile,
            hasGpuBackend: hasGpu
          },
          freeMiB
        )
        const offloaded = plan.fits ? plan.totalLayers : (plan.maxGpuLayers ?? 0)
        // Speed is a separate question from fit: a mixture of experts that does
        // not fit in VRAM can still be perfectly usable, and a model that does
        // fit can still be slow.
        const speed = machine ? estimateSpeed(meta, machine) : null
        out.push({
          file: file.path,
          verdict: verdictFor(offloaded, plan.totalLayers),
          totalMiB: Math.round(plan.totalMiB),
          maxGpuLayers: plan.maxGpuLayers,
          note:
            shape.contextLength && shape.contextLength < CONTEXT_FOR_ESTIMATE
              ? `trained for ${shape.contextLength} tokens`
              : null,
          tokensPerSecond: speed?.tokensPerSecond ?? null,
          comfort: comfortOf(speed?.tokensPerSecond ?? null),
          moe: speed?.moe ?? Boolean(shape.expertCount),
          placement: speed?.placement ?? 'gpu',
          speedNotes: speed?.notes ?? []
        })
      }
    })
  )
  return out
}
