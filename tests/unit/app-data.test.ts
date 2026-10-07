import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataUsage, deleteOwnData, sizeOf } from '../../src/main/appData.js'
import { CodingSupervisor } from '../../src/main/coding/supervisor.js'
import { ConversationStore } from '../../src/main/conversations.js'
import { migrateLegacyUserData } from '../../src/main/migrate.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const exists = (p: string) => stat(p).then(() => true, () => false)

// #133: what the app keeps, how much, and deleting it.
const base = await mkdtemp(join(tmpdir(), 'app-data-'))
const userData = join(base, 'Lowerbeam')
const coding = join(userData, 'coding')
const conversationsDir = join(userData, 'conversations')
await mkdir(join(coding, 'workspaces'), { recursive: true })

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const run = async (id: string, finishedAt: number) => {
  const ev = (seq: number, e: Record<string, unknown>) => ({ v: 1, run: id, seq, ts: finishedAt - 1000 + seq, ...e }) as JournalEvent
  const events = [
    ev(0, { type: 'run.started', task: 't', model: 'm', grantRoot: '/p', mode: 'run' }),
    ev(1, { type: 'run.finished', outcome: 'answered', answer: 'a', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 } })
  ]
  await writeFile(join(coding, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await writeFile(join(coding, `${id}.words.jsonl`), '{}\n')
  await writeFile(join(coding, `${id}.cmd-1.txt`), '$ ls\nsecret source\n')
  await mkdir(join(coding, 'workspaces', id, 'src'), { recursive: true })
  await writeFile(join(coding, 'workspaces', id, 'src', 'a.js'), 'x'.repeat(5000))
}
const OLD = '11111111-2222-4333-8444-000000000001'
const NEW = '11111111-2222-4333-8444-000000000002'
await run(OLD, now - 40 * DAY)
await run(NEW, now - 1 * DAY)
await writeFile(join(coding, `${OLD}.baseline.json`), '{}')
await mkdir(join(coding, 'measure', 'abc'), { recursive: true }); await writeFile(join(coding, 'measure', 'abc', 'x.jsonl'), '{}\n')
await writeFile(join(coding, 'model-hashes.json'), '{}')
await writeFile(join(coding, 'local-capability.json'), '{}')
const store = new ConversationStore(conversationsDir)
await store.init()
await store.create(); await store.create()
await writeFile(join(userData, 'settings.json'), '{}'); await writeFile(join(userData, 'settings.json.corrupt.bak'), '{')
await writeFile(join(userData, 'profiles.json'), '{}'); await writeFile(join(userData, 'Local State'), 'electron')

console.log('what is kept, and how much')
{
  assert.equal(await sizeOf(join(coding, 'workspaces', OLD, 'src', 'a.js')), 5000); ok('a file’s size')
  const u = await dataUsage({ userData, conversations: conversationsDir, coding }, null)
  assert.equal(u.conversations.count, 2); assert.equal(u.runs.count, 2); assert.equal(u.workspaces.count, 2); ok('two conversations, two runs, two workspace copies')
  assert.ok(u.workspaces.bytes >= 10_000); assert.ok(u.runs.bytes > 0 && u.conversations.bytes > 0); assert.ok(u.total >= u.workspaces.bytes + u.runs.bytes + u.conversations.bytes); ok('each with its size, and the folder’s total covers them')
  assert.equal(u.retentionDays, null); assert.equal(u.path, userData); ok('with the setting and where it lives')
}

console.log('\nretention')
{
  const supervisor = new CodingSupervisor(coding, () => null)
  await supervisor.load()
  assert.equal(await supervisor.pruneOlderThan(30, now), 1); ok('one run finished more than 30 days ago')
  assert.ok(!(await exists(join(coding, 'workspaces', OLD))) && !(await exists(join(coding, `${OLD}.cmd-1.txt`)))); ok('its workspace copy and command output are gone')
  assert.ok(await exists(join(coding, `${OLD}.jsonl`))); assert.equal(supervisor.list().length, 2); ok('its journal stays, and the run is still listed')
  assert.ok(await exists(join(coding, 'workspaces', NEW)) && (await exists(join(coding, `${NEW}.cmd-1.txt`)))); ok('the recent run is untouched')
  assert.equal(await supervisor.pruneOlderThan(30, now), 0); ok('a second pass finds nothing')
}

console.log('\ndelete all coding runs')
{
  const supervisor = new CodingSupervisor(coding, () => null)
  await supervisor.load()
  const seen: number[] = []
  supervisor.on('runs', (r) => seen.push(r.length))
  assert.equal(await supervisor.deleteAllRuns(), 2)
  assert.deepEqual((await readdir(coding)).sort(), ['local-capability.json', 'model-hashes.json']); ok('every run file, workspace and measurement gone; the capability record and hash cache stay')
  assert.deepEqual(supervisor.list(), []); assert.equal(seen.at(-1), 0); ok('and the interface is told there are none')
}

console.log('\ndelete all conversations')
{
  assert.equal(await store.removeAll(), 2); assert.deepEqual(await store.list(), []); ok('both gone')
  assert.equal(await store.removeAll(), 0); ok('and again, nothing to remove')
}

console.log('\ndelete all app data')
{
  const legacy = join(base, 'llama-gui')
  await mkdir(legacy); await writeFile(join(legacy, 'settings.json'), '{"old":true}')
  await deleteOwnData(userData)
  const left = (await readdir(userData)).sort()
  assert.deepEqual(left, ['.migrated-from', 'Local State']); ok('the app’s files are gone, the backup of a bad settings file too; Electron’s are left for its session to clear')
  assert.equal(await migrateLegacyUserData(userData), null); assert.ok(!(await exists(join(userData, 'settings.json')))); ok('and an older version’s folder is not copied back in on the next start')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
