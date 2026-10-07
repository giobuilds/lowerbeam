import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ServerSupervisor, initialRouterModels, routerPreset } from '../../src/main/supervisor.js'
import { routerWorstCase } from '../../src/main/planner.js'
import { modelIdOf, routerIds, servedModel, servedModels } from '@shared/served.js'
import { routerLaunchSchema, serverHandoffSchema } from '@shared/schema.js'
import { DEFAULT_LAUNCH_CONFIG, type LaunchConfig, type ServerPhase, type ServerStatus } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// #105: several models behind llama-server's router, each with its own launch.
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname
const bin = (path: string, kind: 'llama-server' | 'unified' = 'llama-server') => ({
  path, kind, argvPrefix: kind === 'unified' ? ['serve'] : [], version: 'test',
  flags: ['--flash-attn', '--fit'], flashAttnStyle: kind === 'unified' ? ('value' as const) : ('bare' as const), devices: [], label: 'test', flagDocs: []
})
const model = (path: string, patch: Partial<LaunchConfig> = {}): LaunchConfig => ({ ...DEFAULT_LAUNCH_CONFIG, modelPath: path, ...patch })

console.log('names and the preset')
{
  assert.equal(modelIdOf('/m/Qwen3-Coder-30B-A3B-Q4_K_M.gguf'), 'Qwen3-Coder-30B-A3B-Q4_K_M'); ok('a model is named by its file, without .gguf')
  assert.deepEqual(routerIds(['/a/m.gguf', '/b/m.gguf', '/c/n.gguf', '/d/m.gguf']), ['m', 'm-2', 'n', 'm-3']); ok('two files with one name get distinct names')
  const launch = {
    models: [
      model('/models/chat.gguf', { autoFit: false, gpuLayers: 999, contextSize: 16384, parallel: 2, extraArgs: '--reasoning-budget 1024 --threads -1', mmprojPath: '/models/mmproj.gguf' }),
      model('/models/coder.gguf', { autoFit: false, gpuLayers: 20, contextSize: 8192, parallel: 1, cpuMoeLayers: -1, noWarmup: true, alias: 'ignored' })
    ],
    modelsMax: 1
  }
  const ini = routerPreset(launch, bin('/x', 'unified'))
  const sections = ini.split(/\n(?=\[)/)
  assert.equal(sections.length, 2); assert.ok(sections[0]!.startsWith('[chat]\n') && sections[1]!.startsWith('[coder]\n')); ok('one section per model, under the name requests use')
  const chat = sections[0]!
  for (const line of ['model = /models/chat.gguf', 'ctx-size = 16384', 'gpu-layers = 999', 'parallel = 2', 'mmproj = /models/mmproj.gguf', 'flash-attn = on', 'jinja = 1', 'slots = 1', 'props = 1', 'reasoning-budget = 1024', 'threads = -1']) {
    assert.ok(chat.split('\n').includes(line), `chat has ${line}`)
  }
  ok('each model keeps its own launch: context, layers, slots, projector, flags with values and without, a negative value')
  assert.ok(!/^(host|port|api-key|serve) /m.test(ini)); ok('without the address, the key, or the subcommand: those are the router’s')
  const coder = sections[1]!
  assert.ok(coder.includes('cpu-moe = 1') && coder.includes('no-warmup = 1') && coder.includes('ctx-size = 8192')); assert.ok(!coder.includes('alias')); ok('the second model has its own, and no alias to clash with its name')
  assert.deepEqual(initialRouterModels(launch).map((m) => [m.id, m.state, m.contextPerSlot]), [['chat', 'unloaded', null], ['coder', 'unloaded', null]]); ok('before anything loads, nothing is known about either')
  assert.throws(() => routerLaunchSchema.parse({ models: [], modelsMax: 1 })); assert.throws(() => routerLaunchSchema.parse({ models: launch.models, modelsMax: 0 })); ok('an empty router, or one that may load nothing, is refused')
  const old = serverHandoffSchema.parse({ pid: 1, port: 8080, startedAt: 1, config: launch.models[0], apiKey: null, lan: false })
  assert.equal(old.router, null); ok('a handoff from before router mode still reads, as one model')
}

console.log('\nthe model a request uses')
{
  const base = { pid: 1, port: 1, loadStage: null, startedAt: 1, error: null, exitCode: null, readyAt: 1, adopted: false, apiKey: null, lan: false }
  const single: ServerStatus = { ...base, phase: 'ready', config: model('/m/one.gguf'), contextPerSlot: 4096, supportsTools: true, modalities: { vision: true, audio: false, video: false }, router: null }
  assert.deepEqual(servedModels(single).map((m) => [m.id, m.state, m.contextPerSlot, m.supportsTools]), [['one', 'loaded', 4096, true]]); ok('one model: the launch is the model')
  assert.equal(servedModel(single, 'anything')!.id, 'one'); ok('and whatever is asked for, it is the one that answers')
  const models = [
    { id: 'a', modelPath: '/m/a.gguf', state: 'unloaded' as const, contextPerSlot: null, supportsTools: false, modalities: null },
    { id: 'b', modelPath: '/m/b.gguf', state: 'loaded' as const, contextPerSlot: 8192, supportsTools: true, modalities: null }
  ]
  const routed: ServerStatus = { ...base, phase: 'ready', config: null, contextPerSlot: null, supportsTools: false, modalities: null, router: { modelsMax: 1, models } }
  assert.equal(servedModel(routed, 'a')!.id, 'a'); ok('a router: the model asked for, loaded or not')
  assert.equal(servedModel(routed, null)!.id, 'b'); assert.equal(servedModel(routed, 'gone')!.id, 'b'); ok('nothing asked for, or a name it does not have: a loaded one')
  assert.deepEqual(servedModels({ ...routed, phase: 'stopped' }), []); ok('a stopped server serves nothing')
}

console.log('\nwhat can be resident at once')
{
  const plans = [{ id: 'small', totalMiB: 1000 }, { id: 'big', totalMiB: 6000 }, { id: 'mid', totalMiB: 3000 }]
  assert.deepEqual(routerWorstCase(plans, 1, 8000), { worstCase: ['big'], worstCaseMiB: 6000, fits: true }); ok('one at a time: the largest alone')
  assert.deepEqual(routerWorstCase(plans, 2, 8000), { worstCase: ['big', 'mid'], worstCaseMiB: 9000, fits: false }); ok('two at a time: the two largest together, each with all of its own')
  assert.equal(routerWorstCase(plans, 2, null).fits, null); ok('free memory unknown: no verdict')
}

console.log('\na router launched, its models loaded on demand')
{
  const handoff = `${tmpdir()}/router-handoff-${process.pid}.json`
  await rm(handoff, { force: true })
  const sup = new ServerSupervisor(bin(`${FIXTURES}fake-router.mjs`), handoff)
  const launch = { models: [model('/m/chat.gguf', { autoFit: false, contextSize: 8192, parallel: 2 }), model('/m/coder.gguf', { autoFit: false, contextSize: 16384, parallel: 1 }), model('/m/notools.gguf')], modelsMax: 1 }
  const waitPhase = (phase: ServerPhase) => new Promise<void>((resolve, reject) => {
    if (sup.status.phase === phase) return resolve()
    const t = setTimeout(() => reject(new Error(`stuck in ${sup.status.phase}`)), 10_000)
    sup.on('status', (s) => { if (s.phase === phase) { clearTimeout(t); resolve() } })
  })
  await sup.startRouter(launch, { port: null, apiKey: 'k1', lan: false })
  await waitPhase('ready')
  assert.equal(sup.status.config, null); assert.deepEqual(sup.status.router!.models.map((m) => m.state), ['unloaded', 'unloaded', 'unloaded']); ok('ready with nothing loaded: the router is up, its models are not')
  const preset = await (await fetch(`http://127.0.0.1:${sup.status.port}/preset`, { headers: { authorization: 'Bearer k1' } })).text()
  assert.ok(preset.includes('[coder]') && preset.includes('model = /m/coder.gguf')); ok('the router was given the preset')
  const log = sup.logs.since(0).map((l) => l.text).join('\n')
  assert.ok(log.includes('--models-max 1') && log.includes('--api-key ••••') && !log.includes('k1')); ok('launched with the limit and the key, the key not shown')

  const chat = await sup.ensureLoaded('chat')
  assert.equal(chat.state, 'loaded'); assert.equal(chat.contextPerSlot, 4096); assert.equal(chat.supportsTools, true); ok('asked for a model: loaded first, and its own window and tools read')
  const coder = await sup.ensureLoaded('coder')
  assert.equal(coder.contextPerSlot, 16384)
  await new Promise((r) => setTimeout(r, 1200))
  assert.deepEqual(sup.status.router!.models.map((m) => [m.id, m.state]), [['chat', 'unloaded'], ['coder', 'loaded'], ['notools', 'unloaded']]); ok('another one past the limit: the first is unloaded, and the status says so')
  assert.equal((await sup.ensureLoaded('notools')).supportsTools, false); ok('each model’s template is its own: one without tools says so')
  await assert.rejects(sup.ensureLoaded('nope'), /no model named nope/); ok('a name the router does not have is refused')
  assert.equal(sup.launchFor('/m/coder.gguf')!.contextSize, 16384); assert.equal(sup.launchFor('/m/other.gguf'), null); ok('each model’s launch is known, for the record')

  const handed = JSON.parse(await readFile(handoff, 'utf8'))
  assert.equal(handed.config, null); assert.equal(handed.router.models.length, 3)
  const again = new ServerSupervisor(bin(`${FIXTURES}fake-router.mjs`), handoff)
  await again.adoptOrReap()
  assert.equal(again.status.phase, 'ready'); assert.deepEqual(again.status.router!.models.map((m) => m.id), ['chat', 'coder', 'notools']); ok('a restart adopts the router as a router')
  await again.ensureLoaded('chat')
  assert.equal(servedModel(again.status, 'chat')!.contextPerSlot, 4096); ok('and reads its models again')
  await again.stop()
  assert.equal(again.status.phase, 'stopped'); assert.deepEqual(again.status.router!.models.map((m) => m.state), ['unloaded', 'unloaded', 'unloaded']); ok('stopped, nothing is loaded')
  await rm(handoff, { force: true })
}

console.log(`\n${n} assertions passed`)
