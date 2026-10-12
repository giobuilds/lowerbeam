import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parseBuildNumber, probeBinary } from '../../src/main/probe.js'
import { rememberManagedBuild } from '../../src/main/llamaManage.js'
import { SettingsStore } from '../../src/main/settings.js'
import { installOfferedUpdate, restorePreviousBuild, runLlamaUpdateCheck } from '../../src/main/llamaUpdate.js'
import {
  LlamaRelease,
  LlamaReleaseError,
  MAX_ARCHIVE_BYTES,
  RELEASE_HOSTS,
  REQUEST_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  chooseAsset,
  extractReleaseArchive,
  glibcOlderThan,
  glibcRuntime,
  noVulkanMessage,
  pruneOldBuilds,
  vulkanDevices,
  type ReleaseAsset,
  type ReleaseFailure
} from '../../src/main/llamaRelease.js'

let n = 0
const ok = (message: string): void => {
  n++
  console.log('  ok', message)
}

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
const VULKAN_NAME = 'llama-b1-bin-ubuntu-vulkan-x64.tar.gz'
const CPU_NAME = 'llama-b1-bin-ubuntu-x64.tar.gz'

const LLAMA_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "version: 0.6.0-dev (build 1, commit abc)" >&2; exit 0; fi
if [ "$1" = "--help" ]; then echo "Available commands:"; echo "  serve"; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "--list-devices" ]; then echo "Vulkan0: Test GPU (1024 MiB, 512 MiB free)"; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "--help" ]; then echo "--ctx-size N"; exit 0; fi
exit 0
`
const NO_VULKAN_SH = LLAMA_SH.replace(
  'echo "Vulkan0: Test GPU (1024 MiB, 512 MiB free)"',
  'echo "Available devices:"'
)
const BROKEN_SH = `#!/bin/sh
echo "error while loading shared libraries: libgomp.so.1: cannot open shared object file" >&2
exit 127
`

interface TarItem {
  name: string
  type?: string
  mode?: number
  body?: string | Buffer
  linkname?: string
  /** Header size, with no body written. Used to claim an entry over the cap. */
  claimedSize?: number
}

function tarHeader(opts: { name: string; mode: number; size: number; type: string; linkname: string }): Buffer {
  if (Buffer.byteLength(opts.name) > 100) throw new Error(`test tar name is longer than 100 bytes: ${opts.name}`)
  const buf = Buffer.alloc(512)
  buf.write(opts.name, 0, 'utf8')
  buf.write(opts.mode.toString(8).padStart(7, '0'), 100, 'ascii')
  buf.write('0000000', 108, 'ascii')
  buf.write('0000000', 116, 'ascii')
  buf.write(opts.size.toString(8).padStart(11, '0'), 124, 'ascii')
  buf.write('00000000000', 136, 'ascii')
  buf.fill(0x20, 148, 156)
  buf.write(opts.type, 156, 'ascii')
  if (opts.linkname) buf.write(opts.linkname, 157, 'utf8')
  buf.write('ustar ', 257, 'ascii')
  buf[263] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]!
  buf.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
  buf[154] = 0
  buf[155] = 0x20
  return buf
}

function tarGz(items: TarItem[]): Buffer {
  const parts: Buffer[] = []
  for (const item of items) {
    const type = item.type ?? '0'
    const body = Buffer.from(item.body ?? '')
    const structural = type === '5' || type === '2' || type === '1' || type === '6' || type === '3' || type === '4'
    const size = item.claimedSize ?? (structural ? 0 : body.length)
    parts.push(tarHeader({ name: item.name, mode: item.mode ?? 0o755, size, type, linkname: item.linkname ?? '' }))
    if (item.claimedSize === undefined && !structural && size > 0) {
      parts.push(body)
      const pad = (512 - (size % 512)) % 512
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function paxRecord(key: string, value: string): Buffer {
  const suffix = ` ${key}=${value}\n`
  let digits = 1
  let length = digits + suffix.length
  while (String(length).length !== digits) {
    digits = String(length).length
    length = digits + suffix.length
  }
  return Buffer.from(`${length}${suffix}`)
}

function archiveWith(script: string, extra: TarItem[] = [], tag = 'b1'): Buffer {
  return tarGz([
    { name: `llama-${tag}/`, type: '5', mode: 0o755 },
    { name: `llama-${tag}/llama`, mode: 0o755, body: script },
    { name: `llama-${tag}/readme`, mode: 0o644, body: 'notes' },
    { name: `llama-${tag}/libllama.so.0.6.0`, mode: 0o755, body: 'lib' },
    { name: `llama-${tag}/libllama.so.0`, type: '2', mode: 0o777, linkname: 'libllama.so.0.6.0' },
    { name: `llama-${tag}/libllama.so`, type: '2', mode: 0o777, linkname: 'libllama.so.0' },
    ...extra
  ])
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'llama-rel-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function rejects(promise: Promise<unknown>, code: ReleaseFailure, pattern?: RegExp): Promise<LlamaReleaseError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof LlamaReleaseError, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    assert.equal(err.code, code, err.message)
    if (pattern) assert.match(err.message, pattern, err.message)
    return err
  }
  assert.fail('expected a rejection')
}

console.log('parseBuildNumber and glibc')
{
  assert.equal(parseBuildNumber('0.4.0-dev (build 10826, commit 73a43d1f6)'), 10826)
  assert.equal(parseBuildNumber('version: 0.6.0-dev (build 11429, commit d81235049)'), 11429)
  assert.equal(parseBuildNumber('unknown'), null)
  assert.equal(parseBuildNumber('build '), null)
  ok('the build number comes out of both real version strings')

  assert.equal(glibcOlderThan('2.17'), true)
  assert.equal(glibcOlderThan('2.33'), true)
  assert.equal(glibcOlderThan('2.34'), false)
  assert.equal(glibcOlderThan('2.34.0'), false)
  assert.equal(glibcOlderThan('2.35'), false)
  assert.equal(glibcOlderThan('3.0'), false)
  assert.equal(glibcOlderThan(null), false)
  assert.equal(glibcOlderThan(''), false)
  assert.equal(glibcOlderThan('not a version'), false)
  ok('glibc older than 2.34 is refused, and an unknown version is not')

  const runtime = glibcRuntime()
  assert.ok(runtime === null || /^\d+\.\d+/.test(runtime))
  ok('the process report yields a glibc version or nothing')

  assert.deepEqual(vulkanDevices([{ id: 'Vulkan0' }, { id: 'ROCm0' }, { id: 'Vulkan12' }]), ['Vulkan0', 'Vulkan12'])
  assert.deepEqual(vulkanDevices([]), [])
  assert.match(noVulkanMessage(), /mesa-vulkan-drivers/)
  assert.match(noVulkanMessage(), /CPU build/)
  ok('a Vulkan device id is Vulkan0, and the hint names the driver packages')

  assert.deepEqual([...RELEASE_HOSTS], [
    'api.github.com',
    'github.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com'
  ])
  ok('the allowlist is the four GitHub release hosts')
}

console.log('\nchoosing an asset by exact name')
{
  const vulkan: ReleaseAsset = { name: VULKAN_NAME, size: 10, url: 'https://example.com/v', digest: `sha256:${'ab'.repeat(32)}` }
  const cpu: ReleaseAsset = { name: CPU_NAME, size: 10, url: 'https://example.com/c', digest: `sha256:${'cd'.repeat(32)}` }
  const cudart: ReleaseAsset = { name: 'cudart-llama-b1-bin-ubuntu-vulkan-x64.tar.gz', size: 10, url: 'https://example.com/r', digest: vulkan.digest }
  const arm: ReleaseAsset = { name: 'llama-b1-bin-ubuntu-vulkan-arm64.tar.gz', size: 10, url: 'https://example.com/a', digest: vulkan.digest }
  const snap: ReleaseAsset = { name: 'llama-b1-bin-win-snapdragon-vulkan-adreno.tar.gz', size: 10, url: 'https://example.com/s', digest: vulkan.digest }
  assert.equal(chooseAsset('vulkan', 'b1', [cpu, arm, snap, cudart, vulkan]).name, VULKAN_NAME)
  assert.equal(chooseAsset('cpu', 'b1', [vulkan, cpu]).name, CPU_NAME)
  ok('Vulkan and CPU are chosen by exact name, and cudart, arm64 and snapdragon are not')

  assert.throws(() => chooseAsset('vulkan', 'b1', [{ ...vulkan, name: 'llama-b2-bin-ubuntu-vulkan-x64.tar.gz' }]), (err: unknown) => err instanceof LlamaReleaseError && err.code === 'tag-mismatch')
  assert.throws(() => chooseAsset('vulkan', 'b1', [{ ...vulkan, digest: null }]), (err: unknown) => err instanceof LlamaReleaseError && err.code === 'unverified')
  assert.throws(() => chooseAsset('vulkan', 'b1', []), (err: unknown) => err instanceof LlamaReleaseError && err.code === 'no-asset')
  assert.throws(() => chooseAsset('vulkan', 'b1', [vulkan, vulkan]), (err: unknown) => err instanceof LlamaReleaseError && err.code === 'no-asset')
  assert.throws(() => chooseAsset('cpu', 'b1', [vulkan]), (err: unknown) => err instanceof LlamaReleaseError && err.code === 'no-asset')
  assert.throws(
    () => chooseAsset('vulkan', 'b1', [{ ...vulkan, size: MAX_ARCHIVE_BYTES + 1 }]),
    (err: unknown) => err instanceof LlamaReleaseError && err.code === 'too-large'
  )
  ok('a mismatched build number, a missing digest, no asset and an oversized asset are refused')
}

console.log('\nextraction')
{
  const previous = process.umask(0)
  try {
    await withDir(async (dir) => {
      const archive = join(dir, 'ok.tar.gz')
      await writeFile(archive, archiveWith(LLAMA_SH))
      const dest = await extractReleaseArchive(archive, dir, 'b1', 'vulkan')
      const llama = await lstat(join(dest, 'llama'))
      const notes = await lstat(join(dest, 'readme'))
      assert.equal(llama.mode & 0o777, 0o700)
      assert.equal(notes.mode & 0o777, 0o600)
      assert.equal(await readlink(join(dest, 'libllama.so')), 'libllama.so.0')
      assert.equal(await readlink(join(dest, 'libllama.so.0')), 'libllama.so.0.6.0')
      assert.equal((await readdir(dir)).some((name) => name.startsWith('.extract-')), false)
      ok('a GNU ustar archive unpacks, modes drop group and other, and a symlink chain in the folder is kept')
    })
  } finally {
    process.umask(previous)
  }

  await withDir(async (dir) => {
    const long = `llama-b1/${'n'.repeat(120)}`
    const archive = join(dir, 'pax.tar.gz')
    await writeFile(archive, tarGz([
      { name: 'llama-b1/', type: '5', mode: 0o755 },
      { name: 'llama-b1/llama', mode: 0o755, body: LLAMA_SH },
      { name: '././@PaxHeader', type: 'x', mode: 0o644, body: paxRecord('path', long) },
      { name: 'placeholder', mode: 0o644, body: 'pax-body' }
    ]))
    const dest = await extractReleaseArchive(archive, dir, 'b1', 'vulkan')
    assert.equal(await readFile(join(dest, 'n'.repeat(120)), 'utf8'), 'pax-body')
    assert.equal(await exists(join(dest, 'placeholder')), false)
    ok('a pax path override longer than the ustar name field is the file that is written')
  })

  await withDir(async (dir) => {
    const long = `llama-b1/${'g'.repeat(120)}`
    const archive = join(dir, 'gnu.tar.gz')
    await writeFile(archive, tarGz([
      { name: 'llama-b1/', type: '5', mode: 0o755 },
      { name: 'llama-b1/llama', mode: 0o755, body: LLAMA_SH },
      { name: '././@LongLink', type: 'L', mode: 0o644, body: Buffer.from(`${long}\0`) },
      { name: 'placeholder', mode: 0o644, body: 'gnu-body' }
    ]))
    const dest = await extractReleaseArchive(archive, dir, 'b1', 'vulkan')
    assert.equal(await readFile(join(dest, 'g'.repeat(120)), 'utf8'), 'gnu-body')
    ok('a GNU long name is honoured')
  })

  const unsafe: Array<{ label: string; items: TarItem[]; pattern: RegExp; leak?: string }> = [
    { label: 'a .. path', items: [{ name: 'llama-b1/../../leak-dotdot.txt', body: 'x' }], pattern: /leak-dotdot\.txt/ },
    { label: 'an absolute path', items: [{ name: join(tmpdir(), 'leak-absolute.txt'), body: 'x' }], pattern: /leak-absolute\.txt/, leak: join(tmpdir(), 'leak-absolute.txt') },
    { label: 'a hard link', items: [{ name: 'llama-b1/llama', type: '1', linkname: 'llama' }], pattern: /not a file, directory or symlink/ },
    { label: 'a symlink out of the folder', items: [{ name: 'llama-b1/llama', type: '2', linkname: '../outside' }], pattern: /symlink leaves the folder/ },
    { label: 'a symlink with a slash', items: [{ name: 'llama-b1/llama', type: '2', linkname: 'sub/file' }], pattern: /symlink leaves the folder/ },
    { label: 'a setuid bit', items: [{ name: 'llama-b1/', type: '5' }, { name: 'llama-b1/llama', mode: 0o4755, body: LLAMA_SH }], pattern: /setuid or setgid/ },
    { label: 'a setgid bit', items: [{ name: 'llama-b1/', type: '5' }, { name: 'llama-b1/llama', mode: 0o2755, body: LLAMA_SH }], pattern: /setuid or setgid/ },
    { label: 'a fifo', items: [{ name: 'llama-b1/llama', type: '6' }], pattern: /not a file, directory or symlink/ },
    { label: 'a pax path with ..', items: [
      { name: '././@PaxHeader', type: 'x', body: paxRecord('path', 'llama-b1/../../leak-pax.txt') },
      { name: 'placeholder', body: 'x' }
    ], pattern: /leak-pax\.txt/ }
  ]
  for (const case_ of unsafe) {
    await withDir(async (dir) => {
      const archive = join(dir, 'bad.tar.gz')
      await writeFile(archive, tarGz(case_.items))
      const error = await rejects(extractReleaseArchive(archive, dir, 'b1', 'vulkan'), 'unsafe-entry', case_.pattern)
      assert.equal(await exists(join(dir, 'b1-vulkan')), false, error.message)
      assert.equal((await readdir(dir)).some((name) => name.startsWith('.extract-')), false)
      if (case_.leak) assert.equal(await exists(case_.leak), false)
      if (case_.label.includes('..')) assert.equal(await exists(join(dir, 'leak-dotdot.txt')), false)
      ok(`${case_.label} is refused and nothing is left behind`)
    })
  }
  await rm(join(tmpdir(), 'leak-absolute.txt'), { force: true })
  await rm(join(tmpdir(), 'leak-pax.txt'), { force: true }).catch(() => undefined)

  await withDir(async (dir) => {
    const archive = join(dir, 'sum.tar.gz')
    const tar = gunzipSync(archiveWith(LLAMA_SH))
    tar[0] = tar[0]! ^ 0xff
    await writeFile(archive, gzipSync(tar))
    await rejects(extractReleaseArchive(archive, dir, 'b1', 'vulkan'), 'unsafe-entry', /checksum/)
    assert.equal(await exists(join(dir, 'b1-vulkan')), false)
    ok('a header whose checksum does not match is refused')
  })

  await withDir(async (dir) => {
    const archive = join(dir, 'big.tar.gz')
    await writeFile(archive, tarGz([{ name: 'llama-b1/llama', claimedSize: MAX_ARCHIVE_BYTES + 1, body: 'x' }]))
    await rejects(extractReleaseArchive(archive, dir, 'b1', 'vulkan'), 'unsafe-entry', /500 MB/)
    ok('an entry over 500 MB is refused before it is written')
  })
}

interface Hit {
  url: string
  headers: IncomingMessage['headers']
}

interface GithubCtx {
  apiBase: string
  apiHits: Hit[]
  cdnHits: Hit[]
  fx: Fixture
}

interface Fixture {
  pointer: string | null
  pointerDigest?: string | null
  tag: string
  archive: Buffer
  archiveName: string
  archiveDigest?: string | null
  archiveSize?: number
  list?: unknown[]
  latestStatus?: number
  latestHeaders?: Record<string, string>
  latestRedirect?: string
  transfer?: 'normal' | 'truncate' | 'stall' | 'trickle' | 'hang'
  extraAssets?: ReleaseAsset[]
}

async function withGithub(partial: Partial<Fixture>, fn: (ctx: GithubCtx) => Promise<void>): Promise<void> {
  const fx: Fixture = {
    pointer: 'b1\n',
    tag: 'b1',
    archive: archiveWith(LLAMA_SH),
    archiveName: VULKAN_NAME,
    transfer: 'normal',
    ...partial
  }
  const apiHits: Hit[] = []
  const cdnHits: Hit[] = []
  const cdn = await listen('127.0.0.2', (req, res) => {
    cdnHits.push({ url: req.url ?? '', headers: req.headers })
    const path = req.url ?? ''
    if (path === '/dl/nightly-tag.txt') return sendBytes(req, res, Buffer.from(fx.pointer ?? ''), 'normal')
    if (path === `/dl/${fx.archiveName}`) return sendBytes(req, res, fx.archive, fx.transfer ?? 'normal')
    res.writeHead(404).end('missing')
  })
  const api = await listen('127.0.0.1', (req, res) => {
    apiHits.push({ url: req.url ?? '', headers: req.headers })
    const path = req.url ?? ''
    if (path === '/repos/ggml-org/llama.cpp/releases/latest') {
      if (fx.latestRedirect) {
        res.writeHead(302, { location: fx.latestRedirect }).end()
        return
      }
      if (fx.latestStatus) {
        res.writeHead(fx.latestStatus, fx.latestHeaders ?? {}).end('{}')
        return
      }
      const assets = fx.pointer === null ? [] : [githubAsset(jsonAsset('nightly-tag.txt', Buffer.from(fx.pointer), `${api.origin}/dl/nightly-tag.txt`, fx.pointerDigest))]
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: 'v0.6.0', assets }))
      return
    }
    if (path === '/dl/nightly-tag.txt' || path === `/dl/${fx.archiveName}`) {
      res.writeHead(302, { location: `${cdn.origin}${path}` }).end()
      return
    }
    if (path === `/repos/ggml-org/llama.cpp/releases/tags/${fx.tag}`) {
      const archiveUrl = `${api.origin}/dl/${fx.archiveName}`
      const assets = [
        jsonAsset(fx.archiveName, fx.archive, archiveUrl, fx.archiveDigest, fx.archiveSize),
        jsonAsset(CPU_NAME, fx.archive, `${api.origin}/dl/${CPU_NAME}`, undefined, fx.archive.length),
        ...(fx.extraAssets ?? [])
      ].map(githubAsset)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: fx.tag, assets }))
      return
    }
    if (path.startsWith('/repos/ggml-org/llama.cpp/releases?')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fx.list ?? []))
      return
    }
    res.writeHead(404).end('missing')
  })
  try {
    await fn({ apiBase: api.origin, apiHits, cdnHits, fx })
  } finally {
    await api.close()
    await cdn.close()
  }
}

function jsonAsset(name: string, body: Buffer, url: string, digest: string | null | undefined, size?: number): ReleaseAsset {
  const hex = digest === undefined ? sha256(body) : digest
  return { name, size: size ?? body.length, url, digest: hex === null ? null : `sha256:${hex}` }
}

/** The GitHub release API calls the download link `browser_download_url`. */
function githubAsset(asset: ReleaseAsset): { name: string; size: number; browser_download_url: string; digest: string | null } {
  return { name: asset.name, size: asset.size, browser_download_url: asset.url, digest: asset.digest }
}

/** Gaps stay under the stall limit, and enough of them pass the old one-minute cap. */
function trickleGap(): number {
  return Math.floor(STALL_TIMEOUT_MS * 0.7)
}

function trickleWaits(): number {
  const gap = trickleGap()
  return Math.floor(REQUEST_TIMEOUT_MS / gap) + 1
}

function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  transfer: 'normal' | 'truncate' | 'stall' | 'trickle' | 'hang'
): void {
  const range = req.headers.range
  if (range && transfer === 'normal') {
    const match = /^bytes=(\d+)-$/.exec(String(range))
    const start = match ? Number(match[1]) : 0
    if (start > body.length) {
      res.writeHead(416).end()
      return
    }
    const slice = body.subarray(start)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
      'accept-ranges': 'bytes'
    })
    res.end(slice)
    return
  }
  if (transfer === 'truncate') {
    const half = body.subarray(0, Math.max(1, Math.floor(body.length / 2)))
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes'
    })
    res.end(half)
    return
  }
  if (transfer === 'stall') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes'
    })
    const first = body.subarray(0, Math.min(4096, body.length - 1))
    res.write(first)
    const timer = setTimeout(() => {
      if (!res.writableEnded) res.end(body.subarray(first.length))
    }, 4000)
    res.on('close', () => clearTimeout(timer))
    return
  }
  if (transfer === 'trickle') {
    req.socket?.setNoDelay(true)
    const gap = trickleGap()
    const waits = trickleWaits()
    const pieces = waits + 1
    const size = Math.max(1, Math.ceil(body.length / pieces))
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes'
    })
    let offset = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    const writeNext = (): void => {
      if (res.writableEnded || offset >= body.length) {
        if (!res.writableEnded) res.end()
        return
      }
      const next = body.subarray(offset, Math.min(body.length, offset + size))
      offset += next.length
      if (offset >= body.length) {
        res.end(next)
        return
      }
      res.write(next)
      timers.push(setTimeout(writeNext, gap))
    }
    res.on('close', () => {
      for (const timer of timers) clearTimeout(timer)
    })
    writeNext()
    return
  }
  if (transfer === 'hang') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes'
    })
    if (body.length > 0) res.write(body.subarray(0, 1))
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'accept-ranges': 'bytes'
  })
  res.end(body)
}

function listen(host: string, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        origin: `http://${host}:${port}`,
        close: () => new Promise((done, reject) => server.close((err) => (err ? reject(err) : done())))
      })
    })
  })
}

