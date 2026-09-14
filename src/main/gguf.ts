import { open } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Minimal GGUF metadata reader.
 *
 * Only the header and key/value block are parsed — the tensor data that makes up
 * the bulk of a multi-GB file is never touched, so reading metadata for a whole
 * model directory stays fast. Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

const GGUF_MAGIC = 0x46554747 // "GGUF" little-endian

/** GGUF value type tags, in spec order. */
const enum Gt {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12
}

/**
 * `general.file_type` values. These name the dominant quantisation, which is
 * what a user recognises a model by ("Q4_K_M"), even though a GGUF mixes types.
 */
const FILE_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0'
}

export interface GgufMetadata {
  path: string
  fileName: string
  /** Size of the .gguf on disk, in bytes. */
  fileSize: number
  /** e.g. "qwen2", "llama". From general.architecture. */
  architecture: string
  /** Display name from general.name, falling back to the file name. */
  name: string
  /** Transformer blocks — the unit -ngl counts. */
  blockCount: number | null
  /** Context the model was trained for. */
  contextLength: number | null
  embeddingLength: number | null
  headCount: number | null
  /** KV heads; smaller than headCount for GQA models, which shrinks the KV cache. */
  headCountKv: number | null
  /** Quantisation label, e.g. "Q4_K_M". */
  quant: string | null
  parameterCount: number | null
  /** True when the GGUF carries its own chat template. */
  hasChatTemplate: boolean
  /**
   * Token count from the tokenizer array's length. Drives the logits compute
   * buffer, which on small models is larger than the KV cache.
   */
  vocabSize: number | null
  /**
   * True for a multimodal projector (mmproj). These are GGUF files but not
   * models: they carry a vision encoder that pairs with a language model, and
   * they cannot be launched on their own.
   */
  isProjector: boolean
  /** Feed-forward width. In a mixture of experts this describes the expert block. */
  feedForwardLength: number | null
  /**
   * Explicit attention head dimensions. Some models set these larger than
   * embedding/head_count — Qwen3 uses 128 where the division implies 64 — so
   * assuming the division understates the attention weights by half.
   */
  keyLength: number | null
  valueLength: number | null
  /**
   * Hybrid attention: only every Nth block keeps a KV cache, the rest are
   * linear-attention or state-space blocks with a fixed state. Qwen 3.5
   * sets 4. Null when every block has a cache.
   */
  fullAttentionInterval: number | null
  /** Multi-token-prediction blocks counted in block_count that the server does not run. */
  nextnLayers: number | null
  /** Mixture-of-experts shape. Null on a dense model. */
  expertCount: number | null
  expertUsedCount: number | null
  expertFeedForwardLength: number | null
}

class Cursor {
  offset = 0
  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset
  }
  need(n: number): void {
    if (this.offset + n > this.buf.length) throw new RangeError('gguf: header truncated')
  }
  u8(): number {
    this.need(1)
    return this.buf.readUInt8(this.offset++)
  }
  i8(): number {
    this.need(1)
    return this.buf.readInt8(this.offset++)
  }
  i16(): number {
    this.need(2)
    const v = this.buf.readInt16LE(this.offset)
    this.offset += 2
    return v
  }
  u16(): number {
    this.need(2)
    const v = this.buf.readUInt16LE(this.offset)
    this.offset += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.offset)
    this.offset += 4
    return v
  }
  i32(): number {
    this.need(4)
    const v = this.buf.readInt32LE(this.offset)
    this.offset += 4
    return v
  }
  f32(): number {
    this.need(4)
    const v = this.buf.readFloatLE(this.offset)
    this.offset += 4
    return v
  }
  f64(): number {
    this.need(8)
    const v = this.buf.readDoubleLE(this.offset)
    this.offset += 8
    return v
  }
  /** GGUF lengths are u64; clamp to Number since no real header exceeds 2^53. */
  u64(): number {
    this.need(8)
    const v = this.buf.readBigUInt64LE(this.offset)
    this.offset += 8
    return Number(v)
  }
  i64(): number {
    this.need(8)
    const v = this.buf.readBigInt64LE(this.offset)
    this.offset += 8
    return Number(v)
  }
  str(): string {
    const len = this.u64()
    this.need(len)
    const s = this.buf.toString('utf8', this.offset, this.offset + len)
    this.offset += len
    return s
  }
}

