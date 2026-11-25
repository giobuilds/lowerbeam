import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic, WriteQueue } from './atomicWrite.js'

/**
 * Remembers the sha256 of a model file so a shared-profile match reads it once.
 * The entry is the path, the size and the modification time. A change on disk
 * hashes again. This is not sent anywhere.
 */

const entrySchema = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.number()
})

const fileSchema = z.object({
  version: z.literal(1).default(1),
  files: z.record(z.string(), entrySchema).default({})
})

type HashFile = z.infer<typeof fileSchema>

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export class ProfileHashes {
  private readonly queue = new WriteQueue()
  private cache: HashFile | null = null

  constructor(
    private readonly path: string,
    private readonly cap = 300
  ) {}

  sha256(filePath: string, size: number, mtimeMs: number): Promise<string> {
    return this.queue.run(() => this.lookup(filePath, size, mtimeMs))
  }

  private async lookup(filePath: string, size: number, mtimeMs: number): Promise<string> {
    await this.ensure()
    const cache = this.cache ?? { version: 1, files: {} }
    this.cache = cache
    const hit = cache.files[filePath]
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha256
    const sha256 = await hashFile(filePath)
    cache.files[filePath] = { size, mtimeMs, sha256, at: Date.now() }
    const entries = Object.entries(cache.files)
    if (entries.length > this.cap) {
      entries.sort((a, b) => a[1].at - b[1].at)
      for (const [key] of entries.slice(0, entries.length - this.cap)) delete cache.files[key]
    }
    await writeFileAtomic(this.path, JSON.stringify(cache))
    return sha256
  }

  private async ensure(): Promise<void> {
    if (this.cache) return
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      this.cache = parsed.success ? parsed.data : { version: 1, files: {} }
    } catch {
      this.cache = { version: 1, files: {} }
    }
  }
}
