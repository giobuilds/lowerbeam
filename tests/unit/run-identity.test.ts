import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOT_THIS_RUN, RunIdentities } from '../../src/main/coding/identity.js'
import { CodingSupervisor } from '../../src/main/coding/supervisor.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const refuses = (fn: () => void) => assert.throws(fn, (err: unknown) => err instanceof Error && err.message === NOT_THIS_RUN)

console.log('an identity is not the run id, and only that identity is accepted')
{
  const ids = new RunIdentities()
  const run = '11111111-2222-4333-8444-000000000001'
  const other = '11111111-2222-4333-8444-000000000002'
  const token = ids.issue(run)
  const second = ids.issue(other)
  assert.equal(ids.issue(run), token); ok('issuing again keeps the first')
  assert.notEqual(token, run); assert.notEqual(token, second); ok('it is not the run id, and not another run’s')
  assert.equal(token.length, 43); ok('32 bytes, base64url')
  ids.assert(run, token); ok('the issued identity is accepted')
  refuses(() => ids.assert(run, second)); ok('another run’s identity is refused')
  refuses(() => ids.assert(run, run)); ok('the run id is refused')
  refuses(() => ids.assert(run, '')); ok('an empty identity is refused')
  refuses(() => ids.assert(run, 'no-such-run')); ok('a run this process did not issue is refused')
  refuses(() => ids.assert('missing', token)); ok('an unknown run is refused the same way')
  refuses(() => ids.assert(run, null))
  refuses(() => ids.assert(run, 1))
  refuses(() => ids.assert(run, { token }))
  refuses(() => ids.assert(run, token + token))
  ok('a non-string, a number, an object and an over-long string are refused')
  ids.forget(run)
  refuses(() => ids.assert(run, token)); ok('a forgotten run no longer accepts its identity')
  ids.clear()
  refuses(() => ids.assert(other, second)); ok('clearing drops every identity')
}

console.log('\na loaded run’s identity is not in its journal or its summary')
{
  const dir = await mkdtemp(join(tmpdir(), 'run-identity-'))
  const id = '11111111-2222-4333-8444-00000000000a'
  const events = [
    { v: 1, run: id, seq: 0, ts: 1, type: 'run.started', task: 'where', model: 'm', grantRoot: '/p', mode: 'inspect' },
    { v: 1, run: id, seq: 1, ts: 2, type: 'run.finished', outcome: 'answered', answer: 'there', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 } }
  ] as JournalEvent[]
  const file = join(dir, `${id}.jsonl`)
  await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')

  const supervisor = new CodingSupervisor(dir, () => null)
  await supervisor.load()
  const token = supervisor.issuedIdentities([id])[id]
  assert.equal(typeof token, 'string'); assert.ok(token); ok('loading a journal issues an identity')
  assert.deepEqual(supervisor.issuedIdentities(['nope']), {}); ok('and not for a run that is not loaded')
  supervisor.authorise(id, token); ok('that identity authorises a request for the run')
  refuses(() => supervisor.authorise(id, id)); ok('the run id does not')
  const journal = await readFile(file, 'utf8')
  const listed = JSON.stringify(supervisor.list())
  assert.ok(!journal.includes(token!)); assert.ok(!listed.includes(token!)); ok('the journal and the summary do not contain it')
  assert.equal('identity' in supervisor.list()[0]!, false); ok('the summary has no identity field')
  const eventsBack = await supervisor.events(id)
  assert.equal(eventsBack.length, 2); ok('the journal can still be read in process without presenting it')

  const restarted = new CodingSupervisor(dir, () => null)
  await restarted.load()
  const again = restarted.issuedIdentities([id])[id]
  assert.notEqual(again, token); ok('a new process issues a new identity')
  refuses(() => restarted.authorise(id, token))
  restarted.authorise(id, again)
  ok('the previous process’s identity is refused, and the new one is accepted')

  assert.equal(await supervisor.deleteAllRuns(), 1)
  refuses(() => supervisor.authorise(id, token)); ok('deleting the runs drops the identity')
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
