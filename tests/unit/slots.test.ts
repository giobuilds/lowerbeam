import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SlotCache, SAVE_FROM_TOKENS } from '../../src/main/slots.js'
import { buildArgs } from '../../src/main/supervisor.js'
import { DEFAULT_LAUNCH_CONFIG, type ServerStatus } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// #110: a long chat's server slot, saved when it is left and restored on return.
const base = await mkdtemp(join(tmpdir(), 'slots-'))
const dir = join(base, 'slots')
await mkdir(dir)

// A llama-server's slot API, as far as this needs: two slots, each holding a
// token count; save writes a file of that many bytes, restore reads it back.
const slots = [{ id: 0, is_processing: false, tokens: 0 }, { id: 1, is_processing: false, tokens: 0 }]
const calls: string[] = []
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    if (url.pathname === '/slots' && req.method === 'GET') {
      res.end(JSON.stringify(slots.map(({ id, is_processing }) => ({ id, is_processing }))))
      return
    }
    const m = url.pathname.match(/^\/slots\/(\d+)$/)
    const slot = m ? slots[Number(m[1])] : undefined
    const action = url.searchParams.get('action')
    calls.push(`${action} ${m?.[1]}`)
    if (!slot) return res.writeHead(404).end('{}')
    const { filename } = raw ? (JSON.parse(raw) as { filename?: string }) : {}
    if (action === 'save') {
      await writeFile(join(dir, filename!), Buffer.alloc(slot.tokens * 10))
      return res.end(JSON.stringify({ id_slot: slot.id, n_saved: slot.tokens }))
    }
    if (action === 'restore') {
      const bytes = (await readFile(join(dir, filename!))).length
      slot.tokens = bytes / 10
      return res.end(JSON.stringify({ id_slot: slot.id, n_restored: slot.tokens }))
    }
    res.writeHead(400).end('{}')
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as AddressInfo).port