function clientFor(apiBase: string, glibc: string | null = '2.39', hosts = ['127.0.0.1', '127.0.0.2']): LlamaRelease {
  return new LlamaRelease({
    apiBase,
    allowedHosts: hosts,
    allowPrivate: true,
    glibc: () => glibc
  })
}

console.log('\ndownload')
{
  await withGithub({}, async ({ apiBase, apiHits, cdnHits }) => {
    await withDir(async (root) => {
      const client = clientFor(apiBase)
      const installed = await client.install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' })
      assert.equal(installed.tag, 'b1')
      assert.equal(installed.backend, 'vulkan')
      assert.equal(installed.binary.version, '0.6.0-dev (build 1, commit abc)')
      assert.deepEqual(vulkanDevices(installed.binary.devices), ['Vulkan0'])
      assert.equal(installed.llamaPath, join(root, 'b1-vulkan', 'llama'))
      assert.equal(await exists(join(root, '.downloads', VULKAN_NAME)), false)
      const latest = apiHits.find((hit) => hit.url === '/repos/ggml-org/llama.cpp/releases/latest')
      assert.ok(latest)
      assert.equal(latest.headers['user-agent'], `Lowerbeam/${VERSION}`)
      assert.equal(latest.headers['accept'], 'application/vnd.github+json')
      assert.equal(latest.headers['x-github-api-version'], '2022-11-28')
      assert.equal(latest.headers['authorization'], undefined)
      const fetched = cdnHits.find((hit) => hit.url === `/dl/${VULKAN_NAME}`)
      assert.ok(fetched)
      assert.equal(fetched.headers['user-agent'], `Lowerbeam/${VERSION}`)
      assert.equal(fetched.headers['x-github-api-version'], undefined)
      const cpu = await client.resolve('cpu', 'pinned')
      assert.equal(cpu.name, CPU_NAME)
      assert.equal(cdnHits.filter((hit) => hit.url === `/dl/${CPU_NAME}`).length, 0)
      ok('the pinned Vulkan build is verified, extracted and probed, and the CPU asset is not the Vulkan one')
    })
  })

  await withGithub({}, async ({ apiBase, cdnHits }) => {
    await withDir(async (root) => {
      const client = clientFor(apiBase)
      const installed = await client.install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' })
      const archives = (): number => cdnHits.filter((hit) => hit.url === `/dl/${VULKAN_NAME}`).length
      const before = archives()
      const again = await client.install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' })
      assert.equal(again.llamaPath, installed.llamaPath)
      assert.equal(archives(), before)
      await writeFile(installed.llamaPath, 'kept')
      await rejects(
        client.install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' }),
        'probe',
        /Use your own build/
      )
      assert.equal(await readFile(installed.llamaPath, 'utf8'), 'kept')
      ok('a build that is already there is used again, and a broken one is not deleted')
    })
  })

  await withDir(async (dir) => {
    await rejects(
      new LlamaRelease().download(
        { tag: 'b1', backend: 'vulkan', name: '..', url: 'https://github.com/unused', size: 4, digest: 'ab'.repeat(32) },
        dir
      ),
      'no-asset',
      /not a file name/
    )
    ok('an asset named .. is refused before anything is written')
  })

  await withGithub({}, async ({ apiBase, cdnHits }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      const first = await client.download(asset, dir)
      const hits = cdnHits.length
      const second = await client.download(asset, dir)
      assert.equal(second, first)
      assert.equal(cdnHits.length, hits)
      assert.equal(sha256(await readFile(first)), asset.digest)
      ok('a verified archive is not downloaded again')
    })
  })

  const newestArchive = archiveWith(LLAMA_SH)
  const newestAsset = jsonAsset('llama-b2-bin-ubuntu-vulkan-x64.tar.gz', newestArchive, 'http://127.0.0.1/unused')
  await withGithub({
    list: [
      { tag_name: 'v0.6.0', draft: false, assets: [] },
      { tag_name: 'b9', draft: true, assets: [] },
      { tag_name: 'b2', draft: false, assets: [githubAsset(newestAsset)] }
    ]
  }, async ({ apiBase, apiHits }) => {
    const asset = await clientFor(apiBase).resolve('vulkan', 'newest')
    assert.equal(asset.tag, 'b2')
    assert.equal(asset.name, 'llama-b2-bin-ubuntu-vulkan-x64.tar.gz')
    assert.ok(apiHits.some((hit) => hit.url.includes('per_page=5')))
    ok('newest skips a version tag and a draft, and takes the first bNNNN of the five')
  })

  await withGithub({ pointer: null }, async ({ apiBase }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'no-pointer', /nightly-tag\.txt/)
    ok('a latest release with no pointer says what was missing')
  })

  await withGithub({ pointer: 'latest\n' }, async ({ apiBase }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'bad-pointer', /latest/)
    ok('a pointer that is not bNNNN is refused')
  })

  await withGithub({ pointerDigest: sha256(Buffer.from('nope')) }, async ({ apiBase }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'unverified', /could not be verified/)
    ok('a pointer whose digest does not match is refused')
  })

  await withGithub({ tag: 'b1', archiveName: 'llama-b2-bin-ubuntu-vulkan-x64.tar.gz' }, async ({ apiBase, cdnHits }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'tag-mismatch', /b2/)
    assert.equal(cdnHits.some((hit) => hit.url.includes('llama-')), false)
    ok('an asset whose build number is not the tag is refused before download')
  })

  await withGithub({ archiveDigest: null }, async ({ apiBase, cdnHits }) => {
    await withDir(async (dir) => {
      const part = join(dir, `${VULKAN_NAME}.part`)
      await writeFile(part, 'partial')
      const client = clientFor(apiBase)
      await rejects(client.resolve('vulkan', 'pinned'), 'unverified', /no sha256 digest/)
      assert.equal(cdnHits.some((hit) => hit.url.includes(VULKAN_NAME)), false)
      const asset = {
        tag: 'b1',
        backend: 'vulkan' as const,
        name: VULKAN_NAME,
        url: 'http://127.0.0.1/unused',
        size: 7,
        digest: ''
      }
      await rejects(client.download(asset, dir), 'unverified', /no sha256 digest/)
      assert.equal(await exists(part), false)
      ok('a missing digest is refused and the partial file is deleted')
    })
  })

  await withGithub({ archiveDigest: 'ab'.repeat(32) }, async ({ apiBase }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      await writeFile(join(dir, `${asset.name}.part`), 'partial')
      await rejects(client.download(asset, dir), 'unverified', /could not be verified/)
      assert.equal(await exists(join(dir, `${asset.name}.part`)), false)
      assert.equal(await exists(join(dir, asset.name)), false)
      ok('a digest mismatch deletes the partial file')
    })
  })

  await withGithub({ archiveSize: archiveWith(LLAMA_SH).length + 10 }, async ({ apiBase }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      await writeFile(join(dir, `${asset.name}.part`), 'partial')
      await rejects(client.download(asset, dir), 'unverified', /could not be verified/)
      assert.equal(await exists(join(dir, `${asset.name}.part`)), false)
      ok('a size mismatch deletes the partial file')
    })
  })

  await withGithub({ transfer: 'truncate' }, async ({ apiBase, cdnHits }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      await rejects(client.download(asset, dir), 'offline', /Couldn't reach GitHub/)
      const part = await lstat(join(dir, `${asset.name}.part`))
      assert.ok(part.size > 0 && part.size < asset.size)
      const fxHits = cdnHits.length
      // The same server still truncates. Point the next attempt at a normal send
      // by using a fresh fixture below. Here, confirm the partial survived.
      assert.ok(fxHits >= 1)
      ok('a dropped connection keeps the partial file')
    })
  })

  await withGithub({ transfer: 'stall', archive: Buffer.alloc(128 * 1024, 7), archiveName: VULKAN_NAME }, async ({ apiBase }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      const controller = new AbortController()
      const error = await rejects(
        client.download(asset, dir, {
          signal: controller.signal,
          onProgress: (received) => {
            if (received > 0) controller.abort()
          }
        }),
        'cancelled',
        /cancelled/
      )
      void error
      const part = await lstat(join(dir, `${asset.name}.part`))
      assert.ok(part.size > 0 && part.size < asset.size)
      ok('cancel keeps the partial file')
    })
  })

  await withGithub({ transfer: 'trickle' }, async ({ apiBase }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      const started = Date.now()
      const file = await client.download(asset, dir)
      const elapsed = Date.now() - started
      assert.ok(elapsed > REQUEST_TIMEOUT_MS, `finished in ${elapsed} ms, inside the old cap`)
      assert.equal(sha256(await readFile(file)), asset.digest)
      ok('a download slower than one minute still verifies when bytes keep arriving')
    })
  })

  await withGithub({ transfer: 'hang' }, async ({ apiBase }) => {
    await withDir(async (dir) => {
      const client = clientFor(apiBase)
      const asset = await client.resolve('vulkan', 'pinned')
      const controller = new AbortController()
      // If the stall limit is missing, cancel rather than sit here until the suite is killed.
      const killer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS + 5_000)
      const started = Date.now()
      try {
        await rejects(client.download(asset, dir, { signal: controller.signal }), 'offline', /^Couldn't reach GitHub\.$/)
      } finally {
        clearTimeout(killer)
      }
      const elapsed = Date.now() - started
      assert.ok(elapsed >= STALL_TIMEOUT_MS, `stopped after ${elapsed} ms, before the stall limit`)
      assert.ok(elapsed < REQUEST_TIMEOUT_MS, `stopped after ${elapsed} ms, at the old cap`)
      const part = await lstat(join(dir, `${asset.name}.part`))
      assert.ok(part.size > 0 && part.size < asset.size)
      ok('a body that goes quiet for 30 seconds stops, and the partial file stays')
    })
  })

  await withGithub({ latestRedirect: 'https://evil.example/releases' }, async ({ apiBase }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'redirect', /evil\.example/)
    ok('a redirect off the allowlist is refused')
  })

  await withGithub({ latestRedirect: 'http://user:pass@127.0.0.2/dl/nightly-tag.txt' }, async ({ apiBase }) => {
    await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'redirect', /credentials/)
    ok('a redirect that carries credentials is refused')
  })

  await withGithub({ latestStatus: 403, latestHeaders: { 'x-ratelimit-reset': '1791744000' } }, async ({ apiBase }) => {
    const error = await rejects(clientFor(apiBase).resolve('vulkan', 'pinned'), 'rate-limit', /Try again after/)
    assert.equal(error.retryAt, new Date(1791744000 * 1000).toISOString())
    assert.match(error.message, new RegExp(error.retryAt!.replace(/[.]/g, '\\.')))
    ok('a rate limit says when to try again')
  })

  await withGithub({ archive: archiveWith(NO_VULKAN_SH) }, async ({ apiBase }) => {
    await withDir(async (root) => {
      const error = await rejects(
        clientFor(apiBase).install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' }),
        'no-vulkan',
        /mesa-vulkan-drivers/
      )
      assert.match(error.message, /CPU build/)
      assert.equal(await exists(join(root, 'b1-vulkan', 'llama')), true)
      ok('no Vulkan device leaves the build in place and names the CPU build')
    })
  })

  await withGithub({ archive: archiveWith(BROKEN_SH) }, async ({ apiBase }) => {
    await withDir(async (root) => {
      await rejects(
        clientFor(apiBase).install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' }),
        'probe',
        /libgomp\.so\.1/
      )
      assert.equal(await exists(join(root, 'b1-vulkan')), false)
      ok('a build that cannot load is not kept')
    })
  })

  await withGithub({}, async ({ apiBase, apiHits }) => {
    await withDir(async (root) => {
      const before = apiHits.length
      await rejects(
        clientFor(apiBase, '2.17').install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.17' }),
        'glibc',
        /2\.34/
      )
      assert.equal(apiHits.length, before)
      ok('glibc older than 2.34 makes no request')
    })
  })

  await withGithub({ latestStatus: 500 }, async ({ apiBase, apiHits }) => {
    await rejects(clientFor(apiBase, null).resolve('vulkan', 'pinned'), 'offline', /Couldn't reach GitHub/)
    assert.ok(apiHits.length > 0)
    ok('an unknown glibc does not block, and HTTP 500 is unreachable')
  })
}

