import { z } from 'zod'
import { KV_CACHE_TYPES, DEFAULT_LAUNCH_CONFIG, type KvCacheType, type LaunchConfig } from './types.js'

/**
 * A public launch profile is only a starting point.
 *
 * The catalog is a signed list of JSON files. A match fills the launch form.
 * It is not saved as this machine's profile until a launch here reaches ready,
 * and a profile this machine already measured is never replaced by one.
 */

export const SHARED_PROFILE_SCHEMA = 1

/** How far a llama.cpp build can be from the measured one before the form says so. */
export const BUILD_DISTANCE = 500

/** VRAM gap that still counts as the same class of card. */
export const CLOSE_VRAM_MIB = 256

const SHA256 = /^[a-f0-9]{64}$/
const PCI_ID = /^0x[0-9a-f]{4}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

/** A catalog file name: one path segment, never `..`. */
export function safeProfileFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.includes('..')
}

const sha256Schema = z.string().regex(SHA256)
const fileNameSchema = z.string().regex(FILE_NAME).refine((name) => !name.includes('..'))

export const sharedProfileSchema = z
  .object({
    schema: z.literal(SHARED_PROFILE_SCHEMA),
    gpu: z
      .object({
        vendorId: z.string().regex(PCI_ID),
        deviceId: z.string().regex(PCI_ID),
        name: z.string().min(1).max(200),
        vramMiB: z.number().int().min(0).max(1_000_000),
        backend: z.enum(['vulkan', 'cpu']),
        driver: z.string().max(200).optional()
      })
      .strict(),
    model: z
      .object({
        sha256: sha256Schema,
        file: z.string().min(1).max(300),
        arch: z.string().min(1).max(80),
        paramsB: z.number().positive().max(10_000),
        quant: z.string().min(1).max(40),
        bytes: z.number().int().nonnegative()
      })
      .strict(),
    llamacpp: z
      .object({
        build: z.number().int().nonnegative(),
        minBuild: z.number().int().nonnegative()
      })
      .strict(),
    launch: z
      .object({
        fit: z.boolean(),
        ctx: z.number().int().min(0).max(1 << 22).nullable(),
        gpuLayers: z.number().int().min(0).max(9999).nullable(),
        parallel: z.number().int().min(1).max(64).nullable(),
        kvType: z.enum(KV_CACHE_TYPES).nullable(),
        flashAttn: z.enum(['on', 'off']),
        mmproj: z.enum(['gpu', 'cpu', 'off']),
        spec: z.enum(['off', 'mtp', 'ngram', 'draft'])
      })
      .strict(),
    measured: z
      .object({
        genTokPerSec: z.number().positive().nullable(),
        promptTokPerSec: z.number().positive().nullable(),
        peakVramMiB: z.number().int().nonnegative().nullable(),
        contextGot: z.number().int().nonnegative().nullable(),
        on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        runs: z.number().int().positive()
      })
      .strict(),
    source: z
      .object({
        kind: z.string().min(1).max(40),
        ref: z.string().max(200),
        reports: z.number().int().nonnegative(),
        days: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()

export type SharedProfile = z.infer<typeof sharedProfileSchema>

export const catalogIndexSchema = z
  .object({
    schema: z.literal(SHARED_PROFILE_SCHEMA),
    files: z
      .array(
        z
          .object({
            name: fileNameSchema,
            sha256: sha256Schema
          })
          .strict()
      )
      .max(200)
  })
  .strict()

export type CatalogIndex = z.infer<typeof catalogIndexSchema>

export const CATALOG_INDEX_URL = 'https://raw.githubusercontent.com/giobuilds/lowerbeam-profiles/main/index.json'

const CATALOG_PREFIX = '/giobuilds/lowerbeam-profiles/main/'

/** The only host a catalog fetch may use. File names from the index are appended, not trusted as URLs. */
export function catalogUrlAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname !== 'raw.githubusercontent.com') return false
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return false
  if (parsed.search !== '' || parsed.hash !== '') return false
  if (!parsed.pathname.startsWith(CATALOG_PREFIX)) return false
  if (parsed.pathname.includes('..') || parsed.pathname.includes('//') || parsed.pathname.includes('\\')) return false
  const rest = parsed.pathname.slice(CATALOG_PREFIX.length)
  return safeProfileFileName(rest)
}

export function catalogFileUrl(name: string): string | null {
  if (!safeProfileFileName(name)) return null
  const url = `https://raw.githubusercontent.com${CATALOG_PREFIX}${name}`
  return catalogUrlAllowed(url) ? url : null
}

export function parseCatalogIndex(body: Uint8Array): CatalogIndex | null {
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(body))
    const parsed = catalogIndexSchema.safeParse(json)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface MatchMachine {
  vendorId: string | null
  deviceId: string | null
  vramMiB: number
  /** Null when this binary is CUDA, ROCm, or anything the catalog does not describe. */
  backend: 'vulkan' | 'cpu' | null
  build: number | null
  driver: string | null
}

export interface MatchModel {
  sha256: string | null
  arch: string | null
  quant: string | null
  paramsB: number | null
}

export interface SharedMatch {
  kind: 'exact' | 'close' | 'loose'
  profile: SharedProfile
  buildWarning: string | null
  driverNote: string | null
}

/** What the Server panel shows, and the profile it may turn into a launch. */
export interface SharedProfileOffer {
  kind: SharedMatch['kind']
  summary: string
  buildWarning: string | null
  driverNote: string | null
  profile: SharedProfile
  genTokPerSec: number | null
}

/**
 * Backend the catalog can name.
 * The managed build's own label wins when that binary is selected. Otherwise
 * a Vulkan device id is vulkan, no device is cpu, and CUDA or ROCm is no match.
 */
export function matchBackend(input: {
  managedBackend: 'vulkan' | 'cpu' | null
  deviceIds: readonly string[]
}): 'vulkan' | 'cpu' | null {
  if (input.managedBackend === 'vulkan' || input.managedBackend === 'cpu') return input.managedBackend
  if (input.deviceIds.length === 0) return 'cpu'
  const id = input.deviceIds[0] ?? ''
  if (/^vulkan/i.test(id)) return 'vulkan'
  return null
}

/** The sensor's VRAM when it has one, else the llama.cpp device, else nothing to compare. */
export function matchVram(sensorMiB: number | null, deviceMiB: number | null): number {
  if (sensorMiB !== null && sensorMiB > 0) return sensorMiB
  if (deviceMiB !== null && deviceMiB > 0) return deviceMiB
  return 0
}

export function vramBucket(vramMiB: number): number {
  return Math.round(vramMiB / 2048)
}

/**
 * Hash a model file only when some catalog row claims this name and size.
 * The sha256 is what an exact or close match needs, and a full read of a
 * multi-gigabyte GGUF is not worth doing for a file the catalog never named.
 */
export function shouldHashModel(rows: readonly SharedProfile[], fileName: string, bytes: number): boolean {
  return rows.some((row) => row.model.file === fileName && row.model.bytes === bytes)
}

function sameCard(profile: SharedProfile, machine: MatchMachine): boolean {
  return (
    machine.vendorId !== null &&
    machine.deviceId !== null &&
    profile.gpu.vendorId === machine.vendorId &&
    profile.gpu.deviceId === machine.deviceId
  )
}

function sameFile(profile: SharedProfile, model: MatchModel): boolean {
  return model.sha256 !== null && profile.model.sha256 === model.sha256
}

function paramsNear(profileB: number, modelB: number): boolean {
  const scale = Math.max(Math.abs(profileB), Math.abs(modelB))
  if (scale === 0) return false
  return Math.abs(profileB - modelB) / scale <= 0.1
}

function looseRow(profile: SharedProfile, machine: MatchMachine, model: MatchModel): boolean {
  if (vramBucket(profile.gpu.vramMiB) !== vramBucket(machine.vramMiB)) return false
  if (!model.arch || profile.model.arch !== model.arch) return false
  if (!model.quant || profile.model.quant !== model.quant) return false
  if (model.paramsB === null) return false
  return paramsNear(profile.model.paramsB, model.paramsB)
}

function driverMajor(driver: string | null | undefined): string | null {
  if (!driver) return null
  return /(\d+)/.exec(driver)?.[1] ?? null
}

function buildWarning(profile: SharedProfile, machineBuild: number | null): string | null {
  if (machineBuild === null) return null
  if (Math.abs(machineBuild - profile.llamacpp.build) > BUILD_DISTANCE) {
    return `This profile was measured on llama.cpp build ${profile.llamacpp.build}. This machine is build ${machineBuild}.`
  }
  if (machineBuild < profile.llamacpp.minBuild) {
    return `This profile asks for llama.cpp build ${profile.llamacpp.minBuild} or newer. This machine is build ${machineBuild}.`
  }
  return null
}

function driverNote(profileDriver: string | undefined, machineDriver: string | null): string | null {
  const published = driverMajor(profileDriver)
  const here = driverMajor(machineDriver)
  if (!published || !here || published === here || !profileDriver || !machineDriver) return null
  return `Measured with driver ${profileDriver}. This machine reports ${machineDriver}.`
}

function summaryFor(kind: SharedMatch['kind']): string {
  if (kind === 'exact') return 'Starting from a shared profile for this GPU and model.'
  if (kind === 'close') return 'Close match: a shared profile for a card with similar VRAM. It is only a starting point.'
  return 'A suggestion only. A shared profile for this kind of card and model is not applied.'
}

/**
 * Strictest match in the catalog, first row winning inside a tier.
 * Exact and close need the model sha256. Loose is a label, not a launch.
 */
export function matchShared(
  rows: readonly SharedProfile[],
  machine: MatchMachine,
  model: MatchModel
): SharedMatch | null {
  if (machine.backend === null) return null
  const sameBackend = rows.filter((row) => row.gpu.backend === machine.backend)
  const exact = sameBackend.find((row) => sameCard(row, machine) && sameFile(row, model))
  const close = exact
    ? undefined
    : sameBackend.find(
        (row) => Math.abs(row.gpu.vramMiB - machine.vramMiB) <= CLOSE_VRAM_MIB && sameFile(row, model)
      )
  const loose = exact || close ? undefined : sameBackend.find((row) => looseRow(row, machine, model))
  const hit = exact ?? close ?? loose
  if (!hit) return null
  const kind: SharedMatch['kind'] = exact ? 'exact' : close ? 'close' : 'loose'
  return {
    kind,
    profile: hit,
    buildWarning: buildWarning(hit, machine.build),
    driverNote: driverNote(hit.gpu.driver, machine.driver)
  }
}

/** A measured profile on this machine hides the shared one completely. */
export function sharedOffer(hasLocal: boolean, match: SharedMatch | null): SharedProfileOffer | null {
  if (hasLocal || !match) return null
  return {
    kind: match.kind,
    summary: summaryFor(match.kind),
    buildWarning: match.buildWarning,
    driverNote: match.driverNote,
    profile: match.profile,
    genTokPerSec: match.profile.measured.genTokPerSec
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Launch settings from a shared profile.
 * `--fit` only adjusts flags that were left unset, so a fit profile does not
 * also write a context or a layer count. A loose match must not call this.
 */
export function launchFromShared(
  profile: SharedProfile,
  modelPath: string,
  projectorPath: string | null
): LaunchConfig {
  const launch = profile.launch
  const config: LaunchConfig = {
    ...DEFAULT_LAUNCH_CONFIG,
    modelPath,
    mmprojPath: projectorPath,
    flashAttn: launch.flashAttn === 'on',
    speculative: launch.spec
  }
  if (launch.fit) {
    config.autoFit = true
  } else {
    config.autoFit = false
    if (launch.ctx !== null) config.contextSize = clampInt(launch.ctx, 0, 1 << 22)
    if (launch.gpuLayers !== null) config.gpuLayers = clampInt(launch.gpuLayers, 0, 9999)
  }
  if (launch.parallel !== null) config.parallel = clampInt(launch.parallel, 1, 64)
  if (launch.kvType !== null) {
    const kv: KvCacheType = launch.kvType
    config.cacheTypeK = kv
    config.cacheTypeV = kv
  }
  if (launch.mmproj === 'off') {
    config.mmprojPath = null
    config.mmprojOffload = false
  } else if (launch.mmproj === 'cpu') {
    config.mmprojOffload = false
  } else {
    config.mmprojOffload = true
  }
  return config
}

/** Exact and close fill the form. A suggestion does not. */
export function draftFromOffer(
  offer: SharedProfileOffer | null,
  modelPath: string,
  projectorPath: string | null
): LaunchConfig | null {
  if (!offer || offer.kind === 'loose') return null
  return launchFromShared(offer.profile, modelPath, projectorPath)
}

export function formatTokPerSec(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function comparisonLine(said: number, got: number): string {
  return `Shared profile says ${formatTokPerSec(said)} tok/s. This machine got ${formatTokPerSec(got)}.`
}

const ISSUE_FORM = 'https://github.com/giobuilds/lowerbeam/issues/new'
const FIELD_MAX = 500

function clip(value: string): string {
  return Array.from(value.replace(/\u0000/g, '')).slice(0, FIELD_MAX).join('')
}

/** The measurement issue, with the form fields filled in. The caller reviews it before submitting. */
export function measurementIssueUrl(fields: {
  version: string
  gpu: string
  llamacpp: string
  model: string
  context: string
  settings: string
  speed: string
  vram: string
  notes: string
}): string {
  const params = new URLSearchParams()
  params.set('template', 'measurement.yml')
  const keys = ['version', 'gpu', 'llamacpp', 'model', 'context', 'settings', 'speed', 'vram', 'notes'] as const
  for (const key of keys) params.set(key, clip(fields[key]))
  return `${ISSUE_FORM}?${params.toString()}`
}

/** True when the directory of a model path is not in the URL. The file name may be. */
export function urlHidesPath(url: string, modelPath: string): boolean {
  const slash = modelPath.lastIndexOf('/')
  if (slash <= 0) return true
  return !url.includes(modelPath.slice(0, slash))
}

export function describeGpu(input: {
  name: string | null
  vramMiB: number
  vendorId: string | null
  deviceId: string | null
}): string {
  const name = input.name && input.name.trim() !== '' ? input.name.trim() : 'GPU'
  const ids = input.vendorId && input.deviceId ? `, ${input.vendorId}:${input.deviceId}` : ''
  return `${name}, ${input.vramMiB} MiB${ids}`
}

export function describeLlama(version: string, backend: 'vulkan' | 'cpu' | null): string {
  const where = backend === 'vulkan' ? 'Vulkan' : backend === 'cpu' ? 'CPU' : 'this build'
  return `${version} (${where})`
}

export function describeSpeed(tokPerSec: number | null): string {
  if (tokPerSec === null || !Number.isFinite(tokPerSec) || tokPerSec <= 0) return 'Measured in Lowerbeam'
  return `${formatTokPerSec(tokPerSec)} tok/s generation`
}

/** Launch knobs for the form. Paths are left out: a projector is only where it ran. */
export function describeLaunch(config: Omit<LaunchConfig, 'modelPath'>): string {
  const parts = [
    config.autoFit ? 'fit on' : `${config.gpuLayers} GPU layers`,
    `context ${config.contextSize}`,
    `KV ${config.cacheTypeK}/${config.cacheTypeV}`,
    config.flashAttn ? 'flash attention on' : 'flash attention off',
    `parallel ${config.parallel}`
  ]
  if (config.mmprojPath) parts.push(config.mmprojOffload === false ? 'projector on CPU' : 'projector on GPU')
  if (config.speculative && config.speculative !== 'off') parts.push(`speculative ${config.speculative}`)
  return parts.join(', ')
}
