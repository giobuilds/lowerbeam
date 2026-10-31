import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runTask } from '../../src/agent/loop.js'
import {
  acceptSnapshot,
  factsFromJournal,
  keptTurnIndexes,
  mergeConstraints,
  parseSnapshot,
  SNAPSHOT_KEEP_SHARE,
  SNAPSHOT_SCHEMA,
  type RunSnapshot
} from '../../src/context/snapshot.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}
const settings = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }

const snapshot = (extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
  goal: 'Keep the name Hearth',
  constraints: ['do not rename it'],
  decisions: [],
  filesChanged: [],
  commands: [],
  openQuestions: [],
  nextStep: 'answer with the name',
  ...extra
})

const event = (partial: JournalEvent): JournalEvent => partial

console.log('a snapshot has to be the shape asked for')
{
  assert.ok(SNAPSHOT_SCHEMA.required.includes('goal'))
  assert.ok(parseSnapshot(snapshot()))
  assert.equal(parseSnapshot({ goal: 1 }), null)
  ok('a snapshot needs every field, and a goal that is text')
}

console.log('\nconstraints survive, and the journal wins')
{
  const first = snapshot()
  const second = snapshot({ constraints: ['add a test'], goal: 'Keep the name Hearth' })
  const merged = mergeConstraints(first, second)
  assert.ok(merged.constraints.includes('do not rename it'))
  assert.ok(merged.constraints.includes('add a test'))
  ok('a constraint from the first snapshot is still in the second')
  const journal = [
    event({ v: 1, run: 'r', seq: 1, ts: 1, type: 'tool.call', callId: 'c', name: 'edit_file', args: { path: 'src/a.ts' } }),
    event({ v: 1, run: 'r', seq: 2, ts: 2, type: 'tool.result', callId: 'c', ok: true, denied: false, summary: 'Edited src/a.ts', chars: 10 }),
    event({ v: 1, run: 'r', seq: 3, ts: 3, type: 'command.finished', command: 'npm test', exitCode: 0, ms: 10, timedOut: false, outputBytes: 4, truncated: false })
  ]
  const facts = factsFromJournal(journal)
  assert.deepEqual(facts.filesChanged.map((file) => file.path), ['src/a.ts'])
  assert.equal(facts.commands[0]?.passed, true)
  const accepted = acceptSnapshot(snapshot({ filesChanged: [{ path: 'nope.ts', sha256: null }], commands: [] }), null, journal, 'x'.repeat(2000))
  assert.equal(accepted.ok, true)
  if (accepted.ok) {
    assert.deepEqual(accepted.snapshot.filesChanged.map((file) => file.path), ['src/a.ts'])
    assert.equal(accepted.snapshot.commands[0]?.command, 'npm test')
  }
  ok('files and test results are taken from the journal, not from the model')
  const inflated = acceptSnapshot(snapshot(), null, [], 'short')
  assert.equal(inflated.ok, false)
  if (!inflated.ok) assert.match(inflated.reason, /no smaller/)
  ok('a snapshot that is no smaller than the turns is refused')
  const empty = acceptSnapshot(snapshot({ goal: '   ' }), null, [], 'x'.repeat(2000))
  assert.equal(empty.ok, false)
  ok('a snapshot with no goal is refused')
}

console.log('\nthe first message and the newest turns stay')
{
  const kept = keptTurnIndexes(10, SNAPSHOT_KEEP_SHARE)
  assert.deepEqual(kept.slice(0, 2), [0, 1])
  assert.ok(kept.includes(9))
  assert.ok(!kept.includes(2))
  ok('the first two turns are kept, and so is the newest share, not the middle')
}

console.log('\na run compacted mid-task still has the goal')
{
  const root = await mkdtemp(join(tmpdir(), 'snap-'))
  await writeFile(join(root, 'a.ts'), 'export const name = "Hearth"\n')
  let step = 0
  const bodies: Array<{ messages: Array<{ content: string }> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      step += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const content = step === 1
        ? Array.from({ length: 80 }, (_, i) => `line ${i} talks about a different fact ${i * 17}.`).join(' ')
        : 'The goal was kept: Hearth. Next step done.'
      const call = step === 1 ? { index: 0, id: 'c', function: { name: 'read', arguments: '{"path":"a.ts"}' } } : null
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], timings: { prompt_n: 4000, predicted_n: 200, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Say the name and stop.',
    grant: await Grant.open(root),
    settings,
    contextLimit: 4096,
    snapshot: true,
    proposeSnapshot: () => snapshot(),
    onEvent: (event) => events.push(event)
  })
  assert.ok(events.some((event) => event.type === 'snapshot' && event.accepted))
  assert.match(bodies[1]?.messages.map((message) => message.content).join('\n') ?? '', /Keep the name Hearth/)
  ok('the snapshot is accepted, and the next request still has the goal')
  assert.equal(result.outcome, 'answered')
  assert.match(result.answer, /Hearth/)
  ok('the task still completes, and the answer still has the goal')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
