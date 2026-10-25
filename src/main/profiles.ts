import { readFile, stat } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic, WriteQueue } from './atomicWrite.js'
import { launchConfigSchema } from '@shared/schema.js'

/**
 * Remembers, per model, the launch settings that actually worked.
 *
 * The value of a server manager is not having to rediscover that this GGUF
 * needs a smaller context or fewer layers every time you come back to it. A
 * profile is only written once a launch has reached `ready`, so what is stored
 * is a known-good configuration rather than whatever was last typed into the
 * form.
 */

export const profileSchema = z.object({
  /** Stable identity for the model this belongs to. */
  key: z.string(),
  /** Path it was last seen at, for display and as a fallback. */
  modelPath: z.string(),
  modelName: z.string(),
  /** Launch settings minus the model itself, which the key already identifies. */
  config: launchConfigSchema.omit({ modelPath: true }),
  lastUsedAt: z.number(),
  /** How long the last successful launch took to become ready, in ms. */
  loadMs: z.number().nullable().default(null),
  /**
   * Context llama.cpp actually ended up with. Under auto-fit the requested
   * value is unset, so this is the only record of what was chosen.
   */
  actualContext: z.number().nullable().default(null)
})

export type LaunchProfile = z.infer<typeof profileSchema>

const fileSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.record(z.string(), profileSchema).default({})
})

/**
 * Identity is the file's name and size, not its path: moving a model between
 * directories should not lose its settings, while two genuinely different
 * models cannot collide. Falls back to the path if the file cannot be read.
 */
export async function modelKey(modelPath: string): Promise<string> {
  try {
    const s = await stat(modelPath)
    return `${basename(modelPath)}:${s.size}`
  } catch {
    return modelPath
  }
}

export class ProfileStore {
  private cache: z.infer<typeof fileSchema> = { version: 1, profiles: {} }
  /** Serialises writes so one never lands on top of another. */
  private readonly writes = new WriteQueue()

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.cache = fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      this.cache = { version: 1, profiles: {} }
    }
  }

  list(): LaunchProfile[] {
    return Object.values(this.cache.profiles).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  async get(modelPath: string): Promise<LaunchProfile | null> {
    return this.cache.profiles[await modelKey(modelPath)] ?? null
  }

  async put(profile: LaunchProfile): Promise<LaunchProfile> {
    const parsed = profileSchema.parse(profile)
    this.cache.profiles[parsed.key] = parsed
    await this.flush()
    return parsed
  }

  async forget(modelPath: string): Promise<void> {
    await this.forgetKey(await modelKey(modelPath))
  }

  /**
   * Drop the profile stored under a key `modelKey` already returned.
   * Used once a model file is gone: asking for the key again would miss it
   * and fall back to the path.
   */
  async forgetKey(key: string): Promise<void> {
    delete this.cache.profiles[key]
    await this.flush()
  }

  private async flush(): Promise<void> {
    await this.writes.run(() => writeFileAtomic(this.path, JSON.stringify(this.cache, null, 2)))
  }
}