let status: ServerStatus = {
  phase: 'ready', pid: 1, port, config: { ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m/model.gguf' }, loadStage: null, startedAt: 1, error: null, exitCode: null,
  readyAt: 1, adopted: false, modalities: null, supportsTools: true, contextPerSlot: 16384, apiKey: null, lan: false, router: null
}
const cache = (budget?: number) => new SlotCache(dir, () => ({ status, build: 'b1' }), budget)
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'

console.log('a chat goes back to its slot')
const slotsCache = cache()
{
  const a = await slotsCache.prepare(A)
  assert.deepEqual(a, { slot: 0, restored: null }); ok('a new chat gets a slot nobody has used')
  slots[0]!.tokens = 9000
  const b = await slotsCache.prepare(B)
  assert.deepEqual(b, { slot: 1, restored: null }); ok('a second chat gets the other one')
  slots[1]!.tokens = 500
  assert.deepEqual(await slotsCache.prepare(A), { slot: 0, restored: null }); ok('back to the first: its slot still holds it, so nothing is restored')
}

console.log('\nleaving a long chat saves its slot')
{
  assert.equal(await slotsCache.leave(B, 500), false); ok(`a short chat is not saved: under ${SAVE_FROM_TOKENS} tokens, re-reading is quick`)
  assert.equal(await slotsCache.leave(A, 9000), true)
  assert.deepEqual(await readdir(dir).then((f) => f.filter((x) => x.endsWith('.bin'))), [`${A}.bin`]); ok('a long one is, named by its conversation')
  assert.deepEqual(await slotsCache.usage(), { count: 1, bytes: 90000 }); ok('and counted for the Data row')
  slots[0]!.is_processing = true
  assert.equal(await slotsCache.leave(A, 9000), false); ok('a slot that is busy is not saved mid-reply')
  slots[0]!.is_processing = false
}

console.log('\ncoming back after its slot went to another chat')
{
  // C takes slot 0, A's slot; then A comes back.
  slots[1]!.is_processing = true
  assert.deepEqual(await slotsCache.prepare(C), { slot: 0, restored: null })
  slots[0]!.tokens = 300
  slots[1]!.is_processing = false
  calls.length = 0
  const back = await slotsCache.prepare(A)
  assert.ok(back && back.restored === 9000 && calls.includes(`restore ${back.slot}`)); ok('its saved state is restored into a free slot first')
  await slotsCache.report(A, 8990)
  assert.equal((await slotsCache.usage()).count, 1); ok('a reply that reused it all: the saved slot stays')
}

console.log('\na restore that did not help stops saving for that model')
{
  slots[0]!.is_processing = true
  // B is now away from its slot: put another chat there, then bring A back again.
  await slotsCache.leave(A, 9000)
  slots[0]!.is_processing = false
  await slotsCache.prepare(B)
  await slotsCache.prepare(C)
  const again = await slotsCache.prepare(A)
  assert.equal(again?.restored, 9000)
  await slotsCache.report(A, 4)
  assert.deepEqual(await slotsCache.usage(), { count: 0, bytes: 0 }); assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.bin'))); ok('reused almost nothing, as a hybrid model does: its files are deleted')
  assert.equal(await slotsCache.leave(A, 9000), false); ok('and nothing more is saved for that model under that build')
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  assert.equal(index.ineffective.length, 1); ok('which is remembered')
}

console.log('\nanother model, a router, bounds and sweeping')
{
  const other = cache()
  status = { ...status, config: { ...status.config!, modelPath: '/m/other.gguf' }, pid: 2 }
  slots[0]!.tokens = 5000
  await other.prepare(A)
  assert.equal(await other.leave(A, 5000), true); ok('a model without that verdict saves as before')
  status = { ...status, contextPerSlot: 8192, pid: 3 }
  calls.length = 0
  const mismatched = await other.prepare(A)
  assert.equal(mismatched?.restored, null); assert.ok(!calls.some((c) => c.startsWith('restore'))); assert.equal((await other.usage()).count, 0); ok('a saved slot for another window is not restored, and goes')
  status = { ...status, router: { modelsMax: 1, models: [] }, config: null }
  assert.equal(await other.prepare(A), null); ok('a router: no slots handled here')
  status = { ...status, router: null, config: { ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m/third.gguf' }, contextPerSlot: 16384, pid: 4 }

  const small = cache(150_000)
  for (const id of [A, B, C]) {
    slots[0]!.tokens = 6000
    slots[1]!.is_processing = true
    await small.prepare(id)
    slots[1]!.is_processing = false
    await small.leave(id, 6000)
    await new Promise((r) => setTimeout(r, 5))
  }
  const kept = await small.usage()
  assert.ok(kept.bytes <= 150_000 && kept.count === 2); ok('over the size budget, the least recently used is dropped')

  await writeFile(join(dir, 'stray.bin'), 'x')
  await small.sweep(async (id) => id !== C)
  const left = (await readdir(dir)).filter((f) => f.endsWith('.bin'))
  assert.ok(!left.includes('stray.bin') && !left.includes(`${C}.bin`)); ok('on start, a file no entry names and one for a deleted chat are swept')
  await small.drop(B)
  assert.ok(!(await readdir(dir)).includes(`${B}.bin`)); ok('deleting a chat deletes its saved slot')
  await small.clear()
  assert.deepEqual(await small.usage(), { count: 0, bytes: 0 }); ok('and clearing removes them all')
}

console.log('\nthe launch')
{
  const bin = { path: '/x', kind: 'unified' as const, argvPrefix: ['serve'], version: 't', flags: ['--slot-save-path'], flashAttnStyle: 'value' as const, devices: [], label: 't', flagDocs: [] }
  const args = buildArgs({ ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m.gguf' }, 1, bin, { slotDir: '/data/slots' })
  assert.equal(args[args.indexOf('--slot-save-path') + 1], '/data/slots'); ok('a server is launched with the app’s slot folder')
  assert.ok(!buildArgs({ ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m.gguf' }, 1, { ...bin, flags: [] }, { slotDir: '/data/slots' }).includes('--slot-save-path')); ok('unless the binary does not know the flag')
}

server.close()
await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