type GgufValue = string | number | boolean | null

function readValue(c: Cursor, type: number): GgufValue {
  switch (type) {
    case Gt.UINT8: return c.u8()
    case Gt.INT8: return c.i8()
    case Gt.UINT16: return c.u16()
    case Gt.INT16: return c.i16()
    case Gt.UINT32: return c.u32()
    case Gt.INT32: return c.i32()
    case Gt.FLOAT32: return c.f32()
    case Gt.BOOL: return c.u8() !== 0
    case Gt.STRING: return c.str()
    case Gt.UINT64: return c.u64()
    case Gt.INT64: return c.i64()
    case Gt.FLOAT64: return c.f64()
    default: throw new Error(`gguf: unsupported value type ${type}`)
  }
}

/**
 * Arrays are skipped rather than materialised: a tokenizer vocabulary is
 * hundreds of thousands of strings, and none of the fields this app needs live
 * inside an array.
 */
/**
 * Skips an array's contents, reporting its length through `onCount` before the
 * skip is attempted.
 *
 * The length is announced early on purpose: a truncated header — as when only
 * the first megabyte has been fetched over HTTP — will throw partway through a
 * large tokenizer array, and the vocabulary size would be lost with it. It is
 * stored in the header before the strings themselves, so it is knowable even
 * when they are not, and a large vocabulary matters: the output projection is
 * read for every token generated.
 */
function skipArray(c: Cursor, onCount: (count: number) => void): number {
  const elemType = c.u32()
  const count = c.u64()
  onCount(count)
  if (elemType === Gt.STRING) {
    for (let i = 0; i < count; i++) c.str()
    return count
  }
  const width = FIXED_WIDTH[elemType]
  if (width === undefined) throw new Error(`gguf: unsupported array type ${elemType}`)
  c.need(width * count)
  c.offset += width * count
  return count
}

const FIXED_WIDTH: Record<number, number> = {
  [Gt.UINT8]: 1, [Gt.INT8]: 1, [Gt.UINT16]: 2, [Gt.INT16]: 2,
  [Gt.UINT32]: 4, [Gt.INT32]: 4, [Gt.FLOAT32]: 4, [Gt.BOOL]: 1,
  [Gt.UINT64]: 8, [Gt.INT64]: 8, [Gt.FLOAT64]: 8
}

/** How much of the file to pull in before giving up on finding the KV block. */
const INITIAL_READ = 1 << 20 // 1 MiB
const MAX_READ = 32 << 20 // 32 MiB — enough for very large tokenizer blocks

export interface GgufHeader {
  kv: Map<string, GgufValue>
  arrayLengths: Map<string, number>
  /** True when the buffer ran out before every key was read. */
  truncated: boolean
}

export interface ParseOptions {
  /**
   * Return the keys read so far instead of throwing when the buffer ends.
   *
   * Used when a header is fetched over HTTP with a Range request: the fields
   * the planner needs (architecture, block count, embedding size, head counts)
   * appear before the tokenizer arrays, which are the bulk of the block. Reading
   * a megabyte and keeping what parsed beats fetching many more megabytes to
   * reach a vocabulary list that barely moves the estimate.
   */
  allowTruncated?: boolean
}

export function parseGgufHeader(buf: Buffer, options: ParseOptions = {}): GgufHeader {
  const c = new Cursor(buf)
  if (c.u32() !== GGUF_MAGIC) throw new Error('gguf: bad magic (not a GGUF file)')
  const version = c.u32()
  if (version < 2 || version > 3) throw new Error(`gguf: unsupported version ${version}`)
  c.u64() // tensor count — not needed here
  const kvCount = c.u64()

  const kv = new Map<string, GgufValue>()
  const arrayLengths = new Map<string, number>()
  let truncated = false
  for (let i = 0; i < kvCount; i++) {
    try {
      const key = c.str()
      const type = c.u32()
      if (type === Gt.ARRAY) {
        // Contents are skipped, but the length is kept — it is the only way to
        // learn the vocabulary size without materialising 150k strings.
        skipArray(c, (count) => arrayLengths.set(key, count))
        kv.set(key, null)
      } else {
        kv.set(key, readValue(c, type))
      }
    } catch (err) {
      if (options.allowTruncated && err instanceof RangeError) {
        truncated = true
        break
      }
      throw err
    }
  }
  return { kv, arrayLengths, truncated }
}

