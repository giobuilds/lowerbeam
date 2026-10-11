import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { ToolDefinition } from '@shared/types.js'
import type { AgentToolResult } from '@shared/coding.js'
import { authHeaders } from '@shared/chatClient.js'
import { Grant } from './grant.js'

/**
 * Find project code by what it is about, and return path:line excerpts.
 *
 * This is a coding tool. It walks the grant the way search does — the same
 * hidden folders, the same size cap, the same refusal of binary files — and
 * ranks short spans with a CPU embedding model the router already serves.
 * It does not upload documents, and it does not put retrieved text into the
 * prompt by itself: the model has to call it, and it gets excerpts, not files.
 *
 * Vectors are remembered for this process, keyed by the file's size and
 * mtime. A coding run's loop lives in one utility process, so the memory
 * lasts for that run and is gone when it is. Nothing is written into the
 * project.
 */

/** Lines in one span, and how many of the previous span the next one repeats. */
export const FIND_CHUNK_LINES = 40
export const FIND_CHUNK_OVERLAP = 8
/** Same bounds as search, so find cannot see a file search cannot. */
const FIND_MAX_HITS = 30
const FIND_MAX_FILES = 5000
const FIND_MAX_FILE_BYTES = 512 * 1024
const FIND_EXCERPT_CHARS = 200
const FIND_BATCH = 32

export interface CodeChunk {
  path: string
  /** 1-based line where this span starts. */
  line: number
  text: string
}

export const FIND_TOOL: ToolDefinition = {
  name: 'find',
  label: 'Find by meaning',
  description:
    'Find project code related to a description, when the words themselves may differ. ' +
    'Returns up to 30 hits as path:line with a short excerpt, the same shape as search. ' +
    'It only looks at this project. It does not search documents outside the project.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the code is about, in ordinary words.' }
    },
    required: ['query']
  }
}

/** Spans of about forty lines. A short file is one span. Empty text is none. */
export function chunkSource(
  path: string,
  text: string,
  lines = FIND_CHUNK_LINES,
  overlap = FIND_CHUNK_OVERLAP
): CodeChunk[] {
  const all = text.split('\n')
  const step = Math.max(1, lines - overlap)
  const out: CodeChunk[] = []
  for (let start = 0; start < all.length; start += step) {
    const slice = all.slice(start, start + lines)
    const body = slice.join('\n').trim()
    if (body) {
      const offset = slice.findIndex((line) => line.trim() !== '')
      out.push({ path, line: start + 1 + Math.max(0, offset), text: body })
    }
    if (start + lines >= all.length) break
  }
  return out
}

/** Cosine similarity. A zero-length vector is no match, not an error. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Highest cosine first. Equal scores keep path, then line, so a draw is stable. */
export function rankChunks<T extends { path: string; line: number; vector: number[] }>(
  query: number[],
  items: T[],
  limit: number
): T[] {
  return items
    .map((item) => ({ item, score: cosine(query, item.vector) }))
    .sort((a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path) || a.item.line - b.item.line)
    .slice(0, limit)
    .map((row) => row.item)
}

/**
 * Vectors from `POST /v1/embeddings`, in input order.
 * The server may return `data` sorted by `index` or not; either is accepted.
 * A short or empty vector is a refusal, not a guess.
 */
export function vectorsInOrder(
  data: Array<{ index?: number; embedding?: number[] }> | undefined,
  count: number
): number[][] | null {
  if (!data || data.length !== count) return null
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const vectors: number[][] = []
  for (let i = 0; i < count; i++) {
    const embedding = ordered[i]?.embedding
    if (!embedding || embedding.length === 0) return null
    vectors.push(embedding)
  }
  return vectors
}

export async function embedTexts(opts: {
  baseUrl: string
  apiKey: string | null
  model: string
  input: string[]
  signal?: AbortSignal
}): Promise<number[][]> {
  if (opts.input.length === 0) return []
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ model: opts.model, input: opts.input }),
    signal: opts.signal
  })
  if (!res.ok) throw new Error(`The embedding model refused the request (HTTP ${res.status}).`)
  const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
  const vectors = vectorsInOrder(body.data, opts.input.length)
  if (!vectors) throw new Error('The embedding model returned an unexpected response.')
  return vectors
}

interface CachedFile {
  mtimeMs: number
  size: number
  chunks: CodeChunk[]
  vectors: number[][]
}

/** One run's vectors. The key is the grant plus the path, so a copy does not reuse the project's. */
const cache = new Map<string, CachedFile>()

export interface FindOptions {
  grant: Grant
  query: string
  baseUrl: string
  apiKey: string | null
  /** The router model id that embeds. Empty means the tool has nothing to ask. */
  model: string
  signal?: AbortSignal
  /** A test supplies vectors directly. Absent, the running server is asked. */
  embed?: (input: string[]) => Promise<number[][]>
}