console.log('\nresume, offline, loopback and old builds')
{
  const body = archiveWith(LLAMA_SH)
  const digest = sha256(body)
  const resumed = await resumePair(body, digest, VULKAN_NAME)
  assert.equal(resumed.range, true)
  assert.equal(sha256(await readFile(resumed.file)), digest)
  await rm(resumed.dir, { recursive: true, force: true })
  ok('a partial file resumes with Range and the digest is of the whole archive')

  const closed = await listen('127.0.0.1', (_req, res) => res.end())
  const port = new URL(closed.origin).port
  await closed.close()
  await rejects(clientFor(`http://127.0.0.1:${port}`).resolve('vulkan', 'pinned'), 'offline', /^Couldn't reach GitHub\.$/)
  ok('a refused connection says GitHub could not be reached')

  await rejects(
    new LlamaRelease({ apiBase: 'https://127.0.0.1:9', allowedHosts: ['127.0.0.1'], allowPrivate: false }).resolve('vulkan', 'pinned'),
    'blocked',
    /on this computer/
  )
  ok('loopback is refused unless a test opts in')

  await withDir(async (root) => {
    for (const build of ['b1-vulkan', 'b2-cpu', 'b10-vulkan']) {
      await mkdir(join(root, build))
      await writeFile(join(root, build, 'llama'), 'x')
    }
    await writeFile(join(root, 'notes.txt'), 'keep')
    const outside = await mkdtemp(join(tmpdir(), 'llama-outside-'))
    try {
      await writeFile(join(outside, 'secret'), 'no')
      await symlink(outside, join(root, 'b9-vulkan'))
      const removed = await pruneOldBuilds(root, join(root, 'b1-vulkan', 'llama'))
      assert.deepEqual(removed, ['b2-cpu'])
      assert.equal(await exists(join(root, 'b1-vulkan', 'llama')), true)
      assert.equal(await exists(join(root, 'b10-vulkan', 'llama')), true)
      assert.equal(await exists(join(root, 'b9-vulkan')), true)
      assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'no')
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'keep')
      ok('prune keeps the running build and the newest other one, and does not follow a symlink')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
}

async function resumePair(body: Buffer, digest: string, name: string): Promise<{ file: string; range: boolean; dir: string }> {
  let full = false
  const cdnHits: Hit[] = []
  const pointer = Buffer.from('b1\n')
  const cdn = await listen('127.0.0.2', (req, res) => {
    cdnHits.push({ url: req.url ?? '', headers: req.headers })
    if ((req.url ?? '') === '/dl/nightly-tag.txt') return sendBytes(req, res, pointer, 'normal')
    sendBytes(req, res, body, full ? 'normal' : 'truncate')
  })
  const api = await listen('127.0.0.1', (req, res) => {
    const path = req.url ?? ''
    if (path.endsWith('/releases/latest')) {
      const pointer = Buffer.from('b1\n')
      res.writeHead(200).end(JSON.stringify({
        tag_name: 'v0.6.0',
        assets: [{
          name: 'nightly-tag.txt',
          size: pointer.length,
          browser_download_url: `${cdn.origin}/dl/nightly-tag.txt`,
          digest: `sha256:${sha256(pointer)}`
        }]
      }))
      return
    }
    if (path.endsWith('/releases/tags/b1')) {
      res.writeHead(200).end(JSON.stringify({
        tag_name: 'b1',
        assets: [{
          name,
          size: body.length,
          browser_download_url: `${cdn.origin}/dl/${name}`,
          digest: `sha256:${digest}`
        }]
      }))
      return
    }
    if (path === '/dl/nightly-tag.txt') {
      res.writeHead(302, { location: `${cdn.origin}${path}` }).end()
      return
    }
    res.writeHead(404).end()
  })
  const dir = await mkdtemp(join(tmpdir(), 'llama-resume-'))
  try {
    const client = clientFor(api.origin)
    const asset = await client.resolve('vulkan', 'pinned')
    await rejects(client.download(asset, dir), 'offline')
    full = true
    const file = await client.download(asset, dir)
    const ranged = cdnHits.some((hit) => typeof hit.headers.range === 'string' && /^bytes=\d+-$/.test(hit.headers.range))
    return { file, range: ranged, dir }
  } finally {
    await api.close()
    await cdn.close()
  }
}

function versionedLlama(build: number): string {
  return LLAMA_SH.replace('build 1', `build ${build}`)
}

function pointAt(fx: Fixture, tag: string, script: string): void {
  fx.pointer = `${tag}\n`
  fx.tag = tag
  fx.archiveName = `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`
  fx.archive = archiveWith(script, [], tag)
  fx.archiveDigest = undefined
  fx.archiveSize = undefined
  fx.transfer = 'normal'
}

console.log('\nupdate check')
{
  await withGithub({}, async ({ apiBase, apiHits, cdnHits, fx }) => {
    await withDir(async (root) => {
      const client = clientFor(apiBase)
      const settings = new SettingsStore(join(root, 'settings.json'))
      await settings.load()
      const installed = await client.install({ root, backend: 'vulkan', channel: 'pinned', glibc: () => '2.39' })
      await rememberManagedBuild(settings, installed, '2026-10-11T00:00:00.000Z')
      await settings.patch({ llamaUpdateCheck: true })
      const archives = (): number => cdnHits.filter((hit) => hit.url.includes('/dl/llama-')).length
      assert.equal(archives(), 1)
      const resolve = (backend: 'vulkan' | 'cpu') => client.resolve(backend, 'pinned')
      let now = new Date('2026-10-11T00:00:00.000Z')
      const current = (): string => settings.current.managedBuild?.path ?? ''

      const quiet = apiHits.length
      assert.equal(
        await runLlamaUpdateCheck({ settings, currentPath: '/usr/bin/llama', now, resolve }),
        'skipped'
      )
      await settings.patch({ llamaUpdateCheck: false })
      assert.equal(await runLlamaUpdateCheck({ settings, currentPath: current(), now, resolve }), 'skipped')
      await settings.patch({ llamaUpdateCheck: true })
      assert.equal(apiHits.length, quiet)
      ok('the check does not ask GitHub for a binary the person chose, or while it is off')

      assert.equal(await runLlamaUpdateCheck({ settings, currentPath: current(), now, resolve }), 'checked')
      assert.equal(settings.current.llamaUpdateOffer, null)
      assert.equal(archives(), 1)
      const asked = apiHits.length
      assert.equal(await runLlamaUpdateCheck({ settings, currentPath: current(), now, resolve }), 'skipped')
      assert.equal(apiHits.length, asked)
      ok('an equal pinned build is not offered, and the same day does not ask again')

      const saved = settings.current.managedBuild
      assert.ok(saved)
      await settings.patch({ managedBuild: { ...saved, tag: 'b2' } })
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000)
      assert.equal(await runLlamaUpdateCheck({ settings, currentPath: current(), now, resolve }), 'checked')
      assert.equal(settings.current.llamaUpdateOffer, null)
      await settings.patch({ managedBuild: saved })
      ok('an older pinned build is not offered')

      pointAt(fx, 'b2', versionedLlama(2))
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000)
      const beforeOffer = archives()
      assert.equal(await runLlamaUpdateCheck({ settings, currentPath: current(), now, resolve }), 'checked')
      assert.equal(settings.current.llamaUpdateOffer?.tag, 'b2')
      assert.equal(archives(), beforeOffer)
      ok('a newer pinned build is offered without downloading the archive')

      pointAt(fx, 'b2', BROKEN_SH)
      await assert.rejects(
        installOfferedUpdate({
          settings,
          client,
          root,
          currentPath: current(),
          assertStopped: () => {}
        }),
        (err: unknown) => err instanceof LlamaReleaseError && err.code === 'probe'
      )
      assert.equal(settings.current.managedBuild?.tag, 'b1')
      assert.equal(settings.current.binaryPath, saved.path)
      assert.equal(settings.current.llamaRollback, null)
      assert.equal(await exists(join(root, 'b2-vulkan')), false)
      assert.match(await readFile(join(root, 'b1-vulkan', 'llama'), 'utf8'), /build 1/)
      ok('a new build that fails the probe does not replace the managed one')

      pointAt(fx, 'b2', versionedLlama(2))
      const updated = await installOfferedUpdate({
        settings,
        client,
        root,
        currentPath: current(),
        assertStopped: () => {}
      })
      assert.equal(updated.tag, 'b2')
      assert.equal(parseBuildNumber(updated.binary.version), 2)
      assert.equal(settings.current.managedBuild?.tag, 'b2')
      assert.equal(settings.current.binaryPath, updated.llamaPath)
      assert.equal(settings.current.llamaRollback?.tag, 'b1')
      assert.equal(settings.current.llamaUpdateOffer, null)
      assert.equal(await exists(join(root, 'b1-vulkan', 'llama')), true)
      assert.match(await readFile(join(root, 'b1-vulkan', 'llama'), 'utf8'), /build 1/)
      ok('the managed build changes only after the new probe passes, and the previous build stays')

      const beforeBack = archives()
      const back = await restorePreviousBuild({
        settings,
        root,
        currentPath: updated.llamaPath,
        assertStopped: () => {},
        probe: (path) => probeBinary({ path, kind: 'unified' })
      })
      assert.equal(parseBuildNumber(back.version), 1)
      assert.equal(settings.current.managedBuild?.tag, 'b1')
      assert.equal(settings.current.binaryPath, saved.path)
      assert.equal(settings.current.llamaRollback, null)
      assert.equal(settings.current.llamaUpdateOffer?.tag, 'b2')
      assert.equal(archives(), beforeBack)
      assert.equal(await exists(join(root, 'b2-vulkan', 'llama')), true)
      ok('go back selects the kept build and does not download it')
    })
  })
}

console.log(`\n${n} assertions passed`)
