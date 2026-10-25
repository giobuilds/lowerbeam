import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { llamaOfferSchema, managedBuildSchema } from '@shared/schema.js'
import { THEME_CHOICES } from '@shared/theme.js'
import { writeFileAtomic, WriteQueue } from './atomicWrite.js'
import { addSample, calibrationSchema, EMPTY_CALIBRATION, type Calibration, type Sample } from './calibration.js'

const settingsSchema = z.object({
  /** Measurements of this machine, learned from runs the app already performs. */
  calibration: calibrationSchema.default(EMPTY_CALIBRATION),
  /** Explicit llama.cpp binary chosen by the user, overriding auto-discovery. */
  binaryPath: z.string().optional(),
  /** The official build downloaded into the data folder, when there is one. */
  managedBuild: managedBuildSchema.nullable().default(null),
  /**
   * Look once a day for a newer official build. Off unless turned on, and it
   * only applies while the selected binary is the managed one.
   */
  llamaUpdateCheck: z.boolean().default(false),
  /** When the last check asked GitHub. Null until the first one, so a restart does not ask again the same day. */
  llamaCheckedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
    .nullable()
    .default(null),
  /** The newer pinned tag from the last check, if it was newer. Null hides the offer. */
  llamaUpdateOffer: llamaOfferSchema.nullable().default(null),
  /** The managed build an update replaced, kept so the person can go back. */
  llamaRollback: managedBuildSchema.nullable().default(null),
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
  /** The server as an API for other programs: fixed port, key, local network. */
  localApi: z
    .object({
      port: z.number().int().min(1024).max(65535).nullable().default(null),
      apiKey: z.string().max(200).regex(/^[\x21-\x7e]*$/, 'printable characters, no spaces').default(''),
      lan: z.boolean().default(false)
    })
    .default({ port: null, apiKey: '', lan: false }),
  /** Whether to look for a new release on GitHub. On unless turned off. */
  updateChecks: z.boolean().default(true),
  /** Light, dark, or whatever the desktop is using. */
  theme: z.enum(THEME_CHOICES).default('system'),
  /** Workspace copies and command outputs of coding runs finished longer ago than this are removed on start. Null keeps them. */
  retentionDays: z.number().int().min(1).max(3650).nullable().default(null),
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
  localApi: { port: null, apiKey: '', lan: false },
  updateChecks: true,
  theme: 'system',
  retentionDays: null,
  managedBuild: null,
  llamaUpdateCheck: false,
  llamaCheckedAt: null,
  llamaUpdateOffer: null,
  llamaRollback: null
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
    const next = { ...this.cache, ...patch }
    // A cleared selection has to leave the key out. Spreading `undefined`
    // keeps it, and the schema would then preserve the old path.
    if ('binaryPath' in patch && patch.binaryPath === undefined) delete next.binaryPath
    this.cache = settingsSchema.parse(next)
    await this.writes.run(() => writeFileAtomic(this.path, JSON.stringify(this.cache, null, 2)))
    return this.cache
  }
}
