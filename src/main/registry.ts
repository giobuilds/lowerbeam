import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readGgufMetadata, type GgufMetadata } from './gguf.js'

/** Where GGUF files usually live: llama.cpp's cache, HF's cache, common manual spots. */
export function defaultModelDirs(): string[] {
  const home = process.env['HOME'] ?? ''
  return [
    join(home, '.cache/llama.cpp'),
    join(home, '.cache/huggingface/hub'),
    join(home, 'models'),
    join(home, 'Models'),
    join(home, '.local/share/models')
  ]
}

export interface ModelEntry extends GgufMetadata {
  /** Set when the header could not be read; the entry is still listed. */
  error?: string
  mtimeMs: number
  /**
   * Multimodal projector that belongs with this model, when one sits beside it.
   * Vision models need it passed as --mmproj or they load as text-only.
   */
  projectorPath?: string
}

const MAX_DEPTH = 4

/** Recursively collect .gguf paths, skipping the multi-part shards after the first. */
async function collect(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // missing or unreadable directory is not an error worth surfacing
  }
  for (const e of entries) {
    const path = join(dir, e.name)
    // Hugging Face's cache stores snapshots/<sha>/<name>.gguf as a symlink into
    // blobs/, so a plain isFile() check misses every model downloaded through
    // the HF cache. Symlinks are resolved rather than skipped.
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      try {
        const target = await stat(path)
        isDir = target.isDirectory()
        isFile = target.isFile()
      } catch {
        continue // dangling link
      }
    }
    if (isDir) {
      await collect(path, depth + 1, out)
    } else if (isFile && e.name.toLowerCase().endsWith('.gguf')) {
      // A split model is "-00001-of-00003.gguf"; llama.cpp is handed the first
      // shard and finds the rest itself, so listing the others is just noise.
      const shard = e.name.match(/-(\d{5})-of-\d{5}\.gguf$/i)
      if (shard && shard[1] !== '00001') continue
      out.push(path)
    }
  }
}

/**
 * Scan for models and read each header.
 *
 * Headers are read concurrently but with a small cap: a model directory can hold
 * dozens of files, and opening all of them at once on a spinning disk is slower
 * than a bounded queue.
 */
export async function scanModels(dirs: string[]): Promise<ModelEntry[]> {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const found: string[] = []
    await collect(dir, 0, found)
    for (const p of found) {
      if (!seen.has(p)) {
        seen.add(p)
        paths.push(p)
      }
    }
  }

  const entries: ModelEntry[] = []
  const CONCURRENCY = 4
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++]!
        entries.push(await describe(path))
      }
    })
  )

  return pairProjectors(entries).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Projectors are GGUF files but not models — they cannot be launched alone, so
 * listing them as choices only invites a confusing failure. Each is instead
 * attached to the model it sits beside, which is how llama.cpp expects them to
 * be paired.
 */
export function pairProjectors(entries: ModelEntry[]): ModelEntry[] {
  const projectors = entries.filter((e) => e.isProjector)
  const models = entries.filter((e) => !e.isProjector)
  if (projectors.length === 0) return models

  return models.map((model) => {
    const dir = directoryOf(model.path)
    const siblings = projectors.filter((p) => directoryOf(p.path) === dir)
    if (siblings.length === 0) return model

    // Sharing a directory is not enough. A flat models folder can hold one
    // vision model, its projector and several unrelated text models; handing
    // --mmproj to a text model would be wrong. So the names have to agree.
    const base = strippedName(model.fileName)
    const related = siblings.filter((p) => strippedName(p.fileName) === base)

    // Some repos name the two differently. If the directory holds exactly one
    // model and one projector, they belong together whatever they are called.
    const candidates =
      related.length > 0
        ? related
        : models.filter((m) => directoryOf(m.path) === dir).length === 1
          ? siblings
          : []
    if (candidates.length === 0) return model

    // Among several, prefer the one matching this model's quantisation, then the
    // smallest. VRAM is the binding constraint, a quantised projector is close
    // to lossless, and pairing a Q4 model with an f16 projector is a precision
    // mismatch that can cost several hundred MiB for no visible gain.
    const quant = model.quant?.toLowerCase()
    const matching = quant
      ? candidates.find((p) => p.fileName.toLowerCase().includes(quant))
      : undefined
    const chosen = matching ?? [...candidates].sort((a, b) => a.fileSize - b.fileSize)[0]!
    return { ...model, projectorPath: chosen.path }
  })
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/** "mmproj-SmolVLM-256M-Q8_0.gguf" and "SmolVLM-256M-Q8_0.gguf" both reduce to "smolvlm-256m". */
function strippedName(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, '')
    .replace(/^mmproj[-_.]/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/[.\-_](?:IQ|Q)\d[A-Z0-9_]*$/i, '')
    .replace(/[.\-_](?:F16|BF16|F32|FP16)$/i, '')
    .toLowerCase()
}

/** A file that cannot be parsed is still listed, with the reason attached. */
async function describe(path: string): Promise<ModelEntry> {
  const st = await stat(path).catch(() => null)
  const mtimeMs = st?.mtimeMs ?? 0
  try {
    return { ...(await readGgufMetadata(path)), mtimeMs }
  } catch (err) {
    return {
      path,
      fileName: path.split('/').pop() ?? path,
      fileSize: st?.size ?? 0,
      architecture: 'unknown',
      name: path.split('/').pop()?.replace(/\.gguf$/i, '') ?? path,
      blockCount: null,
      contextLength: null,
      embeddingLength: null,
      headCount: null,
      headCountKv: null,
      quant: null,
      parameterCount: null,
      hasChatTemplate: false,
      vocabSize: null,
      isProjector: /^mmproj[-_.]/i.test(path.split('/').pop() ?? ''),
      feedForwardLength: null,
      keyLength: null,
      valueLength: null,
      expertCount: null,
      expertUsedCount: null,
      expertFeedForwardLength: null,
      fullAttentionInterval: null,
      nextnLayers: null,
      mtimeMs,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export { readGgufMetadata }
