import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITY_RECORD, capabilityFor, verdictFor } from '@shared/capability.js'
import { ModelIdentifier, sha256Of } from '../../src/main/coding/capability.js'
import { CodingSupervisor } from '../../src/main/coding/supervisor.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('the record is well formed')
{
  const hashes = new Set<string>()
  for (const m of CAPABILITY_RECORD) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/)
    assert.ok(!hashes.has(m.sha256)); hashes.add(m.sha256)
    assert.ok(m.bytes > 0 && m.name.endsWith('.gguf') && m.measured.on && m.measured.build && m.measured.results)
    for (const mode of ['inspect', 'edit', 'run'] as const) assert.ok(m.modes[mode].evidence.length > 20, `${m.key} ${mode} cites its measurement`)
    for (const f of m.families) assert.ok(f.passed <= f.of && f.of > 0, `${m.key} ${f.family}`)
  }
  ok(`${CAPABILITY_RECORD.length} models, each keyed by a distinct file hash, every mode with its evidence`)
  const nine = capabilityFor('70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6')!
  assert.equal(nine.key, 'ornith-9b'); assert.equal(nine.modes.run.verdict, 'cleared'); ok('the 9B is cleared for every mode')
  const floor = capabilityFor('f28b0ae262158af10d847c3f01bfdb943161dd31320f3aed20775ee2ad6c67a6')!
  assert.equal(floor.modes.inspect.verdict, 'cleared'); assert.equal(floor.modes.edit.verdict, 'refused'); ok('the floor may inspect and not edit, per model and not per size')
  assert.equal(capabilityFor('0'.repeat(64)), null); ok('an unknown hash has no record')
}

console.log('\nverdicts from what is known about the loaded model')
{
  assert.equal(verdictFor(null, 'edit').verdict, 'unmeasured'); assert.equal(verdictFor({ state: 'none' }, 'edit').verdict, 'unmeasured'); ok('no model: nothing is refused, nothing is cleared')
  const un = verdictFor({ state: 'unmeasured', path: '/m.gguf', bytes: 1, sha256: '0'.repeat(64) }, 'run')
  assert.equal(un.verdict, 'unmeasured'); assert.ok(un.evidence.includes('No record for this file')); ok('an unmeasured file is offered every mode and says so')
  const record = capabilityFor('3895b6eaa91e705c06ad1938d16c22e86f073c6a67df86260a1da79be3d1f887')!
  const m = verdictFor({ state: 'measured', path: '/m.gguf', bytes: 1, sha256: record.sha256, record }, 'edit')
  assert.equal(m.verdict, 'refused'); assert.ok(m.evidence.includes('one bit')); ok('a measured file gets the record’s verdict with its evidence')
}

const base = await mkdtemp(join(tmpdir(), 'capability-'))
const model = join(base, 'model.gguf')
await writeFile(model, 'GGUF not really, but enough bytes to hash\n'.repeat(1000))
const cacheFile = join(base, 'hashes.json')

console.log('\na model is identified by its file hash, once')
{
  const id = new ModelIdentifier(cacheFile)
  assert.deepEqual(await id.status(null), { state: 'none' }); ok('no path, no model')
  const [a, b] = await Promise.all([id.status(model), id.status(model)])
  assert.equal(a.state, 'unmeasured'); assert.ok(a.state === 'unmeasured' && a.sha256 === (await sha256Of(model))); ok('the file is hashed and not in the record')
  assert.equal(a, b); ok('two concurrent asks share one hashing')
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
  const info = await stat(model)
  assert.equal(cache[model].sha256, a.state === 'unmeasured' ? a.sha256 : ''); assert.equal(cache[model].bytes, info.size); assert.equal(cache[model].mtimeMs, info.mtimeMs)
  ok('the hash is remembered against the file’s size and modification time')

  // Plant the 9B's hash for this file: a cache hit is trusted, so the record answers.
  cache[model].sha256 = '70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6'
  await writeFile(cacheFile, JSON.stringify(cache))
  const again = await new ModelIdentifier(cacheFile).status(model)
  assert.equal(again.state, 'measured'); assert.ok(again.state === 'measured' && again.record.key === 'ornith-9b'); ok('an unchanged file is not hashed again, and the record is found by hash')

  await writeFile(model, 'a different file now\n')
  const changed = await new ModelIdentifier(cacheFile).status(model)
  assert.equal(changed.state, 'unmeasured'); assert.ok(changed.state === 'unmeasured' && changed.sha256 === (await sha256Of(model))); ok('a file that changed is hashed afresh')
}

console.log('\nthe main process refuses a mode the record refuses')
{
  const dir = join(base, 'coding')
  const info = await stat(model)
  // The floor's hash for this file: cleared to inspect, refused edits.
  await writeFile(join(base, 'model-hashes.json'), '{}')
  const supervisor = new CodingSupervisor(dir, () => ({ status: { phase: 'ready', port: 1, config: { modelPath: model }, contextPerSlot: 4096 } }) as never)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model-hashes.json'), JSON.stringify({ [model]: { bytes: info.size, mtimeMs: info.mtimeMs, sha256: 'f28b0ae262158af10d847c3f01bfdb943161dd31320f3aed20775ee2ad6c67a6' } }))
  await assert.rejects(supervisor.start({ projectRoot: base, task: 'fix it', mode: 'edit' }), /not cleared to edit: It cannot locate code, 2 of 18/)
  ok('an edit run on the floor is refused with the measurement, whatever the interface offered')
  await assert.rejects(supervisor.start({ projectRoot: base, task: 'fix it', mode: 'run' }), /not cleared to edit and run commands/)
  ok('and so is a run')
  const status = await supervisor.capability()
  assert.equal(status.state, 'measured'); assert.ok(status.state === 'measured' && status.record.key === 'gemma4-e4b'); ok('and the tab is told which record answered')
  assert.ok(status.state === 'measured' && status.contextPerSlot === 4096); ok('and what context the running server gives a slot, so a launch the record never measured can be named')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
