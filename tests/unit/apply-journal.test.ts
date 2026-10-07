import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JournalEvent } from '@shared/coding.js'
import { CodingSupervisor, appliedFrom } from '../../src/main/coding/supervisor.js'
import { Workspace, hashFile } from '../../src/main/coding/workspace.js'
import { Journal } from '../../src/main/coding/journal.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// #134: applying a run's changes, and undoing them, are recorded in its journal.
const base = await mkdtemp(join(tmpdir(), 'apply-journal-'))
const dir = join(base, 'coding')
const project = join(base, 'project')
await mkdir(project, { recursive: true })
await writeFile(join(project, 'a.txt'), 'old a\n')
await writeFile(join(project, 'b.txt'), 'old b\n')
const id = '11111111-2222-4333-8444-555555555555'
await mkdir(join(dir, 'workspaces'), { recursive: true })
const ws = await Workspace.create(project, join(dir, 'workspaces', id))
await writeFile(join(ws.root, 'a.txt'), 'new a\n')
await writeFile(join(ws.root, 'b.txt'), 'new b\n')
let seq = 0
const ev = (e: Record<string, unknown>) => ({ v: 1, run: id, seq: seq++, ts: 1000 + seq, ...e }) as JournalEvent
const started = [
  ev({ type: 'run.started', task: 'change them', model: 'm', grantRoot: ws.root, mode: 'edit' }),
  ev({ type: 'run.finished', outcome: 'answered', answer: 'done', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 } })
]
await writeFile(join(dir, `${id}.jsonl`), started.map((e) => JSON.stringify(e)).join('\n') + '\n')
const journal = (): Promise<JournalEvent[]> => Journal.read(join(dir, `${id}.jsonl`))
const restart = async (): Promise<CodingSupervisor> => {
  const s = new CodingSupervisor(dir, () => null)
  await s.load()
  return s
}

console.log('apply is recorded')
{
  const supervisor = await restart()
  const seen: JournalEvent[] = []
  supervisor.on('event', (e) => seen.push(e))
  const result = await supervisor.apply(id)
  assert.deepEqual(result.applied.sort(), ['a.txt', 'b.txt'])
  const events = await journal()
  const applied = events.at(-1)!
  assert.equal(events.length, 3); assert.equal(applied.type, 'applied'); assert.equal(applied.seq, 2); assert.equal(applied.run, id); ok('one event, after the last, in sequence')
  assert.ok(applied.type === 'applied')
  assert.deepEqual(applied.files.map((f) => f.path).sort(), ['a.txt', 'b.txt'])
  assert.equal(applied.files.find((f) => f.path === 'a.txt')!.sha256, await hashFile(join(project, 'a.txt'))); ok('naming each file with the hash of what was written')
  assert.deepEqual(applied.conflicts, []); ok('and nothing left alone')
  assert.equal(seen.at(-1)?.type, 'applied'); ok('passed on to the interface like any event')
  assert.equal(supervisor.list()[0]!.appliedAt, applied.ts); ok('the run shows as applied, at the recorded time')
}

console.log('\na restart still knows')
{
  const supervisor = await restart()
  assert.ok(supervisor.list()[0]!.appliedAt !== null); ok('after a restart, the run is still applied')

  // Someone edits a.txt in the project; undo leaves it and restores b.txt.
  await writeFile(join(project, 'a.txt'), 'edited by hand\n')
  const partial = await supervisor.undo(id)
  assert.deepEqual(partial.applied, ['b.txt']); assert.equal(partial.conflicts.length, 1)
  const undone = (await journal()).at(-1)!
  assert.equal(undone.type, 'undone'); assert.ok(undone.type === 'undone' && undone.files[0] === 'b.txt' && undone.conflicts[0]!.path === 'a.txt'); ok('a partial undo is recorded with what could not be restored')
  assert.ok((await restart()).list()[0]!.appliedAt !== null); ok('and the run is still applied: a.txt is still the run’s change')

  await writeFile(join(project, 'a.txt'), 'new a\n')
  const rest = await supervisor.undo(id)
  assert.deepEqual(rest.conflicts, [])
  assert.equal((await journal()).at(-1)!.type, 'undone')
  assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'old a\n')
  assert.equal((await restart()).list()[0]!.appliedAt, null); ok('a full undo is recorded, and after a restart the run is not applied')
}

console.log('\nfrom the journal alone')
{
  const e = (type: string, ts: number, extra: Record<string, unknown>) => ({ v: 1, run: 'r', seq: ts, ts, type, ...extra }) as JournalEvent
  assert.equal(appliedFrom([]), null); ok('never applied: not applied')
  assert.equal(appliedFrom([e('applied', 5, { files: [], conflicts: [{ path: 'x', reason: 'r' }] })]), null); ok('an apply that wrote nothing does not count')
  assert.equal(appliedFrom([e('applied', 5, { files: [{ path: 'x', sha256: 'h' }], conflicts: [] }), e('applied', 9, { files: [{ path: 'y', sha256: 'h' }], conflicts: [] })]), 9); ok('applied twice: the latest')
  assert.equal(appliedFrom([e('applied', 5, { files: [{ path: 'x', sha256: 'h' }], conflicts: [] }), e('undone', 7, { files: ['x'], conflicts: [] })]), null); ok('applied then undone: not applied')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