/** "630M" -> 630_000_000, "7B" -> 7_000_000_000. */
export function parseSizeLabel(label: string): number | null {
  const m = label.trim().match(/^([\d.]+)\s*([KMBT])?$/i)
  if (!m) return null
  const scale: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }
  return Number(m[1]) * (m[2] ? (scale[m[2]!.toUpperCase()] ?? 1) : 1)
}

/**
 * A projector declares `general.architecture = clip` and usually
 * `general.type = clip-vision`. The filename is only a fallback, for a header
 * too truncated to carry either.
 */
export function isProjectorHeader(
  architecture: string,
  generalType: GgufValue | undefined,
  fileName: string
): boolean {
  if (architecture === 'clip') return true
  if (typeof generalType === 'string' && generalType.startsWith('clip')) return true
  return /^mmproj[-_.]/i.test(fileName)
}

const num = (v: GgufValue | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export async function readGgufMetadata(path: string): Promise<GgufMetadata> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    let readSize = Math.min(INITIAL_READ, size)
    let header: GgufHeader | null = null
    let lastErr: unknown

    // Grow the window if the KV block runs past it, rather than reading a
    // multi-GB file to find a few hundred bytes of metadata.
    while (readSize <= MAX_READ) {
      const buf = Buffer.alloc(Math.min(readSize, size))
      await fh.read(buf, 0, buf.length, 0)
      try {
        header = parseGgufHeader(buf)
        break
      } catch (err) {
        lastErr = err
        if (!(err instanceof RangeError) || readSize >= size) throw err
        readSize *= 4
      }
    }
    if (!header) throw lastErr ?? new Error('gguf: could not read header')
    const { kv, arrayLengths } = header

    const arch = typeof kv.get('general.architecture') === 'string'
      ? (kv.get('general.architecture') as string)
      : 'unknown'
    const fileType = num(kv.get('general.file_type'))
    const nameVal = kv.get('general.name')
    // Not every GGUF sets general.parameter_count; many carry a size_label
    // like "630M" instead, which is close enough for a display label.
    const sizeLabel = kv.get('general.size_label')

    return {
      path,
      fileName: basename(path),
      fileSize: size,
      architecture: arch,
      name: typeof nameVal === 'string' && nameVal ? nameVal : basename(path, '.gguf'),
      blockCount: num(kv.get(`${arch}.block_count`)),
      contextLength: num(kv.get(`${arch}.context_length`)),
      embeddingLength: num(kv.get(`${arch}.embedding_length`)),
      headCount: num(kv.get(`${arch}.attention.head_count`)),
      headCountKv: num(kv.get(`${arch}.attention.head_count_kv`)),
      quant: fileType !== null ? (FILE_TYPES[fileType] ?? `type ${fileType}`) : null,
      parameterCount:
        num(kv.get('general.parameter_count')) ??
        (typeof sizeLabel === 'string' ? parseSizeLabel(sizeLabel) : null),
      hasChatTemplate: kv.has('tokenizer.chat_template'),
      vocabSize: arrayLengths.get('tokenizer.ggml.tokens') ?? null,
      isProjector: isProjectorHeader(arch, kv.get('general.type'), basename(path)),
      feedForwardLength: num(kv.get(`${arch}.feed_forward_length`)),
      keyLength: num(kv.get(`${arch}.attention.key_length`)),
      valueLength: num(kv.get(`${arch}.attention.value_length`)),
      // Present only on a mixture of experts, and the reason such a model reads
      // far less per token than its size suggests.
      fullAttentionInterval: num(kv.get(`${arch}.full_attention_interval`)),
      nextnLayers: num(kv.get(`${arch}.nextn_predict_layers`)),
      expertCount: num(kv.get(`${arch}.expert_count`)),
      expertUsedCount: num(kv.get(`${arch}.expert_used_count`)),
      expertFeedForwardLength: num(kv.get(`${arch}.expert_feed_forward_length`))
    }
  } finally {
    await fh.close()
  }
}
