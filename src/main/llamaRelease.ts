/**
 * Official llama.cpp builds, fetched into the app's own data folder.
 *
 * The archive is checked against the digest GitHub publishes beside that
 * asset, then unpacked under `<userData>/llama.cpp/<tag>-<backend>/`.
 * The digest proves the bytes are exactly the release asset, so truncation,
 * corruption and tampering in transit or at the CDN fail the check. It does
 * not prove that llama.cpp's release pipeline or GitHub account were
 * uncompromised: the digest comes from the same place as the file. A Sigstore
 * check would be a later change.
 *
 * Only api.github.com, github.com, release-assets.githubusercontent.com and
 * objects.githubusercontent.com are contacted, over HTTPS. Redirects are
 * followed by hand and every hop is checked again. A download URL carries a
 * short-lived signature in its query string; errors name the host and never
 * the full URL. Nothing is written outside the data folder, and nothing is
 * installed onto the system.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { constants, createReadStream } from 'node:fs'
import { open, lstat, mkdir, readdir, realpath, rename, rm, symlink, type FileHandle } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { isIP, type LookupFunction } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import type { BinaryInfo } from '@shared/types.js'
import { probeBinary, parseVersion } from './probe.js'
import { PRIVATE_DIR, PRIVATE_FILE } from './private.js'
import { blockedAddress } from './web.js'

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

/** Hosts a release download is allowed to touch. Tests replace the list. */
export const RELEASE_HOSTS = [
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
] as const

/** Compressed asset and unpacked tree both stop here. CUDA-sized packs are out of scope. */
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024

const POINTER_MAX_BYTES = 1024
const API_MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 60_000
const TAR_BLOCK = 512
const MIN_GLIBC = '2.34'
/** Owner execute when the archive entry was executable. Group and other stay off, as with every other data file. */
const EXEC_MODE = 0o700

const VULKAN_ASSET = /^llama-(b\d+)-bin-ubuntu-vulkan-x64\.tar\.gz$/
const CPU_ASSET = /^llama-(b\d+)-bin-ubuntu-x64\.tar\.gz$/
const BUILD_TAG = /^b\d+$/
const MANAGED_DIR = /^b(\d+)-(vulkan|cpu)$/

export type LlamaBackend = 'vulkan' | 'cpu'
export type ReleaseChannel = 'pinned' | 'newest'

export type ReleaseFailure =
  | 'offline'
  | 'rate-limit'
  | 'blocked'
  | 'redirect'
  | 'no-pointer'
  | 'bad-pointer'
  | 'no-asset'
  | 'tag-mismatch'
  | 'unverified'
  | 'unsafe-entry'
  | 'glibc'
  | 'cancelled'
  | 'disk'
  | 'exists'
  | 'too-large'
  | 'probe'
  | 'no-vulkan'

export class LlamaReleaseError extends Error {
  readonly code: ReleaseFailure
  /** ISO time from `x-ratelimit-reset`, when GitHub gave one. */
  readonly retryAt?: string

  constructor(code: ReleaseFailure, message: string, retryAt?: string) {
    super(message)
    this.name = 'LlamaReleaseError'
    this.code = code
    this.retryAt = retryAt
  }
}

export interface ReleaseAsset {
  name: string
  size: number
  /** Absolute download URL. Checked against the host list at request time. */
  url: string
  /** `sha256:<hex>` as GitHub sends it, or null when the asset has none. */
  digest: string | null
}

export interface ResolvedAsset {
  tag: string
  backend: LlamaBackend
  name: string
  url: string
  size: number
  /** Lower-case hex, without the `sha256:` prefix. */
  digest: string
}

export interface InstallOptions {
  /** `<userData>/llama.cpp`. */
  root: string
  backend: LlamaBackend
  channel: ReleaseChannel
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
  /** A server is running this binary. That build's directory is not removed. */
  runningPath?: string
  /** Overrides the client's glibc read. Tests pass a fixed version. */
  glibc?: () => string | null
}

export interface InstalledBuild {
  tag: string
  backend: LlamaBackend
  dir: string
  llamaPath: string
  digest: string
  size: number
  binary: BinaryInfo
}

export interface ReleaseClientOptions {
  /** Origin of the API, with no path. Defaults to https://api.github.com. */
  apiBase?: string
  repo?: string
  /** Replaces {@link RELEASE_HOSTS}. */
  allowedHosts?: readonly string[]
  /**
   * Let tests speak HTTP to a loopback host. Private and loopback addresses
   * are refused without this, which is what production wants.
   */
  allowPrivate?: boolean
  userAgent?: string
  glibc?: () => string | null
}

export const VULKAN_INSTALL_HINT =
  'Fedora: vulkan-loader and mesa-vulkan-drivers. Debian or Ubuntu: libvulkan1 and mesa-vulkan-drivers. NVIDIA: the proprietary driver.'

export function noVulkanMessage(): string {
  return `No Vulkan GPU was found. Install a Vulkan driver (${VULKAN_INSTALL_HINT}) or choose the CPU build.`
}

/** Device ids from `--list-devices` that are Vulkan GPUs. `Vulkan0` counts; `ROCm0` does not. */
export function vulkanDevices(devices: readonly { id: string }[]): string[] {
  return devices.filter((device) => /^Vulkan\d+$/.test(device.id)).map((device) => device.id)
}

/**
 * Whether `runtime` is older than the official builds require.
 * Unknown or unreadable versions do not block: the probe fails on its own
 * if the binary cannot start. `2.34` and anything newer pass.
 */
