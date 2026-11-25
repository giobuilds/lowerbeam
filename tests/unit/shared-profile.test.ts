import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createPublicKey } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BinaryInfo, GpuDevice, GpuSensor, LaunchConfig } from '@shared/types.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import {
  CATALOG_INDEX_URL,
  catalogFileUrl,
  catalogUrlAllowed,
  comparisonLine,
  describeLaunch,
  draftFromOffer,
  matchBackend,
  matchShared,
  matchVram,
  measurementIssueUrl,
  sharedOffer,
  sharedProfileSchema,
  shouldHashModel,
  urlHidesPath,
  type MatchMachine,
  type MatchModel,
  type SharedProfile
} from '@shared/sharedProfile.js'
import { NetworkGate } from '../../src/main/network.js'
import { ProfileCatalog } from '../../src/main/profileCatalog.js'
import { ProfileHashes } from '../../src/main/profileHashes.js'
import { confirmLocalSpeed } from '../../src/main/profileConfirm.js'
import { machineForProfiles } from '../../src/main/profileMachine.js'
import { PROFILE_CATALOG_PUBLIC_KEY, sha256Bytes, verifyCatalogSignature } from '../../src/main/profileTrust.js'

let n = 0
const ok = (message: string, fn?: () => void): void => {
  fn?.()
  n++
  console.log('  ok', message)
}

const SHA = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

function row(patch: {
  gpu?: Partial<SharedProfile['gpu']>
  model?: Partial<SharedProfile['model']>
  llamacpp?: Partial<SharedProfile['llamacpp']>
  launch?: Partial<SharedProfile['launch']>
  measured?: Partial<SharedProfile['measured']>
} = {}): SharedProfile {
  const base: SharedProfile = {
    schema: 1,
    gpu: {
      vendorId: '0x1002',
      deviceId: '0x73ff',
      name: 'AMD Radeon RX 6600',
      vramMiB: 8176,
      backend: 'vulkan',
      driver: 'RADV Mesa 25.2'
    },
    model: {
      sha256: SHA,
      file: 'model.gguf',
      arch: 'qwen2',
      paramsB: 9,
      quant: 'Q4_K_M',
      bytes: 1000
    },
    llamacpp: { build: 10826, minBuild: 10800 },
    launch: {
      fit: true,
      ctx: null,
      gpuLayers: null,
      parallel: 1,
      kvType: 'f16',
      flashAttn: 'on',
      mmproj: 'cpu',
      spec: 'off'
    },
    measured: {
      genTokPerSec: 36.5,
      promptTokPerSec: null,
      peakVramMiB: 7140,
      contextGot: 11776,
      on: '2026-10-10',
      runs: 1
    },
    source: { kind: 'maintainer', ref: '#169', reports: 1, days: 1 }
  }
  const merged = {
    ...base,
    ...patch,
    gpu: { ...base.gpu, ...patch.gpu },
    model: { ...base.model, ...patch.model },
    llamacpp: { ...base.llamacpp, ...patch.llamacpp },
    launch: { ...base.launch, ...patch.launch },
    measured: { ...base.measured, ...patch.measured },
    source: base.source
  }
  const parsed = sharedProfileSchema.safeParse(merged)
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.data
}

const machine: MatchMachine = {
  vendorId: '0x1002',
  deviceId: '0x73ff',
  vramMiB: 8176,
  backend: 'vulkan',
  build: 10826,
  driver: 'RADV Mesa 25.2'
}
const model: MatchModel = { sha256: SHA, arch: 'qwen2', quant: 'Q4_K_M', paramsB: 9 }

