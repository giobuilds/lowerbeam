import { z } from 'zod'
import { KV_CACHE_TYPES } from './types.js'

/**
 * Anything arriving from the renderer is untrusted input to a process that
 * spawns subprocesses, so it gets validated here before the supervisor sees it.
 */
export const launchConfigSchema = z.object({
  modelPath: z.string().min(1),
  autoFit: z.boolean(),
  gpuLayers: z.number().int().min(0).max(9999),
  contextSize: z.number().int().min(0).max(1 << 22),
  flashAttn: z.boolean(),
  noWarmup: z.boolean(),
  cacheTypeK: z.enum(KV_CACHE_TYPES),
  cacheTypeV: z.enum(KV_CACHE_TYPES),
  parallel: z.number().int().min(1).max(64),
  threads: z.number().int().min(-1).max(1024),
  mmprojPath: z.string().nullable(),
  alias: z.string().max(200).optional(),
  extraArgs: z.string().max(4000)
})

export type LaunchConfigInput = z.infer<typeof launchConfigSchema>

/** Persisted supervisor handoff file, used to adopt or reap a server across restarts. */
export const serverHandoffSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  startedAt: z.number(),
  config: launchConfigSchema
})

export type ServerHandoff = z.infer<typeof serverHandoffSchema>

/** A benchmark sweep requested from the renderer. */
export const benchRequestSchema = z.object({
  modelPath: z.string().min(1),
  nPrompt: z.number().int().min(0).max(1 << 20),
  nGen: z.number().int().min(0).max(1 << 20),
  repetitions: z.number().int().min(1).max(20),
  gpuLayers: z.array(z.number().int().min(-1).max(9999)).max(12),
  threads: z.array(z.number().int().min(1).max(1024)).max(12),
  cacheTypes: z.array(z.enum(KV_CACHE_TYPES)).max(9),
  flashAttn: z.array(z.enum(['on', 'off', 'auto'])).max(3),
  ubatch: z.array(z.number().int().min(1).max(1 << 16)).max(8)
})

/**
 * A tool invocation from the renderer.
 *
 * The arguments come from model output, so they are shape-checked before
 * anything acts on them rather than trusted because a model produced them.
 */
/**
 * MCP server configurations from the renderer.
 *
 * These become spawned subprocesses, so the shape is checked rather than
 * trusted: the id in particular namespaces tool names.
 */
export const mcpServersSchema = z.array(
  z.object({
    id: z.string().min(1).max(40).regex(new RegExp('^[a-z0-9-]+$'), 'lowercase letters, digits and dashes only'),
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(400)).max(40).default([]),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(false)
  })
).max(20)

/** Where the reading pane sits in the window, in device-independent pixels. */
export const readerBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(0),
  height: z.number().int().min(0)
})

/** A coding run: one project, one question. The grant is checked separately. */
export const codingStartSchema = z.object({
  projectRoot: z.string().min(1).max(4096),
  task: z.string().min(1).max(4000),
  mode: z.enum(['inspect', 'edit', 'run']).default('inspect'),
  grant: z
    .object({
      alsoRead: z.array(z.string().min(1).max(4096)).max(8).default([]),
      network: z.boolean().default(false),
      install: z.boolean().default(false)
    })
    .optional()
})

export const toolRunSchema = z.object({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({})
})

/** A download request from the renderer. */
export const downloadRequestSchema = z.object({
  // Repo ids are "org/name"; anything else would be interpolated into a
  // filesystem path and a subprocess argument.
  repo: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'expected a Hugging Face repo id like org/name'),
  file: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9._\/-]+\.gguf$/i, 'expected a .gguf file name')
    .refine((f) => !f.includes('..'), 'path traversal is not allowed'),
  expectedBytes: z.number().int().min(0)
})

/** A binary verification request from the renderer. */
export const healthCheckRequestSchema = z.object({
  modelPath: z.string().min(1),
  gpuLayers: z.number().int().min(0).max(9999)
})

/** A VRAM planning request from the renderer. */
export const planRequestSchema = z.object({
  modelPath: z.string().min(1),
  gpuLayers: z.number().int().min(0).max(9999),
  contextSize: z.number().int().min(1).max(1 << 22),
  cacheTypeK: z.enum(KV_CACHE_TYPES),
  cacheTypeV: z.enum(KV_CACHE_TYPES),
  parallel: z.number().int().min(1).max(64)
})