export function glibcOlderThan(runtime: string | null | undefined, minimum = MIN_GLIBC): boolean {
  const got = parseGlibc(runtime ?? '')
  const need = parseGlibc(minimum)
  if (!got || !need) return false
  if (got[0] !== need[0]) return got[0] < need[0]
  return got[1] < need[1]
}

/** glibc this process was built to run on, or null when the report does not say. */
export function glibcRuntime(): string | null {
  if (cachedGlibc !== undefined) return cachedGlibc
  cachedGlibc = readGlibcReport()
  return cachedGlibc
}

let cachedGlibc: string | null | undefined

function readGlibcReport(): string | null {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
    const version = report.header?.glibcVersionRuntime
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}

function parseGlibc(version: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2])]
}

/**
 * The one asset for this backend whose build number is the release tag.
 * `ubuntu-x64` does not match the Vulkan name, and a `cudart-` or `arm64`
 * asset does not match either pattern.
 */
export function chooseAsset(backend: LlamaBackend, tag: string, assets: readonly ReleaseAsset[]): ResolvedAsset {
  if (!BUILD_TAG.test(tag)) {
    throw new LlamaReleaseError('bad-pointer', `The release tag ${show(tag)} is not a build tag like b11429.`)
  }
  const pattern = backend === 'vulkan' ? VULKAN_ASSET : CPU_ASSET
  const kind = backend === 'vulkan' ? 'ubuntu-vulkan-x64' : 'ubuntu-x64'
  const wanted = `llama-${tag}-bin-${kind}.tar.gz`
  const matches = assets.filter((asset) => pattern.test(asset.name))
  if (matches.length !== 1) {
    throw new LlamaReleaseError('no-asset', `Release ${tag} has no ${backend} asset named ${wanted}.`)
  }
  const asset = matches[0]!
  const build = pattern.exec(asset.name)?.[1]
  if (build !== tag) {
    throw new LlamaReleaseError('tag-mismatch', `Asset ${asset.name} is build ${build}, not release ${tag}.`)
  }
  const digest = parseDigest(asset.digest)
  if (!digest) {
    throw new LlamaReleaseError('unverified', 'The download could not be verified. The release asset has no sha256 digest.')
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE_BYTES) {
    throw new LlamaReleaseError('too-large', `The archive is ${asset.size} bytes, over the 500 MB limit.`)
  }
  if (!asset.url) {
    throw new LlamaReleaseError('no-asset', `Release ${tag} asset ${asset.name} has no download URL.`)
  }
  return { tag, backend, name: asset.name, url: asset.url, size: asset.size, digest }
}

function parseDigest(digest: string | null | undefined): string | null {
  if (!digest) return null
  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(digest.trim())
  return match ? match[1]!.toLowerCase() : null
}

function show(name: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, '?')
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean
}

function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  return blockedAddress(host) === 'on this computer'
}

interface Fetched {
  status: number
  headers: IncomingHttpHeaders
  body: IncomingMessage
}

interface ReleaseJson {
  tag: string
  draft: boolean
  assets: ReleaseAsset[]
}

/**
 * A client for the llama.cpp GitHub releases.
 * Construct one with a loopback `apiBase` in tests. The default talks to GitHub.
 */
export class LlamaRelease {
  private readonly apiOrigin: string
  private readonly repo: string
  private readonly allowed: Set<string>
  private readonly allowPrivate: boolean
  private readonly userAgent: string
  private readonly readGlibc: () => string | null