console.log('matching')
{
  const loose = row({
    gpu: { deviceId: '0x1111', vramMiB: 8192 },
    model: { sha256: OTHER },
    measured: { genTokPerSec: 1 }
  })
  const exactLate = row({ measured: { genTokPerSec: 99 } })
  const exactFirst = row({ measured: { genTokPerSec: 10 } })
  const hit = matchShared([loose, exactFirst, exactLate], machine, model)
  assert.equal(hit?.kind, 'exact')
  assert.equal(hit?.profile.measured.genTokPerSec, 10)
  ok('exact wins over an earlier loose row, and the first exact row wins a tie')

  const close = matchShared(
    [row({ gpu: { deviceId: '0x2222', vramMiB: 8176 + 256 } })],
    machine,
    model
  )
  assert.equal(close?.kind, 'close')
  assert.match(close?.driverNote ?? '', /^$/)
  assert.equal(close?.buildWarning, null)
  ok('same model within 256 MiB, on a different card, is a close match')

  const tooFar = matchShared(
    [row({ gpu: { deviceId: '0x2222', vramMiB: 8176 + 257 }, model: { arch: 'other' } })],
    machine,
    model
  )
  assert.equal(tooFar, null)
  ok('257 MiB away is not a close match')

  const suggested = matchShared(
    [row({ gpu: { deviceId: '0x2222', vramMiB: 8176 + 257 }, model: { sha256: OTHER } })],
    machine,
    model
  )
  assert.equal(suggested?.kind, 'loose')
  assert.equal(draftFromOffer(sharedOffer(false, suggested), '/m.gguf', null), null)
  ok('same bucket, arch, quant and size is a suggestion and is not applied')

  assert.equal(
    matchShared([row({ model: { sha256: OTHER, paramsB: 12 } })], machine, model),
    null
  )
  ok('a parameter size more than about 10% off is not a loose match')

  assert.equal(matchShared([row()], { ...machine, backend: null }, model), null)
  ok('CUDA or ROCm is not a catalog backend, so nothing matches')

  assert.equal(sharedOffer(true, matchShared([row()], machine, model)), null)
  ok('a measurement already on this machine hides the shared row')

  const farBuild = matchShared([row()], { ...machine, build: 10826 + 501 }, model)
  assert.equal(farBuild?.kind, 'exact')
  assert.match(farBuild?.buildWarning ?? '', /10826/)
  assert.match(farBuild?.buildWarning ?? '', /11327/)
  assert.equal(matchShared([row()], { ...machine, build: 10826 + 500 }, model)?.buildWarning, null)
  ok('a build more than 500 away is still applied, with a warning')

  const older = matchShared(
    [row({ llamacpp: { build: 10900, minBuild: 11000 } })],
    { ...machine, build: 10900 },
    model
  )
  assert.match(older?.buildWarning ?? '', /11000/)
  ok('a machine below the profile’s minimum build is warned')

  const noted = matchShared([row()], { ...machine, driver: 'amdgpu 24.1' }, model)
  assert.match(noted?.driverNote ?? '', /25\.2/)
  assert.match(noted?.driverNote ?? '', /24\.1/)
  assert.equal(matchShared([row()], { ...machine, driver: 'Mesa 25.9' }, model)?.driverNote, null)
  ok('a different driver major is shown and does not block')
}

