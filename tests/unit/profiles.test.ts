import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rename, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore, modelKey } from '../../src/main/profiles.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const dir = await mkdtemp(join(tmpdir(),'profiles-'))
const store = new ProfileStore(join(dir,'profiles.json'))
await store.load()

// A fake GGUF: identity is name+size, so contents do not matter here.
const modelsA = join(dir,'a'); const modelsB = join(dir,'b')
await mkdir(modelsA); await mkdir(modelsB)
const pathA = join(modelsA,'my-model.gguf')
await writeFile(pathA, Buffer.alloc(4096))

const cfg = { ...DEFAULT_LAUNCH_CONFIG, contextSize: 8192, gpuLayers: 17, autoFit: false }
const { modelPath: _drop, ...configOnly } = { modelPath: pathA, ...cfg }

console.log('identity')
const k1 = await modelKey(pathA)
assert.ok(k1.includes('my-model.gguf') && k1.includes('4096'))
ok(`key is name+size (${k1})`)
const missing = await modelKey('/nope/absent.gguf')
assert.equal(missing, '/nope/absent.gguf'); ok('falls back to the path when the file is unreadable')

console.log('round trip')
assert.equal(await store.get(pathA), null); ok('unknown model has no profile')
await store.put({ key:k1, modelPath:pathA, modelName:'my-model.gguf', config:configOnly,
  lastUsedAt: Date.now(), loadMs: 1234, actualContext: 8192 })
const got = await store.get(pathA)
assert.equal(got!.config.contextSize, 8192)
assert.equal(got!.config.gpuLayers, 17)
assert.equal(got!.actualContext, 8192)
ok('stores and returns the launch settings')

console.log('survives the file moving directories')
const pathB = join(modelsB,'my-model.gguf')
await rename(pathA, pathB)
const moved = await store.get(pathB)
assert.ok(moved, 'profile not found after move')
assert.equal(moved!.config.gpuLayers, 17)
ok('same model in a different folder keeps its settings')

console.log('different models do not collide')
const other = join(modelsB,'other-model.gguf')
await writeFile(other, Buffer.alloc(4096)) // same size, different name
assert.equal(await store.get(other), null)
ok('same size but different name is a different model')
const sameName = join(modelsA,'my-model.gguf')
await writeFile(sameName, Buffer.alloc(8192)) // same name, different size
assert.equal(await store.get(sameName), null)
ok('same name but different size is a different model')

console.log('persistence across restarts')
const reopened = new ProfileStore(join(dir,'profiles.json'))
await reopened.load()
assert.equal((await reopened.get(pathB))!.config.contextSize, 8192)
ok('survives a store restart')
assert.equal(reopened.list().length, 1); ok('lists what it holds')

console.log('forget')
await reopened.forget(pathB)
assert.equal(await reopened.get(pathB), null); ok('forget removes it')
const again = new ProfileStore(join(dir,'profiles.json'))
await again.load()
assert.equal(await again.get(pathB), null); ok('forget is persisted, not just in memory')

console.log('forget after the file is gone')
{
  await writeFile(pathB, Buffer.alloc(4096))
  const key = await modelKey(pathB)
  await again.put({ key, modelPath: pathB, modelName: 'my-model.gguf', config: configOnly,
    lastUsedAt: Date.now(), loadMs: null, actualContext: null })
  await unlink(pathB)
  await again.forget(pathB)
  await writeFile(pathB, Buffer.alloc(4096))
  assert.equal((await again.get(pathB))!.key, key)
  ok('forgetting by path after the file is gone does not drop the saved settings')
  await unlink(pathB)
  await again.forgetKey(key)
  await writeFile(pathB, Buffer.alloc(4096))
  assert.equal(await again.get(pathB), null)
  ok('forgetting the key taken beforehand drops the settings once the file is gone')
}

console.log('corrupt file does not take the app down')
await writeFile(join(dir,'profiles.json'), '{ this is not json')
const broken = new ProfileStore(join(dir,'profiles.json'))
await broken.load()
assert.deepEqual(broken.list(), []); ok('falls back to empty on a corrupt file')

await rm(dir, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
