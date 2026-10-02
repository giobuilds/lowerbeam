import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ServerSupervisor, buildArgs, isAlive, pickFreePort, portFree, redactKey } from '../../src/main/supervisor.js'
import { DEFAULT_LAUNCH_CONFIG, type ServerPhase } from '@shared/types.js'
import { authHeaders } from '@shared/chatClient.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// #104: a fixed port, a key, and the local network only with the key.
const SHIM = new URL('../fixtures/fake-llama.mjs', import.meta.url).pathname
const HANDOFF = `${tmpdir()}/local-api-handoff.json`
const bin = { path: SHIM, kind: 'llama-server' as const, argvPrefix: [], version: 'test', flags: ['--flash-attn'], flashAttnStyle: 'bare' as const, devices: [], label: 'test' }
const cfg = { modelPath: '/fake/model.gguf', ...DEFAULT_LAUNCH_CONFIG, autoFit: false }
const waitFor = (sup: ServerSupervisor, want: ServerPhase[]): Promise<ServerPhase> =>
  new Promise((resolve, reject) => {
    if (want.includes(sup.status.phase)) return resolve(sup.status.phase)
    const to = setTimeout(() => reject(new Error(`stuck in ${sup.status.phase}`)), 20000)
    const on = (s: { phase: ServerPhase }) => { if (want.includes(s.phase)) { clearTimeout(to); sup.off('status', on); resolve(s.phase) } }
    sup.on('status', on)
  })
await rm(HANDOFF, { force: true })

console.log('the launch carries the binding and the key')
{
  const plain = buildArgs(cfg, 1234, bin)
  assert.equal(plain[plain.indexOf('--host') + 1], '127.0.0.1'); assert.ok(!plain.includes('--api-key')); ok('by default: loopback, no key')
  const lan = buildArgs(cfg, 1234, bin, { host: '0.0.0.0', apiKey: 'secret' })
  assert.equal(lan[lan.indexOf('--host') + 1], '0.0.0.0'); assert.equal(lan[lan.indexOf('--api-key') + 1], 'secret'); ok('with the network and a key: every interface, and the key')
  assert.deepEqual(authHeaders('k'), { authorization: 'Bearer k' }); assert.deepEqual(authHeaders(null), {}); ok('clients send it as a Bearer token, or nothing')
  assert.ok(!redactKey(lan).includes('secret') && redactKey(lan).includes('--api-key')); ok('the logged command line masks the key')
}

console.log('\na fixed port, checked before spawning')
{
  const port = await pickFreePort()
  assert.equal(await portFree(port), true); ok('a free port is free')
  const holder: Server = await new Promise((r) => { const s = createServer(); s.listen(port, '127.0.0.1', () => r(s)) })
  assert.equal(await portFree(port), false); ok('a held port is not')
  const sup = new ServerSupervisor(bin, HANDOFF)
  await assert.rejects(() => sup.start(cfg, { port, apiKey: '', lan: false }), new RegExp(`Port ${port} is in use by another program`)); ok('and launching on it says so, without spawning')
  assert.equal(sup.status.phase, 'stopped'); ok('nothing was started')
  await new Promise((r) => holder.close(r))
  await assert.rejects(() => sup.start(cfg, { port: null, apiKey: '', lan: true }), /needs an API key/); ok('the local network without a key is refused')
}

console.log('\na server launched with a fixed port and a key')
{
  const port = await pickFreePort()
  const sup = new ServerSupervisor(bin, HANDOFF)
  await sup.start(cfg, { port, apiKey: 'test-key-123', lan: false })
  assert.equal(await waitFor(sup, ['ready', 'crashed']), 'ready'); ok('starts')
  assert.equal(sup.status.port, port); assert.equal(sup.status.apiKey, 'test-key-123'); assert.equal(sup.status.lan, false); ok('on the port asked for, and the status carries the key for the app’s own clients')
  assert.ok(sup.logs.since(0).every((l) => !l.text.includes('test-key-123'))); ok('and the server log never shows it')
  const without = await fetch(`http://127.0.0.1:${port}/props`)
  assert.equal(without.status, 401); ok('the server refuses a request without the key')
  const withKey = await fetch(`http://127.0.0.1:${port}/props`, { headers: authHeaders('test-key-123') })
  assert.equal(withKey.status, 200); ok('and answers one with it')
  for (let i = 0; i < 40 && sup.status.contextPerSlot === null; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(sup.status.contextPerSlot, 4096); ok('the supervisor’s own /props read sends the key')

  const next = new ServerSupervisor(bin, HANDOFF)
  await next.adoptOrReap()
  assert.equal(next.status.phase, 'ready'); assert.equal(next.status.apiKey, 'test-key-123'); assert.equal(next.status.port, port); ok('a later session adopts it with its key and port')
  const pid = sup.status.pid!
  await sup.stop()
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(isAlive(pid), false); ok('and it stops')
}

await rm(HANDOFF, { force: true })
console.log(`\n${n} assertions passed`)