  constructor(options: ReleaseClientOptions = {}) {
    this.allowPrivate = options.allowPrivate ?? false
    this.allowed = new Set((options.allowedHosts ?? RELEASE_HOSTS).map((host) => host.toLowerCase()))
    this.repo = options.repo ?? 'ggml-org/llama.cpp'
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repo)) {
      throw new LlamaReleaseError('no-asset', 'The llama.cpp repository path is not valid.')
    }
    const base = options.apiBase ?? 'https://api.github.com'
    let url: URL
    try {
      url = new URL(base)
    } catch {
      throw new LlamaReleaseError('redirect', 'The release API address is not a URL.')
    }
    this.assertUrl(url)
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new LlamaReleaseError('redirect', 'The release API address must be an origin, with no path.')
    }
    this.apiOrigin = url.origin
    this.userAgent = options.userAgent ?? `Lowerbeam/${VERSION}`
    this.readGlibc = options.glibc ?? glibcRuntime
  }

  /** Pinned follows nightly-tag.txt. Newest takes the first `bNNNN` tag in the five latest releases. */
  async resolve(backend: LlamaBackend, channel: ReleaseChannel, signal?: AbortSignal): Promise<ResolvedAsset> {
    if (backend !== 'vulkan' && backend !== 'cpu') {
      throw new LlamaReleaseError('no-asset', 'Choose the Vulkan build or the CPU build.')
    }
    if (channel === 'newest') return this.resolveNewest(backend, signal)
    if (channel !== 'pinned') {
      throw new LlamaReleaseError('no-pointer', 'Choose the pinned build or the newest build.')
    }
    return this.resolvePinned(backend, signal)
  }

  /**
   * Download `asset` into `downloadsDir`, resuming a `.part` file with Range.
   * A digest or size mismatch deletes the partial. Cancel keeps it.
   * Returns the verified archive path.
   */
  async download(
    asset: ResolvedAsset,
    downloadsDir: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}
  ): Promise<string> {
    if (options.signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE_BYTES) {
      throw new LlamaReleaseError('too-large', `The archive is ${asset.size} bytes, over the 500 MB limit.`)
    }
    if (!isPlainFileName(asset.name)) {
      throw new LlamaReleaseError('no-asset', `Asset name ${show(asset.name)} is not a file name.`)
    }
    if (!/^[a-f0-9]{64}$/.test(asset.digest)) {
      await discardName(downloadsDir, asset.name)
      throw new LlamaReleaseError('unverified', 'The download could not be verified. The release asset has no sha256 digest.')
    }
    await mkdir(downloadsDir, { recursive: true, mode: PRIVATE_DIR })
    const finalPath = join(downloadsDir, asset.name)
    const partPath = `${finalPath}.part`
    if (await fileMatches(finalPath, asset.size, asset.digest)) {
      options.onProgress?.(asset.size, asset.size)
      return finalPath
    }
    await rm(finalPath, { force: true }).catch(() => undefined)
    return this.transfer(asset, finalPath, partPath, options, false)
  }

  /**
   * Resolve, download, extract and probe. Does not change settings.
   * A build that fails to run is removed. A Vulkan build with no Vulkan device
   * is left in place and reported, so the caller can offer the CPU build.
   */
  async install(options: InstallOptions): Promise<InstalledBuild> {
    const glibc = (options.glibc ?? this.readGlibc)()
    if (glibcOlderThan(glibc)) {
      const found = glibc ? ` (this system has ${glibc})` : ''
      throw new LlamaReleaseError(
        'glibc',
        `The official build needs glibc ${MIN_GLIBC} or newer${found}. Use your own build.`
      )
    }
    const asset = await this.resolve(options.backend, options.channel, options.signal)
    const dest = join(options.root, `${asset.tag}-${asset.backend}`)
    if (await exists(dest)) {
      // Already unpacked. Probe it and use it; do not download again and do
      // not delete it when the probe fails. A symlink is not a build.
      await assertInside(options.root, dest)
      const info = await lstat(dest)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new LlamaReleaseError('exists', `${asset.tag}-${options.backend} already exists, so it was left in place.`)
      }
      const llamaPath = join(dest, 'llama')
      const binary = await confirmBinary(llamaPath)
      if (options.backend === 'vulkan' && vulkanDevices(binary.devices).length === 0) {
        throw new LlamaReleaseError('no-vulkan', noVulkanMessage())
      }
      return {
        tag: asset.tag,
        backend: asset.backend,
        dir: dest,
        llamaPath,
        digest: asset.digest,
        size: asset.size,
        binary
      }
    }
    const archive = await this.download(asset, join(options.root, '.downloads'), options)
    let dir: string | null = null
    try {
      dir = await extractReleaseArchive(archive, options.root, asset.tag, asset.backend, options.signal)
      const llamaPath = join(dir, 'llama')
      const binary = await confirmBinary(llamaPath)
      await rm(archive, { force: true }).catch(() => undefined)
      await pruneOldBuilds(options.root, options.runningPath)
      if (options.backend === 'vulkan' && vulkanDevices(binary.devices).length === 0) {
        throw new LlamaReleaseError('no-vulkan', noVulkanMessage())
      }
      return {
        tag: asset.tag,
        backend: asset.backend,
        dir,
        llamaPath,
        digest: asset.digest,
        size: asset.size,
        binary
      }
    } catch (err) {
      if (dir && !(err instanceof LlamaReleaseError && err.code === 'no-vulkan')) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
      throw err
    }
  }

  private async resolvePinned(backend: LlamaBackend, signal?: AbortSignal): Promise<ResolvedAsset> {
    const latest = asRelease(await this.getJson(this.repoPath('/releases/latest'), signal))
    const pointer = latest.assets.find((asset) => asset.name === 'nightly-tag.txt')
    if (!pointer) {
      throw new LlamaReleaseError('no-pointer', 'The latest release has no nightly-tag.txt, so the pinned build could not be chosen.')
    }
    const body = await this.downloadSmall(pointer, POINTER_MAX_BYTES, signal)
    const text = body.toString('utf8').trim()
    if (!BUILD_TAG.test(text)) {
      throw new LlamaReleaseError(
        'bad-pointer',
        `nightly-tag.txt contained ${JSON.stringify(text)}, which is not a build tag like b11429.`
      )
    }
    const release = asRelease(await this.getJson(this.repoPath(`/releases/tags/${text}`), signal))
    if (release.tag !== text) {
      throw new LlamaReleaseError('tag-mismatch', `Release ${show(release.tag)} was returned for tag ${text}.`)
    }
    return chooseAsset(backend, text, release.assets)
  }

  private async resolveNewest(backend: LlamaBackend, signal?: AbortSignal): Promise<ResolvedAsset> {
    const json = await this.getJson(this.repoPath('/releases?per_page=5'), signal)
    if (!Array.isArray(json)) throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
    for (const item of json) {
      const release = asRelease(item)
      if (release.draft || !BUILD_TAG.test(release.tag)) continue
      return chooseAsset(backend, release.tag, release.assets)
    }
    throw new LlamaReleaseError('no-pointer', 'None of the five newest releases has a build tag like b11429.')
  }

  private repoPath(suffix: string): string {
    const [owner, name] = this.repo.split('/') as [string, string]
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
  }

  private async transfer(
    asset: ResolvedAsset,
    finalPath: string,
    partPath: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void },
    retried: boolean
  ): Promise<string> {
    let start = 0
    try {
      const info = await lstat(partPath)
      if (info.isSymbolicLink()) {
        throw new LlamaReleaseError('unsafe-entry', `Refused to write ${asset.name}: the partial file is a symlink.`)
      }
      start = info.size > asset.size ? 0 : info.size
      if (info.size > asset.size) await rm(partPath)
    } catch (err) {
      if (err instanceof LlamaReleaseError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw wrapDisk(err, partPath)
      start = 0
    }
    if (start === asset.size) {
      if (await fileMatches(partPath, asset.size, asset.digest)) {
        await rename(partPath, finalPath)
        options.onProgress?.(asset.size, asset.size)
        return finalPath
      }
      await rm(partPath, { force: true })
      start = 0
    }

    const extra: Record<string, string> = {}
    if (start > 0) extra['range'] = `bytes=${start}-`
    const res = await this.get(asset.url, extra, options.signal)
    if (res.status === 416 && !retried) {
      res.body.resume()
      await rm(partPath, { force: true })
      return this.transfer(asset, finalPath, partPath, options, true)
    }
    if (res.status === 403 || res.status === 429) {
      const error = rateLimitError(res.status, res.headers)
      res.body.resume()
      throw error
    }
    if (res.status !== 200 && res.status !== 206) {
      res.body.resume()
      throw new LlamaReleaseError('offline', `Couldn't reach GitHub (HTTP ${res.status}).`)
    }

    let offset = start
    if (res.status === 200) {
      offset = 0
    } else {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(headerOne(res.headers['content-range']) ?? '')
      if (!match || Number(match[1]) !== start || (match[3] !== '*' && Number(match[3]) !== asset.size)) {
        res.body.resume()
        await rm(partPath, { force: true })
        throw new LlamaReleaseError('unverified', 'The download could not be verified.')
      }
    }
    const declared = headerOne(res.headers['content-length'])
    const length = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null
    if (length !== null && length !== asset.size - offset) {
      res.body.resume()
      await rm(partPath, { force: true })
      throw new LlamaReleaseError('unverified', 'The download could not be verified.')
    }

    const hash = createHash('sha256')
    if (offset > 0) await feedHash(hash, partPath, offset)
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (offset === 0 ? constants.O_TRUNC : 0)
    const handle = await open(partPath, flags, PRIVATE_FILE)
    let failed = false
    try {
      let position = offset
      for await (const chunk of res.body) {
        if (options.signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (position + buf.length > asset.size) {
          throw new LlamaReleaseError('unverified', 'The download could not be verified.')
        }
        await writeAll(handle, buf, position)
        hash.update(buf)
        position += buf.length
        options.onProgress?.(position, asset.size)
      }
      if (position !== asset.size) {
        // The response ended before the asset was all here. Keep the partial
        // so a later attempt can send Range. A wrong content-length was
        // already refused above, and that one deletes the partial.
        throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
      }
      const hex = hash.digest('hex')
      if (hex !== asset.digest) throw new LlamaReleaseError('unverified', 'The download could not be verified.')
    } catch (err) {
      failed = true
      const wrapped = err instanceof LlamaReleaseError ? err : wrapNet(err, options.signal)
      if (wrapped instanceof LlamaReleaseError && wrapped.code === 'unverified') {
        await rm(partPath, { force: true }).catch(() => undefined)
      }
      throw wrapped
    } finally {
      await handle.close().catch(() => undefined)
      if (failed) res.body.destroy()
    }
    await rename(partPath, finalPath)
    options.onProgress?.(asset.size, asset.size)
    return finalPath
  }

  private async downloadSmall(asset: ReleaseAsset, cap: number, signal?: AbortSignal): Promise<Buffer> {
    const digest = parseDigest(asset.digest)
    if (!digest) {
      throw new LlamaReleaseError('unverified', 'The download could not be verified. The release asset has no sha256 digest.')
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > cap) {
      throw new LlamaReleaseError('unverified', 'The download could not be verified.')
    }
    const res = await this.get(asset.url, {}, signal)
    if (res.status === 403 || res.status === 429) {
      const error = rateLimitError(res.status, res.headers)
      res.body.resume()
      throw error
    }
    if (res.status !== 200) {
      res.body.resume()
      throw new LlamaReleaseError('offline', `Couldn't reach GitHub (HTTP ${res.status}).`)
    }
    const body = await readBounded(res.body, asset.size, () => new LlamaReleaseError('unverified', 'The download could not be verified.'))
    if (body.length !== asset.size || createHash('sha256').update(body).digest('hex') !== digest) {
      throw new LlamaReleaseError('unverified', 'The download could not be verified.')
    }
    return body
  }

  private async getJson(pathname: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.get(new URL(pathname, this.apiOrigin).href, {}, signal)
    if (res.status === 403 || res.status === 429) {
      const error = rateLimitError(res.status, res.headers)
      res.body.resume()
      throw error
    }
    if (res.status !== 200) {
      res.body.resume()
      throw new LlamaReleaseError('offline', `Couldn't reach GitHub (HTTP ${res.status}).`)
    }
    const body = await readBounded(res.body, API_MAX_BYTES, () => new LlamaReleaseError('offline', "Couldn't reach GitHub."))
    try {
      return JSON.parse(body.toString('utf8')) as unknown
    } catch {
      throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
    }
  }

  private async get(url: string, extra: Record<string, string>, signal?: AbortSignal): Promise<Fetched> {
    if (signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let current: URL
    try {
      current = new URL(url)
    } catch {
      throw new LlamaReleaseError('redirect', 'Refused a download URL that is not a URL.')
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertUrl(current)
      let res: IncomingMessage
      try {
        res = await this.once(current, this.headersFor(current, extra), combined)
      } catch (err) {
        throw wrapNet(err, signal)
      }
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && status !== 304) {
        const location = headerOne(res.headers.location)
        res.resume()
        if (hop === MAX_REDIRECTS) throw new LlamaReleaseError('redirect', 'Stopped after 5 redirects.')
        if (!location) throw new LlamaReleaseError('redirect', `Refused a redirect from ${current.hostname}: it had no location.`)
        try {
          current = new URL(location, current)
        } catch {
          throw new LlamaReleaseError('redirect', `Refused a redirect from ${current.hostname}.`)
        }
        continue
      }
      return { status, headers: res.headers, body: res }
    }
    throw new LlamaReleaseError('redirect', 'Stopped after 5 redirects.')
  }

  private headersFor(url: URL, extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'application/octet-stream',
      ...extra
    }
    if (url.origin === this.apiOrigin) {
      headers['accept'] = 'application/vnd.github+json'
      headers['x-github-api-version'] = '2022-11-28'
    }
    delete headers['authorization']
    delete headers['Authorization']
    return headers
  }

  private assertUrl(url: URL): void {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!host || url.username || url.password) {
      throw new LlamaReleaseError('redirect', `Refused ${host || 'that host'}: the URL contains credentials.`)
    }
    if (!this.allowed.has(host)) {
      throw new LlamaReleaseError('redirect', `Refused ${host}. Only GitHub release hosts are contacted.`)
    }
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && this.allowPrivate && isLoopbackHost(host)) return
    throw new LlamaReleaseError('redirect', `Refused ${url.protocol}//${host}. GitHub is contacted over HTTPS only.`)
  }

  private once(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host)) {
      const why = this.allowPrivate ? null : blockedAddress(host)
      if (why) return Promise.reject(new LlamaReleaseError('blocked', `Refused ${host}: it is ${why}.`))
    }
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const lookup = this.allowPrivate ? undefined : guardedLookup()
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', headers, lookup, signal })
      req.on('response', resolve)
      req.on('error', reject)
      req.end()
    })
  }
}

