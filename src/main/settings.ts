import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic, WriteQueue } from './atomicWrite.js'
import { addSample, calibrationSchema, EMPTY_CALIBRATION, type Calibration, type Sample } from './calibration.js'

const settingsSchema = z.object({
  /** Measurements of this machine, learned from runs the app already performs. */
  calibration: calibrationSchema.default(EMPTY_CALIBRATION),
  /** Explicit llama.cpp binary chosen by the user, overriding auto-discovery. */
  binaryPath: z.string().optional(),
  /** The project the Coding tab last had open. */
  lastProject: z.string().optional(),
  /** Model Context Protocol servers the user has configured. */
  mcpServers: z
    .array(
      z.object({
        id: z.string().min(1).max(40).regex(new RegExp('^[a-z0-9-]+$')),
        name: z.string().min(1).max(80),
        command: z.string().min(1).max(200),
        args: z.array(z.string().max(400)).max(40).default([]),
        env: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().default(false)
      })
    )
    .default([]),
  /**
   * A SearXNG instance to search through instead of the default engine.
   * A self-hosted one has no rate limit, which the default very much does.
   */
  searxngUrl: z.string().max(300).default(''),
  /** Saved system prompts, to start or steer a conversation from. */
  promptPresets: z
    .array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(80), text: z.string().max(20_000) }))
    .max(50)
    .default([]),
  /** Whether to look for a new release on GitHub. On unless turned off. */
  updateChecks: z.boolean().default(true),
  /** Extra directories to scan for GGUF files, beyond the defaults. */
  modelDirs: z.array(z.string()).default([]),
  /**
   * Recently finished downloads.
   *
   * Kept on disk because the list is a record of what you fetched, not of what
   * this session happened to do: after a restart an empty panel reads as
   * "nothing was ever downloaded", which is untrue and unhelpful.
   */
  downloadHistory: z
    .array(
      z.object({
        id: z.string(),
        repo: z.string(),
        file: z.string(),
        expectedBytes: z.number(),
        receivedBytes: z.number(),
        state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']),
        error: z.string().nullable(),
        modelPath: z.string().nullable(),
        startedAt: z.number(),
        finishedAt: z.number().nullable()
      })
    )
    .default([])
})

export type Settings = z.infer<typeof settingsSchema>
export type { Calibration }

const DEFAULTS: Settings = {
  modelDirs: [],
  calibration: EMPTY_CALIBRATION,
  downloadHistory: [],
  mcpServers: [],
  searxngUrl: '',
  promptPresets: [],
  updateChecks: true
}

/** Small JSON-backed settings file. Corrupt or missing files fall back to defaults. */
export class SettingsStore {
  private cache: Settings = DEFAULTS
  /** Serialises writes so one never lands on top of another. */
  private readonly writes = new WriteQueue()

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    try {
      this.cache = settingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      this.cache = DEFAULTS
    }
    return this.cache
  }

  get current(): Settings {
    return this.cache
  }

  /**
   * Record a measurement of this machine.
   *
   * Bandwidth needs weights read per token and the time it took; two samples of
   * different sizes also separate fixed per-token overhead from bandwidth, which
   * is what sets the ceiling for small models.
   */
  async observe(sample: Omit<Sample, 'at'>): Promise<void> {
    if (sample.secondsPerToken <= 0 || sample.activeBytes <= 0) return
    await this.patch({
      calibration: addSample(this.cache.calibration, { ...sample, at: Date.now() })
    })
  }

  async patch(patch: Partial<Settings>): Promise<Settings> {
    this.cache = settingsSchema.parse({ ...this.cache, ...patch })
    await this.writes.run(() => writeFileAtomic(this.path, JSON.stringify(this.cache, null, 2)))
    return this.cache
  }
}
