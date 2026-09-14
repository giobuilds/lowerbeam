import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { capabilityFor, type CapabilityStatus } from '@shared/capability.js'
import { writeFileAtomic } from '../atomicWrite.js'

/**
 * Which model this is, for the capability record.
 *
 * The record is keyed by the file's SHA-256, since a model is its file and a
 * different quantisation is a different model. Hashing six gigabytes takes
 * seconds, so it is done once per file and remembered against the file's
 * size and modification time; a file that has changed is hashed again. The
 * name is not identity — a renamed file is the same model, a re-quantised
 * one with the same name is not.
 */
interface HashCache {
  [path: string]: { bytes: number; mtimeMs: number; sha256: string }
}

export class ModelIdentifier {
  private cache: HashCache | null = null
  private readonly inFlight = new Map<string, Promise<CapabilityStatus>>()

  constructor(private readonly cacheFile: string) {}

  /** What the record says about the model at `path`, hashing it if this is the first time. */
  status(path: string | null | undefined): Promise<CapabilityStatus> {
    if (!path) return Promise.resolve({ state: 'none' })
    const running = this.inFlight.get(path)
    if (running) return running
    const p = this.identify(path).finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, p)
    return p
  }

  private async identify(path: string): Promise<CapabilityStatus> {
    const info = await stat(path)
    const cache = await this.load()
    const held = cache[path]
    const sha256 =
      held && held.bytes === info.size && held.mtimeMs === info.mtimeMs ? held.sha256 : await this.hash(path, info.size, info.mtimeMs)
    const record = capabilityFor(sha256)
    return record
      ? { state: 'measured', path, bytes: info.size, sha256, record }
      : { state: 'unmeasured', path, bytes: info.size, sha256 }
  }

  private async hash(path: string, bytes: number, mtimeMs: number): Promise<string> {
    const sha256 = await sha256Of(path)
    const cache = await this.load()
    cache[path] = { bytes, mtimeMs, sha256 }
    await writeFileAtomic(this.cacheFile, JSON.stringify(cache, null, 2))
    return sha256
  }

  private async load(): Promise<HashCache> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await readFile(this.cacheFile, 'utf8')) as HashCache
    } catch {
      this.cache = {}
    }
    return this.cache
  }
}

export function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}