function guardedLookup(): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0)
        return
      }
      const list = addresses as LookupAddress[]
      for (const found of list) {
        const why = blockedAddress(found.address)
        if (why) {
          callback(Object.assign(new Error(`Refused ${hostname} (${found.address}): it is ${why}.`), { code: 'BLOCKED' }), '', 0)
          return
        }
      }
      const first = list[0]
      if (!first) {
        callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), '', 0)
        return
      }
      if (options.all) (callback as unknown as (error: null, addrs: LookupAddress[]) => void)(null, list)
      else callback(null, first.address, first.family)
    })
  }
}

function rateLimitError(status: number, headers: IncomingHttpHeaders): LlamaReleaseError {
  const raw = headerOne(headers['x-ratelimit-reset'])
  let retryAt: string | undefined
  if (raw && /^\d+$/.test(raw)) {
    const seconds = Number(raw)
    const date = new Date(seconds * 1000)
    if (Number.isSafeInteger(seconds) && !Number.isNaN(date.getTime())) retryAt = date.toISOString()
  }
  const message = retryAt
    ? `GitHub rate limit reached. Try again after ${retryAt}.`
    : `GitHub refused the request (HTTP ${status}).`
  return new LlamaReleaseError('rate-limit', message, retryAt)
}

function wrapNet(err: unknown, caller?: AbortSignal): Error {
  if (err instanceof LlamaReleaseError) return err
  if (caller?.aborted) return new LlamaReleaseError('cancelled', 'Download cancelled.')
  const code = errnoCode(err)
  if (code === 'BLOCKED') return new LlamaReleaseError('blocked', err instanceof Error ? err.message : `Refused an address.`)
  if (code === 'ABORT_ERR' || (err instanceof Error && err.name === 'AbortError')) {
    return new LlamaReleaseError('offline', "Couldn't reach GitHub.")
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EPIPE'].includes(code)) {
    return new LlamaReleaseError('offline', "Couldn't reach GitHub.")
  }
  return err instanceof Error ? err : new Error(String(err))
}

