import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import {
  CATALOG_INDEX_URL,
  catalogFileUrl,
  catalogUrlAllowed,
  parseCatalogIndex,
  safeProfileFileName,
  sharedProfileSchema,
  type SharedProfile
} from '@shared/sharedProfile.js'
import { NetworkGate, OfflineError } from './network.js'
import { PRIVATE_DIR, PRIVATE_FILE } from './private.js'
import { PROFILE_CATALOG_PUBLIC_KEY, sha256Bytes, verifyCatalogSignature } from './profileTrust.js'

/** The index is one small JSON file. A profile file is one row. */
const INDEX_MAX_BYTES = 1024 * 1024
const PROFILE_MAX_BYTES = 256 * 1024
const SIG_MAX_BYTES = 1024

export interface CatalogResponse {
  status: number
  body: Uint8Array | null
}

export type CatalogGet = (url: string, signal: AbortSignal) => Promise<CatalogResponse>

/**
 * Read a response body and stop if it grows past `max`.
 * A catalog that will not be kept should not be stored in full first.
 */
export async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.byteLength > max ? null : buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      total += step.value.byteLength
      if (total > max) {
        await reader.cancel()
        return null
      }
      chunks.push(step.value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function defaultGet(url: string, signal: AbortSignal): Promise<CatalogResponse> {
  if (!catalogUrlAllowed(url)) return { status: 0, body: null }
  const res = await fetch(url, {
    redirect: 'manual',
    cache: 'no-store',
    signal,
    headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'Lowerbeam' }
  })
  const max = url === `${CATALOG_INDEX_URL}.sig` ? SIG_MAX_BYTES : url === CATALOG_INDEX_URL ? INDEX_MAX_BYTES : PROFILE_MAX_BYTES
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {})
    return { status: res.status, body: null }
  }
  return { status: res.status, body: await readLimited(res, max) }
}

/**
 * Write bytes so a reader never sees a half-written catalog file.
 * The signature and the sha256 are over these bytes, so they are not re-encoded.
 */
async function writeBytesAtomic(path: string, body: Uint8Array): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, body, { mode: PRIVATE_FILE })
  await rename(temporary, path)
}

function inside(dir: string, name: string): string | null {
  if (!safeProfileFileName(name)) return null
  const root = resolve(dir)
  const dest = resolve(root, name)
  if (dest !== join(root, name)) return null
  return dest
}

/**
 * The signed public catalog, cached after it verifies.
 *
 * A bad signature does not replace a good cache. A file whose bytes do not
 * match the index is skipped. Loading the cache does not touch the network,
 * so it does not light the badge. A fetch goes through the offline switch.
 */
export class ProfileCatalog {
  private verified: SharedProfile[] = []
  private tail: Promise<void> = Promise.resolve()
  private abort: AbortController | null = null
  private readonly get: CatalogGet
  private readonly publicKey: string

  constructor(
    private readonly dir: string,
    private readonly gate: NetworkGate,
    options?: { get?: CatalogGet; publicKey?: string }
  ) {
    this.get = options?.get ?? defaultGet
    this.publicKey = options?.publicKey ?? PROFILE_CATALOG_PUBLIC_KEY
    this.gate.onStop(() => this.abort?.abort())
  }

  rows(): SharedProfile[] {
    return [...this.verified]
  }

  /** Read the last catalog that verified. No network. */
  async load(): Promise<void> {
    try {
      const indexPath = join(this.dir, 'index.json')
      const index = await readFile(indexPath)
      const signature = await readFile(join(this.dir, 'index.json.sig'), 'utf8')
      if (!verifyCatalogSignature(index, signature, this.publicKey)) {
        this.verified = []
        return
      }
      if (index.byteLength > INDEX_MAX_BYTES) {
        this.verified = []
        return
      }
      const parsed = parseCatalogIndex(index)
      if (!parsed) {
        this.verified = []
        return
      }
      const filesDir = join(this.dir, 'files')
      const rows: SharedProfile[] = []
      for (const file of parsed.files) {
        const path = inside(filesDir, file.name)
        if (!path) continue
        const body = await readFile(path).catch(() => null)
        if (!body || body.byteLength > PROFILE_MAX_BYTES) continue
        if (sha256Bytes(body) !== file.sha256) continue
        const row = parseProfile(body)
        if (row) rows.push(row)
      }
      this.verified = rows
    } catch {
      this.verified = []
    }
  }