interface RankedChunk {
  path: string
  line: number
  text: string
  vector: number[]
}

export async function findInGrant(opts: FindOptions): Promise<AgentToolResult> {
  const query = opts.query.trim()
  if (!query) return { ok: false, content: 'Give something to find.' }
  if (!opts.model.trim()) return { ok: false, content: 'No embedding model is available.' }
  const embed =
    opts.embed ??
    ((input: string[]) =>
      embedTexts({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        input,
        signal: opts.signal
      }))
  try {
    const chunks = await indexedChunks(opts.grant, embed, opts.signal)
    if (chunks.length === 0) return { ok: true, content: 'No project text to search.' }
    if (opts.signal?.aborted) return { ok: false, content: 'The run was stopped.' }
    const [queryVec] = await embed([query])
    if (!queryVec) return { ok: false, content: 'The embedding model returned an unexpected response.' }
    const ranked = rankChunks(queryVec, chunks, FIND_MAX_HITS)
    const lines = ranked.map((chunk) => `${chunk.path}:${chunk.line}: ${excerpt(chunk.text)}`)
    const more = chunks.length > FIND_MAX_HITS ? `\n(first ${FIND_MAX_HITS} hits)` : ''
    return { ok: true, content: lines.join('\n') + more }
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, content: 'The run was stopped.' }
    return { ok: false, content: err instanceof Error ? err.message : String(err) }
  }
}

async function indexedChunks(
  grant: Grant,
  embed: (input: string[]) => Promise<number[][]>,
  signal?: AbortSignal
): Promise<RankedChunk[]> {
  const files: string[] = []
  await walk(grant.realRoot, files)
  const ready: RankedChunk[] = []
  const pending: Array<{ key: string; mtimeMs: number; size: number; chunks: CodeChunk[] }> = []
  for (const abs of files) {
    if (signal?.aborted) break
    const rel = grant.nameFor(abs).split(sep).join('/')
    if (!rel || rel === '.') continue
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > FIND_MAX_FILE_BYTES) continue
    const key = `${grant.realRoot}\0${rel}`
    const hit = cache.get(key)
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      hit.chunks.forEach((chunk, i) => {
        const vector = hit.vectors[i]
        if (vector) ready.push({ path: chunk.path, line: chunk.line, text: chunk.text, vector })
      })
      continue
    }
    const text = await readProjectText(abs)
    if (text === null) continue
    const chunks = chunkSource(rel, text)
    if (chunks.length === 0) continue
    pending.push({ key, mtimeMs: info.mtimeMs, size: info.size, chunks })
  }
  const texts = pending.flatMap((file) => file.chunks.map((chunk) => chunk.text))
  const vectors = await embedBatched(texts, embed, signal)
  if (vectors.length !== texts.length) throw new Error('The embedding model returned an unexpected response.')
  let at = 0
  for (const file of pending) {
    const slice = vectors.slice(at, at + file.chunks.length)
    at += file.chunks.length
    cache.set(file.key, { mtimeMs: file.mtimeMs, size: file.size, chunks: file.chunks, vectors: slice })
    file.chunks.forEach((chunk, i) => {
      const vector = slice[i]
      if (vector) ready.push({ path: chunk.path, line: chunk.line, text: chunk.text, vector })
    })
  }
  return ready
}

async function embedBatched(
  texts: string[],
  embed: (input: string[]) => Promise<number[][]>,
  signal?: AbortSignal
): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += FIND_BATCH) {
    if (signal?.aborted) throw new Error('The run was stopped.')
    const batch = texts.slice(i, i + FIND_BATCH)
    const vectors = await embed(batch)
    if (vectors.length !== batch.length) throw new Error('The embedding model returned an unexpected response.')
    out.push(...vectors)
  }
  return out
}

async function walk(abs: string, files: string[]): Promise<void> {
  if (files.length >= FIND_MAX_FILES) return
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= FIND_MAX_FILES) return
    const child = join(abs, entry.name)
    // A link can name something outside the grant. Search does not follow
    // one either: the name is not a file or a directory of this tree.
    if (entry.isSymbolicLink()) continue
    if (!Grant.visibleAt(child)) continue
    if (entry.isDirectory()) await walk(child, files)
    else if (entry.isFile()) files.push(child)
  }
}

/** Text, or null when the file looks binary. The probe is the one search uses. */
async function readProjectText(abs: string): Promise<string | null> {
  let handle
  try {
    handle = await open(abs, 'r')
    const probe = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    if (probe.subarray(0, bytesRead).includes(0)) return null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

function excerpt(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > FIND_EXCERPT_CHARS ? trimmed.slice(0, FIND_EXCERPT_CHARS) + '…' : trimmed
}