function wrapDisk(err: unknown, folder: string): Error {
  if (err instanceof LlamaReleaseError) return err
  const code = errnoCode(err)
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    const detail = err instanceof Error ? err.message : code
    return new LlamaReleaseError('disk', `Could not write ${folder}: ${detail}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function errnoCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return ''
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

async function readBounded(stream: Readable, max: number, overflow: () => Error): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > max) {
      stream.destroy()
      throw overflow()
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function fileMatches(path: string, size: number, digest: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size !== size) return false
  } catch {
    return false
  }
  const hash = createHash('sha256')
  await feedHash(hash, path, size)
  return hash.digest('hex') === digest
}

async function feedHash(hash: Hash, path: string, bytes: number): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buf = Buffer.alloc(64 * 1024)
    let left = bytes
    while (left > 0) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, left), null)
      if (bytesRead === 0) throw new LlamaReleaseError('unverified', 'The download could not be verified.')
      hash.update(buf.subarray(0, bytesRead))
      left -= bytesRead
    }
  } finally {
    await handle.close()
  }
}

async function writeAll(handle: FileHandle, buf: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, position + offset)
    if (bytesWritten <= 0) throw new LlamaReleaseError('disk', 'Could not write the download: the disk accepted nothing.')
    offset += bytesWritten
  }
}

/** A single path segment. `.` and `..` would escape the downloads directory. */
function isPlainFileName(name: string): boolean {
  return name !== '.' && name !== '..' && /^[\w.-]+$/.test(name)
}

async function discardName(dir: string, name: string): Promise<void> {
  if (!isPlainFileName(name)) return
  await rm(join(dir, name), { force: true }).catch(() => undefined)
  await rm(join(dir, `${name}.part`), { force: true }).catch(() => undefined)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function asRelease(value: unknown): ReleaseJson {
  if (!value || typeof value !== 'object') throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
  const record = value as Record<string, unknown>
  if (typeof record['tag_name'] !== 'string') throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
  return { tag: record['tag_name'], draft: record['draft'] === true, assets: asAssets(record['assets']) }
}

function asAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) throw new LlamaReleaseError('offline', "Couldn't reach GitHub.")
  const assets: ReleaseAsset[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const { name, size, browser_download_url: url, digest } = record
    if (typeof name !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size)) continue
    assets.push({
      name,
      size,
      url: typeof url === 'string' ? url : '',
      digest: typeof digest === 'string' ? digest : null
    })
  }
  return assets
}

async function confirmBinary(llamaPath: string): Promise<BinaryInfo> {
  let versionText = ''
  try {
    versionText = await captureText(llamaPath, ['--version'])
  } catch (err) {
    throw new LlamaReleaseError('probe', failureLine(err))
  }
  const library = versionText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('error while loading shared libraries'))
  if (library) throw new LlamaReleaseError('probe', `${library} Use your own build.`)
  if (parseVersion(versionText) === 'unknown') {
    throw new LlamaReleaseError('probe', 'The build did not report a version. Use your own build.')
  }
  try {
    return await probeBinary({ path: llamaPath, kind: 'unified' })
  } catch (err) {
    throw new LlamaReleaseError('probe', failureLine(err))
  }
}

function captureText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`
      if (out) resolve(out)
      else reject(err ?? new Error('The build did not run.'))
    })
  })
}

function failureLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('Command failed'))
  if (!line) return 'The build did not run. Use your own build.'
  return line.includes('Use your own build.') ? line : `${line} Use your own build.`
}

/**
 * Unpack a verified `.tar.gz` into `<root>/<tag>-<backend>`.
 *
 * The official archives are GNU ustar (`ustar` plus a space). Names fit in
 * the header, and the symlinks point at another plain name in the same
 * folder, including another symlink (`libllama.so` → `libllama.so.0` →
 * `libllama.so.0.6.0`). Pax path overrides and GNU long names are accepted
 * so a later archive still unpacks, and they go through the same path checks.
 */
export async function extractReleaseArchive(
  archive: string,
  root: string,
  tag: string,
  backend: LlamaBackend,
  signal?: AbortSignal
): Promise<string> {
  if (!BUILD_TAG.test(tag)) throw new LlamaReleaseError('bad-pointer', `The release tag ${show(tag)} is not a build tag like b11429.`)
  const dest = join(root, `${tag}-${backend}`)
  if (await exists(dest)) {
    throw new LlamaReleaseError('exists', `${tag}-${backend} already exists, so it was left in place.`)
  }
  await mkdir(root, { recursive: true, mode: PRIVATE_DIR })
  const temp = join(root, `.extract-${randomBytes(6).toString('hex')}`)
  await mkdir(temp, { mode: PRIVATE_DIR })
  const raw = createReadStream(archive, signal ? { signal } : {})
  const gunzip = createGunzip()
  raw.pipe(gunzip)
  const source = new ByteSource(gunzip)
  try {
    if (signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
    await unpack(source, temp, tag, signal)
    const staged = join(temp, `llama-${tag}`)
    await assertInside(root, staged)
    await rename(staged, dest)
    return dest
  } catch (err) {
    if (signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
    throw mapArchiveError(err, temp)
  } finally {
    source.close()
    raw.destroy()
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

function mapArchiveError(err: unknown, folder: string): Error {
  if (err instanceof LlamaReleaseError) return err
  if (isZlib(err)) return new LlamaReleaseError('unverified', 'The download could not be verified.')
  return wrapDisk(err, folder)
}

function isZlib(err: unknown): boolean {
  const code = errnoCode(err)
  return code.startsWith('Z_') || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

class ByteSource {
  private readonly chunks: Buffer[] = []
  private queued = 0
  private ended = false
  private error: Error | null = null
  private wake: (() => void) | null = null
  private closed = false

  constructor(private readonly input: Readable) {
    input.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.chunks.push(chunk)
      this.queued += chunk.length
      if (this.queued > 1024 * 1024) input.pause()
      this.ping()
    })
    input.on('end', () => {
      this.ended = true
      this.ping()
    })
    input.on('error', (err: Error) => {
      if (this.closed) return
      this.error = err
      this.ended = true
      this.ping()
    })
  }

  /** Exactly `n` bytes, or null when the stream ended on a block boundary. */
  async read(n: number): Promise<Buffer | null> {
    if (this.chunks.length === 0 && this.ended && !this.error) return null
    const parts: Buffer[] = []
    let got = 0
    while (got < n) {
      if (this.chunks.length === 0) {
        if (this.error) throw this.error
        if (this.ended) {
          if (got === 0) return null
          throw new LlamaReleaseError('unverified', 'The archive ended before it was complete.')
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve
          if (this.chunks.length > 0 || this.ended) {
            this.wake = null
            resolve()
          }
        })
        continue
      }
      const head = this.chunks[0]!
      const take = Math.min(head.length, n - got)
      parts.push(head.subarray(0, take))
      got += take
      this.queued -= take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
      if (this.queued <= 512 * 1024) this.input.resume()
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, got)
  }

  close(): void {
    this.closed = true
    this.ended = true
    this.input.removeAllListeners('error')
    this.input.on('error', () => undefined)
    this.input.destroy()
    this.ping()
  }

  private ping(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

interface PlannedLink {
  rel: string
  target: string
  entry: string
}

async function unpack(source: ByteSource, temp: string, tag: string, signal?: AbortSignal): Promise<void> {
  const rootName = `llama-${tag}`
  const files = new Set<string>()
  const used = new Set<string>()
  const links: PlannedLink[] = []
  const linkTarget = new Map<string, string>()
  let longName: string | null = null
  let longLink: string | null = null
  let localPax: Record<string, string> | null = null
  const globalPax: Record<string, string> = {}
  let unpacked = 0

  for (;;) {
    if (signal?.aborted) throw new LlamaReleaseError('cancelled', 'Download cancelled.')
    const header = await source.read(TAR_BLOCK)
    if (!header) break
    if (header.every((byte) => byte === 0)) break
    if (!isUstar(header)) {
      throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its header is not ustar.')
    }
    if (!checksumOk(header)) {
      throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its header checksum does not match.')
    }
    const type = String.fromCharCode(header[156] ?? 0)
    const size = tarNumber(header.subarray(124, 136))
    const rawName = cstring(header.subarray(0, 100))
    const prefix = cstring(header.subarray(345, 500))
    const rawLink = cstring(header.subarray(157, 257))
    if (size < 0 || unpacked + size > MAX_ARCHIVE_BYTES) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(rawName || prefix)} is not safe to extract: the archive unpacks to more than 500 MB.`)
    }
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      const body = await readEntry(source, size)
      unpacked += size
      if (type === 'L') longName = gnuText(body)
      else if (type === 'K') longLink = gnuText(body)
      else if (type === 'g') Object.assign(globalPax, parsePax(body))
      else localPax = parsePax(body)
      continue
    }

    const headerName = prefix ? `${prefix}/${rawName}` : rawName
    const pax = { ...globalPax, ...localPax }
    const name = pax['path'] ?? longName ?? headerName
    const linkname = pax['linkpath'] ?? longLink ?? rawLink
    longName = null
    longLink = null
    localPax = null
    const mode = tarNumber(header.subarray(100, 108))

    if (type !== '0' && type !== '\0' && type !== '5' && type !== '2') {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract: type ${show(type || 'unknown')} is not a file, directory or symlink.`)
    }
    const parts = safeParts(name)
    if (!parts || parts[0] !== rootName || (parts.length === 1 && type !== '5')) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract.`)
    }
    if ((type === '0' || type === '\0' || type === '5') && (mode & 0o6000) !== 0) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract: it has a setuid or setgid bit.`)
    }
    const rel = parts.join('/')
    if (type === '5') {
      if (used.has(rel)) throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract.`)
      used.add(rel)
      await ensureDir(temp, rel)
      if (size > 0) {
        await readEntry(source, size)
        unpacked += size
      }
      continue
    }
    if (type === '2') {
      const target = plainName(linkname)
      if (!target) throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract: its symlink leaves the folder.`)
      if (used.has(rel)) throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract.`)
      used.add(rel)
      links.push({ rel, target, entry: name })
      linkTarget.set(rel, target)
      // The body of a symlink is empty. Still honour a claimed size, under the cap.
      if (size > 0) {
        await readEntry(source, size)
        unpacked += size
      }
      continue
    }
    const written = (mode & 0o111) !== 0 ? EXEC_MODE : PRIVATE_FILE
    if (used.has(rel)) throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(name)} is not safe to extract.`)
    used.add(rel)
    await ensureDir(temp, dirname(rel) === '.' ? '' : dirname(rel))
    const handle = await open(join(temp, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, written)
    try {
      let left = size
      while (left > 0) {
        const chunk = await source.read(Math.min(left, 64 * 1024))
        if (!chunk) throw new LlamaReleaseError('unverified', 'The archive ended before it was complete.')
        await writeAll(handle, chunk, size - left)
        left -= chunk.length
        unpacked += chunk.length
      }
      await handle.chmod(written)
    } finally {
      await handle.close()
    }
    const pad = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK
    if (pad) {
      const skipped = await source.read(pad)
      if (!skipped) throw new LlamaReleaseError('unverified', 'The archive ended before it was complete.')
    }
    files.add(rel)
  }

  for (const link of links) {
    if (!resolvesToFile(dirname(link.rel), link.target, linkTarget, files)) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(link.entry)} is not safe to extract: its symlink leaves the folder.`)
    }
  }
  if (!files.has(`${rootName}/llama`)) {
    throw new LlamaReleaseError('unsafe-entry', `Archive entry ${rootName}/llama is not safe to extract: the archive has no llama binary.`)
  }
  for (const link of links) {
    await ensureDir(temp, dirname(link.rel) === '.' ? '' : dirname(link.rel))
    await symlink(link.target, join(temp, link.rel))
  }
}

function resolvesToFile(dir: string, target: string, links: Map<string, string>, files: Set<string>): boolean {
  const seen = new Set<string>()
  let current = target
  const folder = dir === '.' ? '' : dir
  for (;;) {
    if (seen.has(current)) return false
    seen.add(current)
    const rel = folder ? `${folder}/${current}` : current
    if (files.has(rel)) return true
    const next = links.get(rel)
    if (!next) return false
    current = next
  }
}

async function readEntry(source: ByteSource, size: number): Promise<Buffer> {
  const body = size === 0 ? Buffer.alloc(0) : await source.read(size)
  if (!body) throw new LlamaReleaseError('unverified', 'The archive ended before it was complete.')
  const pad = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK
  if (pad) {
    const skipped = await source.read(pad)
    if (!skipped) throw new LlamaReleaseError('unverified', 'The archive ended before it was complete.')
  }
  return body
}

async function ensureDir(root: string, rel: string): Promise<void> {
  if (!rel) return
  let current = root
  for (const part of rel.split('/')) {
    current = join(current, part)
    let info: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      info = await lstat(current)
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw err
    }
    if (!info) {
      await mkdir(current, PRIVATE_DIR)
      info = await lstat(current)
    }
    if (info.isSymbolicLink()) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(rel)} is not safe to extract: it would follow a symlink.`)
    }
    if (!info.isDirectory()) {
      throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(rel)} is not safe to extract: a parent is not a directory.`)
    }
    const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await handle.chmod(PRIVATE_DIR)
    } finally {
      await handle.close()
    }
  }
}

async function assertInside(root: string, target: string): Promise<void> {
  const rootReal = await realpath(root)
  const targetReal = await realpath(target)
  const rel = relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new LlamaReleaseError('unsafe-entry', `Archive entry ${show(basename(target))} is not safe to extract.`)
  }
}

function safeParts(raw: string): string[] | null {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) return null
  const trimmed = raw.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (!trimmed || trimmed.startsWith('/')) return null
  const parts = trimmed.split('/').filter((part) => part !== '.' && part !== '')
  if (parts.length === 0 || parts.some((part) => part === '..')) return null
  return parts
}

function plainName(link: string): string | null {
  if (!link || link.includes('/') || link.includes('\\') || link.includes('\0') || link === '.' || link === '..') return null
  return link
}

function checksumOk(header: Buffer): boolean {
  const recorded = cstring(header.subarray(148, 156)).trim()
  if (!/^[0-7]+$/.test(recorded)) return false
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
  return sum === parseInt(recorded, 8)
}

function isUstar(header: Buffer): boolean {
  const magic = header.subarray(257, 262).toString('ascii')
  const mark = header[262]
  return magic === 'ustar' && (mark === 0 || mark === 0x20)
}

function cstring(field: Buffer): string {
  const end = field.indexOf(0)
  return (end === -1 ? field : field.subarray(0, end)).toString('utf8')
}

function gnuText(body: Buffer): string {
  let end = body.length
  while (end > 0 && body[end - 1] === 0) end--
  return body.subarray(0, end).toString('utf8')
}

function tarNumber(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    let value = 0n
    for (let i = 1; i < field.length; i++) value = (value << 8n) + BigInt(field[i]!)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: it is larger than 500 MB.')
    }
    return Number(value)
  }
  const text = field.toString('utf8').replace(/\0/g, ' ').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its header is not ustar.')
  }
  return parseInt(text, 8)
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let index = 0
  while (index < body.length && body[index] !== 0) {
    const space = body.indexOf(0x20, index)
    if (space <= index) throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its pax header is malformed.')
    const length = Number(body.toString('ascii', index, space))
    if (!Number.isInteger(length) || length <= 0 || index + length > body.length) {
      throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its pax header is malformed.')
    }
    const record = body.subarray(index, index + length)
    const eq = record.indexOf(0x3d)
    const keyStart = record.indexOf(0x20) + 1
    if (eq <= keyStart) throw new LlamaReleaseError('unsafe-entry', 'Archive entry is not safe to extract: its pax header is malformed.')
    const key = record.subarray(keyStart, eq).toString('utf8')
    let value = record.subarray(eq + 1).toString('utf8')
    if (value.endsWith('\n')) value = value.slice(0, -1)
    if (key) out[key] = value
    index += length
  }
  return out
}

/**
 * Keep the two newest managed builds. A directory a server is running from
 * is kept as well, and a symlink is never followed or removed.
 * Returns the directory names that were removed.
 */
export async function pruneOldBuilds(root: string, runningPath?: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return []
    throw err
  }
  const builds: Array<{ name: string; build: number; path: string }> = []
  for (const entry of entries) {
    const match = MANAGED_DIR.exec(entry.name)
    if (!match || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const build = Number(match[1])
    if (!Number.isSafeInteger(build)) continue
    builds.push({ name: entry.name, build, path: join(root, entry.name) })
  }
  const keep = new Set<string>()
  const running = await runningBuild(root, runningPath, builds)
  if (running) keep.add(running)
  const ranked = [...builds].sort((a, b) => b.build - a.build || a.name.localeCompare(b.name))
  for (const build of ranked) {
    if (keep.size >= 2) break
    keep.add(build.name)
  }
  const removed: string[] = []
  for (const build of builds) {
    if (keep.has(build.name)) continue
    await removeInside(root, build.path)
    removed.push(build.name)
  }
  return removed.sort()
}

async function runningBuild(
  root: string,
  runningPath: string | undefined,
  builds: readonly { name: string }[]
): Promise<string | null> {
  if (!runningPath) return null
  const rootReal = await realpath(root).catch(() => null)
  const runReal = await realpath(runningPath).catch(() => null)
  if (!rootReal || !runReal) return null
  const rel = relative(rootReal, runReal)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  const top = rel.split(sep)[0]
  if (!top || !builds.some((build) => build.name === top)) return null
  return top
}

async function removeInside(root: string, target: string): Promise<void> {
  const info = await lstat(target)
  if (info.isSymbolicLink()) {
    throw new LlamaReleaseError('disk', `Refused to remove ${basename(target)}.`)
  }
  const rootReal = await realpath(root)
  const targetReal = await realpath(target)
  const rel = relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new LlamaReleaseError('disk', `Refused to remove ${basename(target)}.`)
  }
  await rm(target, { recursive: true })
}
