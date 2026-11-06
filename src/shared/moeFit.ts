/**
 * Which quant to offer when a mixture-of-experts model does not fit in VRAM.
 *
 * A full offload still wins: more bits, no CPU read. When nothing fits that
 * way, experts can sit in system RAM with attention on the GPU. On an 8 GB
 * card the usual balance is IQ2_M or a Q3. On a 12 GB card it is Q4_K_M.
 * A bigger file is not better here — every extra bit of the active experts
 * is read from system RAM on each token.
 */

/** 12 GB class, and anything larger that still cannot hold the whole file. */
export const HYBRID_Q4_CARD_MIB = 10 * 1024
/** 8 GB class. Below this, no sweet spot is claimed. */
export const HYBRID_SMALL_CARD_MIB = 7 * 1024

const Q4_PREFERENCE = ['Q4_K_M', 'Q4_K', 'Q4_K_S', 'IQ4_XS', 'Q4_0', 'Q4_1']
const SMALL_PREFERENCE = ['IQ2_M', 'Q3_K_M', 'IQ3_M', 'Q3_K_S', 'IQ3_XS', 'IQ2_S', 'IQ2_XS', 'Q2_K', 'Q3_K_L']

export interface RecommendFile {
  path: string
  size: number
  isProjector?: boolean
  isDraft?: boolean
}

export interface RecommendFit {
  verdict?: string
}

/** The quant token in a GGUF name, such as `Q4_K_M` or `IQ2_M`. */
export function quantToken(path: string): string | null {
  const match = path.match(/(?:^|[.\-_])((?:IQ|Q)\d[A-Z0-9_]*|F16|BF16|F32)/i)
  return match?.[1]?.toUpperCase() ?? null
}

/**
 * Largest quant that fits entirely in VRAM, or the hybrid sweet spot for this
 * card when none do. `cardMiB` is the card's total memory when known, else
 * what is free. Null when there is nothing to recommend.
 */
export function recommendedQuant(
  files: readonly RecommendFile[],
  fits: Readonly<Record<string, RecommendFit>>,
  cardMiB: number | null
): string | null {
  const chat = files.filter((file) => !file.isProjector && !file.isDraft)
  const full = chat.filter((file) => fits[file.path]?.verdict === 'full')
  if (full.length > 0) return full.reduce((best, file) => (file.size > best.size ? file : best)).path
  if (cardMiB == null || cardMiB < HYBRID_SMALL_CARD_MIB) return null
  const hybrid = chat.filter((file) => fits[file.path]?.verdict === 'hybrid')
  if (hybrid.length === 0) return null
  const preference = cardMiB >= HYBRID_Q4_CARD_MIB ? Q4_PREFERENCE : SMALL_PREFERENCE
  for (const quant of preference) {
    const hit = hybrid.find((file) => quantToken(file.path) === quant)
    if (hit) return hit.path
  }
  return null
}
