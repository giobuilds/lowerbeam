import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, WriteQueue } from '../../src/main/atomicWrite.js'
import { SettingsStore } from '../../src/main/settings.js'

let n = 0
const ok = (m: string): void => { n++; console.log('  ok', m) }
const root = await mkdtemp(join(tmpdir(), 'atomic-'))

console.log('a shorter write must not leave the tail of a longer one')
const path = join(root, 'file.json')
await writeFileAtomic(path, JSON.stringify({ a: 'x'.repeat(500) }))
await writeFileAtomic(path, JSON.stringify({ b: 1 }))
const after = await readFile(path, 'utf8')
assert.deepEqual(JSON.parse(after), { b: 1 })
ok('the file is exactly the newer content, with nothing trailing')
assert.equal(after.length, JSON.stringify({ b: 1 }).length)
ok('and no bytes of the previous version survive')

console.log('no temporary files are left behind')
assert.deepEqual(await readdir(root), ['file.json'])
ok('the directory holds only the file itself')

console.log('the queue runs tasks strictly in order')
const queue = new WriteQueue()
const order: number[] = []
await Promise.all(
  [50, 30, 10, 0].map((delay, i) =>
    queue.run(async () => {
      await new Promise((r) => setTimeout(r, delay))
      order.push(i)
    })
  )
)
assert.deepEqual(order, [0, 1, 2, 3])
ok('later tasks wait even when they would finish sooner')

console.log('a failing task does not poison the queue')
await queue.run(async () => { throw new Error('boom') }).catch(() => undefined)
assert.equal(await queue.run(async () => 'still working'), 'still working')
ok('the next write still runs after one throws')

/**
 * The corruption this replaces: clearing several download entries fired one
 * un-awaited write each, and a shorter one landing on a longer file left the
 * old tail behind, after which the settings no longer parsed and the
 * application silently fell back to defaults.
 */
console.log('many concurrent patches leave valid settings')
const store = new SettingsStore(join(root, 'settings.json'))
await store.load()
await Promise.all(
  Array.from({ length: 25 }, (_, i) =>
    store.patch({ modelDirs: Array.from({ length: 25 - i }, (_, k) => `/models/${k}`) })
  )
)
const raw = await readFile(join(root, 'settings.json'), 'utf8')
assert.doesNotThrow(() => JSON.parse(raw))
ok('the file still parses after 25 overlapping writes')
assert.equal(raw.trimEnd().endsWith('}'), true)
ok('and ends where it should, with no trailing remains')

const reopened = new SettingsStore(join(root, 'settings.json'))
await reopened.load()
assert.ok(Array.isArray(reopened.current.modelDirs))
ok('a fresh store reads it back without falling to defaults')
assert.equal(reopened.current.theme, 'system')
ok('a settings file from before the theme choice follows the system')
await reopened.patch({ theme: 'light' })
const themed = new SettingsStore(join(root, 'settings.json'))
await themed.load()
assert.equal(themed.current.theme, 'light')
ok('the theme choice is saved')

await rm(root, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