  /** Fetch the catalog when the switch allows it. A failure keeps the previous rows. */
  refresh(): Promise<void> {
    const job = this.tail.then(() => this.pull())
    this.tail = job.then(
      () => undefined,
      () => undefined
    )
    return job
  }

  /** Cache first, then a refresh if requests are allowed. Does not throw. */
  async start(): Promise<void> {
    try {
      await this.load()
      await this.refresh()
    } catch {
      // The window opens either way. A launch does not need the catalog.
    }
  }

  private async pull(): Promise<void> {
    if (this.gate.isOffline) return
    const controller = new AbortController()
    this.abort = controller
    try {
      const index = await this.fetchBody(CATALOG_INDEX_URL, INDEX_MAX_BYTES, controller.signal)
      if (!index) return
      const sigUrl = `${CATALOG_INDEX_URL}.sig`
      const signature = await this.fetchBody(sigUrl, SIG_MAX_BYTES, controller.signal)
      if (!signature) return
      const sigText = new TextDecoder().decode(signature)
      if (!verifyCatalogSignature(index, sigText, this.publicKey)) return
      const parsed = parseCatalogIndex(index)
      if (!parsed) return
      const accepted: SharedProfile[] = []
      const stored: { name: string; body: Uint8Array }[] = []
      for (const file of parsed.files) {
        const url = catalogFileUrl(file.name)
        if (!url) return
        // A missing response is a failed fetch: keep the previous catalog.
        // Bytes that arrive but do not match the index are a tampered file, and only that file is dropped.
        const body = await this.fetchBody(url, PROFILE_MAX_BYTES, controller.signal)
        if (!body) return
        if (sha256Bytes(body) !== file.sha256) continue
        const row = parseProfile(body)
        if (!row) continue
        accepted.push(row)
        stored.push({ name: file.name, body })
      }
      await this.commit(index, sigText, stored)
      this.verified = accepted
    } catch (err) {
      if (err instanceof OfflineError || controller.signal.aborted) return
      // A dropped connection keeps the last verified rows.
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  /**
   * One catalog URL. Null means this response is not a file we can keep:
   * offline, not 200, or larger than the cap. A thrown error is a transport
   * failure, and the caller then leaves the cache alone.
   */
  private async fetchBody(url: string, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!catalogUrlAllowed(url)) return null
    const got = await this.gate.reach('profiles', () => this.get(url, signal))
    if (got.status !== 200 || !got.body || got.body.byteLength > max) return null
    return got.body
  }

  private async commit(
    index: Uint8Array,
    signature: string,
    files: { name: string; body: Uint8Array }[]
  ): Promise<void> {
    const filesDir = join(this.dir, 'files')
    await mkdir(filesDir, { recursive: true, mode: PRIVATE_DIR })
    const keep = new Set<string>()
    for (const file of files) {
      const dest = inside(filesDir, file.name)
      if (!dest) continue
      await writeBytesAtomic(dest, file.body)
      keep.add(file.name)
    }
    for (const name of await readdir(filesDir).catch(() => [] as string[])) {
      if (keep.has(name) || name.startsWith('.')) continue
      const dest = inside(filesDir, name)
      if (dest) await rm(dest, { force: true })
    }
    await writeBytesAtomic(join(this.dir, 'index.json'), index)
    await writeBytesAtomic(join(this.dir, 'index.json.sig'), Buffer.from(`${signature.trim()}\n`))
  }
}

function parseProfile(body: Uint8Array): SharedProfile | null {
  try {
    const parsed = sharedProfileSchema.safeParse(JSON.parse(new TextDecoder().decode(body)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