console.log('\nlaunch and the issue form')
{
  const fitted = draftFromOffer(
    sharedOffer(false, matchShared([row({ launch: { gpuLayers: 20, ctx: 8192 } })], machine, model)),
    '/models/m.gguf',
    '/models/mmproj.gguf'
  )
  assert.equal(fitted?.autoFit, true)
  assert.equal(fitted?.gpuLayers, DEFAULT_LAUNCH_CONFIG.gpuLayers)
  assert.equal(fitted?.contextSize, DEFAULT_LAUNCH_CONFIG.contextSize)
  assert.equal(fitted?.parallel, 1)
  assert.equal(fitted?.cacheTypeK, 'f16')
  assert.equal(fitted?.cacheTypeV, 'f16')
  assert.equal(fitted?.mmprojOffload, false)
  assert.equal(fitted?.mmprojPath, '/models/mmproj.gguf')
  ok('a fit profile does not pin context or GPU layers, and a CPU projector stays off the GPU')

  const pinned = launchOf(row({ launch: { fit: false, ctx: 8192, gpuLayers: 20, parallel: 2, kvType: 'q8_0', flashAttn: 'off', mmproj: 'off', spec: 'draft' } }))
  assert.equal(pinned.autoFit, false)
  assert.equal(pinned.contextSize, 8192)
  assert.equal(pinned.gpuLayers, 20)
  assert.equal(pinned.parallel, 2)
  assert.equal(pinned.cacheTypeK, 'q8_0')
  assert.equal(pinned.cacheTypeV, 'q8_0')
  assert.equal(pinned.flashAttn, false)
  assert.equal(pinned.speculative, 'draft')
  assert.equal(pinned.mmprojPath, null)
  ok('a profile that is not fit writes the context, layers, cache, attention and speculative mode')

  const settings = describeLaunch({ ...pinned, mmprojPath: '/secret/mmproj.gguf', mmprojOffload: true })
  assert.ok(!settings.includes('secret'))
  assert.match(settings, /projector on GPU/)
  ok('the form describes the projector without its path')

  const url = measurementIssueUrl({
    version: 'v'.repeat(600),
    gpu: 'AMD Radeon RX 6600, 8176 MiB, 0x1002:0x73ff',
    llamacpp: 'build 10826 (Vulkan)',
    model: 'model.gguf Q4_K_M',
    context: '11776',
    settings,
    speed: '34 tok/s generation',
    vram: '',
    notes: 'Measured inside Lowerbeam.'
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/giobuilds/lowerbeam/issues/new')
  assert.equal(parsed.searchParams.get('template'), 'measurement.yml')
  assert.equal(parsed.searchParams.get('version')?.length, 500)
  assert.equal(urlHidesPath(url, '/home/keeper/models/model.gguf'), true)
  assert.equal(urlHidesPath(`${url}&x=/home/keeper/models`, '/home/keeper/models/model.gguf'), false)
  assert.equal(comparisonLine(36.5, 34), 'Shared profile says 36.5 tok/s. This machine got 34.')
  ok('the issue form is pre-filled, clipped, and does not carry the model’s directory')

  assert.equal(shouldHashModel([row()], 'model.gguf', 1000), true)
  assert.equal(shouldHashModel([row()], 'model.gguf', 1001), false)
  assert.equal(shouldHashModel([row()], 'other.gguf', 1000), false)
  ok('a model file is hashed only when a row names that file and that size')
}

function launchOf(profile: SharedProfile): LaunchConfig {
  const launch = draftFromOffer(sharedOffer(false, matchShared([profile], machine, model)), '/models/m.gguf', '/models/mmproj.gguf')
  if (!launch) throw new Error('expected a launch')
  return launch
}

console.log('\nthis machine')
{
  assert.equal(matchBackend({ managedBackend: 'vulkan', deviceIds: ['ROCm0'] }), 'vulkan')
  assert.equal(matchBackend({ managedBackend: null, deviceIds: ['Vulkan0'] }), 'vulkan')
  assert.equal(matchBackend({ managedBackend: null, deviceIds: ['ROCm0'] }), null)
  assert.equal(matchBackend({ managedBackend: null, deviceIds: [] }), 'cpu')
  assert.equal(matchVram(8176, 8000), 8176)
  assert.equal(matchVram(null, 8000), 8000)
  assert.equal(matchVram(null, null), 0)
  ok('vulkan, cpu and a managed build are the backends a profile can name')

  const binary = (over: Partial<BinaryInfo> & Pick<BinaryInfo, 'path' | 'devices' | 'version'>): BinaryInfo => ({
    kind: 'llama-server',
    argvPrefix: [],
    flags: [],
    flagDocs: [],
    flashAttnStyle: 'value',
    label: 'test',
    ...over
  })
  const device = (id: string, totalMiB: number): GpuDevice => ({ id, name: id, totalMiB, freeMiB: totalMiB })
  const sensor = (over: Partial<GpuSensor> = {}): GpuSensor => ({
    id: 'card1',
    vendor: 'amd',
    vendorId: '0x1002',
    deviceId: '0x73ff',
    name: 'AMD Radeon RX 6600',
    vramMiB: 8176,
    tempC: null,
    junctionC: null,
    powerW: null,
    powerLimitW: null,
    clockMHz: null,
    clockMaxMHz: null,
    limit: null,
    ...over
  })
  const pictured = machineForProfiles({
    binary: binary({
      path: '/opt/llama',
      version: '0.6.0-dev (build 11429, commit abc)',
      devices: [device('Vulkan0', 8000)]
    }),
    managed: null,
    sensors: [sensor()]
  })
  assert.equal(pictured.backend, 'vulkan')
  assert.equal(pictured.vramMiB, 8176)
  assert.equal(pictured.vendorId, '0x1002')
  assert.equal(pictured.deviceId, '0x73ff')
  assert.equal(pictured.build, 11429)
  assert.equal(pictured.name, 'AMD Radeon RX 6600')
  const managed = machineForProfiles({
    binary: binary({ path: '/opt/llama', version: 'no build', devices: [device('ROCm0', 8000)] }),
    managed: { tag: 'b1', backend: 'cpu', path: '/opt/llama', digest: 'ab'.repeat(32), installedAt: '2026-01-01T00:00:00Z' },
    sensors: []
  })
  assert.equal(managed.backend, 'cpu')
  assert.equal(managed.vramMiB, 8000)
  ok('the paired sensor’s VRAM and PCI ids are what a profile is matched against')
}

console.log('\nsignature')
{
  const empty = new TextEncoder().encode('{\n  "schema": 1,\n  "files": []\n}\n')
  const emptySig = 'g8O9neQbPpaPvkw5Vsx6b6ZqfYuESnGKFNqL8q3zp60wWKX7SaLn87bOXgZ6ktMUpnGmyfpdkdOvtlw4IFnaBQ=='
  assert.equal(verifyCatalogSignature(empty, `${emptySig}\n`, PROFILE_CATALOG_PUBLIC_KEY), true)
  const flipped = new Uint8Array(empty)
  flipped[0] = flipped[0]! ^ 1
  assert.equal(verifyCatalogSignature(flipped, emptySig, PROFILE_CATALOG_PUBLIC_KEY), false)
  const other = generateKeyPairSync('ed25519')
  const otherSig = sign(null, empty, other.privateKey).toString('base64')
  assert.equal(verifyCatalogSignature(empty, otherSig, PROFILE_CATALOG_PUBLIC_KEY), false)
  const shipped = createPublicKey({
    key: Buffer.from(PROFILE_CATALOG_PUBLIC_KEY, 'base64'),
    format: 'der',
    type: 'spki'
  })
  assert.equal(shipped.asymmetricKeyType, 'ed25519')
  ok('the shipped key verifies the empty catalog, and another key’s signature does not')

  assert.equal(catalogUrlAllowed(CATALOG_INDEX_URL), true)
  assert.equal(catalogUrlAllowed(`${CATALOG_INDEX_URL}.sig`), true)
  assert.equal(catalogUrlAllowed(catalogFileUrl('row0.json') ?? ''), true)
  assert.equal(catalogFileUrl('../x'), null)
  assert.equal(catalogFileUrl('a..b'), null)
  assert.equal(catalogUrlAllowed('http://raw.githubusercontent.com/giobuilds/lowerbeam-profiles/main/index.json'), false)
  assert.equal(catalogUrlAllowed('https://example.com/giobuilds/lowerbeam-profiles/main/index.json'), false)
  assert.equal(catalogUrlAllowed('https://raw.githubusercontent.com/other/lowerbeam-profiles/main/index.json'), false)
  assert.equal(catalogUrlAllowed('https://user:pw@raw.githubusercontent.com/giobuilds/lowerbeam-profiles/main/index.json'), false)
  assert.equal(catalogUrlAllowed(`${CATALOG_INDEX_URL}?x=1`), false)
  assert.equal(catalogUrlAllowed('https://raw.githubusercontent.com/giobuilds/lowerbeam-profiles/main/../index.json'), false)
  ok('catalog requests stay on the raw GitHub host for that repository')
}

function signed(profiles: SharedProfile[], names?: string[]) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64')
  const files = profiles.map((profile, index) => {
    const body = Buffer.from(JSON.stringify(profile))
    return { name: names?.[index] ?? `row${index}.json`, body, sha256: sha256Bytes(body) }
  })
  const index = Buffer.from(JSON.stringify({ schema: 1, files: files.map(({ name, sha256 }) => ({ name, sha256 })) }))
  const sig = sign(null, index, privateKey).toString('base64')
  const blobs = new Map<string, { status: number; body: Uint8Array | null }>()
  blobs.set(CATALOG_INDEX_URL, { status: 200, body: index })
  blobs.set(`${CATALOG_INDEX_URL}.sig`, { status: 200, body: Buffer.from(sig) })
  for (const file of files) {
    const url = catalogFileUrl(file.name)
    if (url) blobs.set(url, { status: 200, body: file.body })
  }
  return { spki, blobs, index, sig, privateKey }
}

async function catalogWith(blobs: Map<string, { status: number; body: Uint8Array | null }>, spki: string, gate = new NetworkGate()) {
  const dir = await mkdtemp(join(tmpdir(), 'lb-profiles-'))
  const calls: string[] = []
  let seen: string[] = []
  const catalog = new ProfileCatalog(dir, gate, {
    publicKey: spki,
    get: async (url) => {
      calls.push(url)
      seen = gate.view().active
      return blobs.get(url) ?? { status: 404, body: null }
    }
  })
  return { dir, catalog, calls, seen: () => seen, gate }
}

console.log('\ncatalog')
{
  const good = signed([row(), row({ model: { file: 'other.gguf', sha256: OTHER }, measured: { genTokPerSec: 12 } })])
  const { dir, catalog, calls, seen } = await catalogWith(good.blobs, good.spki)
  await catalog.refresh()
  assert.deepEqual(seen(), ['Shared profiles'])
  assert.deepEqual(catalog.rows().map((item) => item.model.file), ['model.gguf', 'other.gguf'])
  assert.deepEqual((await catalogWith(good.blobs, good.spki)).catalog.rows(), [])
  const again = new ProfileCatalog(dir, new NetworkGate(), {
    publicKey: good.spki,
    get: async () => {
      throw new Error('load must not fetch')
    }
  })
  await again.load()
  assert.equal(again.rows().length, 2)
  ok('a signed catalog is kept, a fetch is named on the badge, and loading the cache does not fetch')

  const tampered = signed([row(), row({ model: { file: 'other.gguf', sha256: OTHER } })])
  const tamperedRun = await catalogWith(tampered.blobs, tampered.spki)
  await tamperedRun.catalog.refresh()
  const otherUrl = catalogFileUrl('row0.json')
  if (!otherUrl) throw new Error('url')
  tampered.blobs.set(otherUrl, { status: 200, body: Buffer.from('{"schema":1}') })
  await tamperedRun.catalog.refresh()
  assert.deepEqual(tamperedRun.catalog.rows().map((item) => item.model.file), ['other.gguf'])
  ok('a file whose bytes do not match the index is refused, and the other row stays')

  const kept = signed([row()])
  const keptRun = await catalogWith(kept.blobs, kept.spki)
  await keptRun.catalog.refresh()
  const index = kept.blobs.get(CATALOG_INDEX_URL)
  if (!index?.body) throw new Error('index')
  const broken = new Uint8Array(index.body)
  broken[broken.length - 2] = broken[broken.length - 2]! ^ 1
  kept.blobs.set(CATALOG_INDEX_URL, { status: 200, body: broken })
  await keptRun.catalog.refresh()
  assert.equal(keptRun.catalog.rows().length, 1)
  ok('a bad signature does not replace a good cache')

  kept.blobs.set(CATALOG_INDEX_URL, { status: 404, body: null })
  await keptRun.catalog.refresh()
  assert.equal(keptRun.catalog.rows().length, 1)
  const fileUrl = catalogFileUrl('row0.json')
  if (!fileUrl) throw new Error('file url')
  kept.blobs.set(CATALOG_INDEX_URL, { status: 200, body: index.body })
  kept.blobs.set(fileUrl, { status: 404, body: null })
  await keptRun.catalog.refresh()
  assert.equal(keptRun.catalog.rows().length, 1)
  ok('a missing index or a missing file keeps the last verified catalog')

  const emptyIndex = Buffer.from(JSON.stringify({ schema: 1, files: [] }))
  const emptySig = sign(null, emptyIndex, kept.privateKey).toString('base64')
  kept.blobs.set(CATALOG_INDEX_URL, { status: 200, body: emptyIndex })
  kept.blobs.set(`${CATALOG_INDEX_URL}.sig`, { status: 200, body: Buffer.from(emptySig) })
  await keptRun.catalog.refresh()
  assert.equal(keptRun.catalog.rows().length, 0)
  ok('a signed empty catalog is an empty list, not a failure')

  const seed = signed([row()])
  const seeded = await catalogWith(seed.blobs, seed.spki)
  await seeded.catalog.refresh()
  const badNameIndex = Buffer.from(JSON.stringify({ schema: 1, files: [{ name: 'a..b', sha256: SHA }] }))
  seed.blobs.set(CATALOG_INDEX_URL, { status: 200, body: badNameIndex })
  seed.blobs.set(`${CATALOG_INDEX_URL}.sig`, {
    status: 200,
    body: Buffer.from(sign(null, badNameIndex, seed.privateKey).toString('base64'))
  })
  await seeded.catalog.refresh()
  assert.equal(seeded.catalog.rows().length, 1)
  const tooMany = {
    schema: 1,
    files: Array.from({ length: 201 }, (_, index) => ({ name: `f${index}.json`, sha256: SHA }))
  }
  const tooManyBody = Buffer.from(JSON.stringify(tooMany))
  seed.blobs.set(CATALOG_INDEX_URL, { status: 200, body: tooManyBody })
  seed.blobs.set(`${CATALOG_INDEX_URL}.sig`, { status: 200, body: Buffer.from(sign(null, tooManyBody, seed.privateKey).toString('base64')) })
  await seeded.catalog.refresh()
  assert.equal(seeded.catalog.rows().length, 1)
  ok('a name with .. or more than 200 files does not replace the cache')
  assert.ok(calls.length > 0)
}

console.log('\ncache on disk')
{
  const pack = signed([row()])
  const { dir, catalog } = await catalogWith(pack.blobs, pack.spki)
  await catalog.refresh()
  await writeFile(join(dir, 'index.json.sig'), 'not-a-signature\n')
  const reloaded = new ProfileCatalog(dir, new NetworkGate(), { publicKey: pack.spki, get: async () => { throw new Error('no fetch') } })
  await reloaded.load()
  assert.deepEqual(reloaded.rows(), [])
  ok('a cached catalog with a bad signature is not used')

  const offline = new NetworkGate(true)
  const blocked = await catalogWith(pack.blobs, pack.spki, offline)
  await blocked.catalog.refresh()
  assert.equal(blocked.calls.length, 0)
  assert.deepEqual(blocked.catalog.rows(), [])
  ok('offline does not fetch, and does not invent rows')
}

console.log('\nhashes and the local check')
{
  const dir = await mkdtemp(join(tmpdir(), 'lb-hashes-'))
  const hashes = new ProfileHashes(join(dir, 'profile-hashes.json'), 2)
  const fileA = join(dir, 'a.gguf')
  const fileB = join(dir, 'b.gguf')
  const fileC = join(dir, 'c.gguf')
  await writeFile(fileA, 'one')
  await writeFile(fileB, 'two')
  await writeFile(fileC, 'three')
  const sizeA = (await stat(fileA)).size
  const first = await hashes.sha256(fileA, sizeA, 1)
  const second = await hashes.sha256(fileA, sizeA, 1)
  assert.equal(first, second)
  assert.equal(first, sha256Bytes(Buffer.from('one')))
  await hashes.sha256(fileA, sizeA, 2)
  const stored = JSON.parse(await readFile(join(dir, 'profile-hashes.json'), 'utf8')) as {
    files: Record<string, { mtimeMs: number }>
  }
  assert.equal(stored.files[fileA]?.mtimeMs, 2)
  await hashes.sha256(fileB, 1, 3)
  await hashes.sha256(fileC, 1, 4)
  const trimmed = JSON.parse(await readFile(join(dir, 'profile-hashes.json'), 'utf8')) as {
    files: Record<string, unknown>
  }
  assert.equal(Object.keys(trimmed.files).length, 2)
  assert.equal(trimmed.files[fileA], undefined)
  ok('a file is hashed once until its size or time changes, and the cache stays bounded')

  const calls: string[] = []
  const speed = await confirmLocalSpeed(
    { phase: 'ready', port: 8080, apiKey: 'secret', adopted: false },
    async (url, init) => {
      calls.push(url)
      const headers = init.headers as Record<string, string>
      assert.equal(headers.authorization, 'Bearer secret')
      const body = JSON.parse(String(init.body)) as { max_tokens: number }
      assert.equal(body.max_tokens, 8)
      return new Response(JSON.stringify({ timings: { predicted_per_second: 34 } }), { status: 200 })
    }
  )
  assert.equal(speed, 34)
  assert.deepEqual(calls, ['http://127.0.0.1:8080/v1/chat/completions'])
  let fetched = 0
  const skipped = await confirmLocalSpeed(
    { phase: 'ready', port: 8080, apiKey: null, adopted: true },
    async () => {
      fetched++
      return new Response('{}', { status: 200 })
    }
  )
  assert.equal(skipped, null)
  assert.equal(fetched, 0)
  const failed = await confirmLocalSpeed(
    { phase: 'ready', port: 9, apiKey: null, adopted: false },
    async () => new Response('no', { status: 500 })
  )
  assert.equal(failed, null)
  ok('the check asks the running loopback server, and an adopted server is left alone')
}

console.log(`\n${n} assertions passed`)
