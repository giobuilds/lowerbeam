import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runTask } from '../../src/agent/loop.js'
import { Workspace } from '../../src/main/coding/workspace.js'
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
  const journalWithSummaryHash = journal.map((item) =>
    item.type === 'tool.result' ? { ...item, summary: 'Edited src/a.ts sha256 deadbeefdeadbeef' } : item
  )
  const facts = factsFromJournal(journalWithSummaryHash)
  assert.deepEqual(facts.filesChanged.map((file) => file.path), ['src/a.ts'])
  assert.equal(facts.filesChanged[0]?.sha256, null)
  const fromManifest = factsFromJournal(journal, { 'src/a.ts': 'manifestmanifest' })
  assert.equal(fromManifest.filesChanged[0]?.sha256, 'manifestmanifest')
  const fromApply = factsFromJournal([
    ...journal,
    event({ v: 1, run: 'r', seq: 4, ts: 4, type: 'applied', files: [{ path: 'src/a.ts', sha256: 'appliedapplied' }], conflicts: [] })
  ])
  assert.equal(fromApply.filesChanged[0]?.sha256, 'appliedapplied')
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
  const roles = ['system', 'user', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user']
  const tail = keptTurnIndexes(roles.map((role) => ({ role })), 0.3)
  assert.ok(tail.includes(5))
  assert.ok(tail.includes(6))
  ok('the kept tail does not start on a tool result whose call was dropped')
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
        : step === 2
          ? 'Looking once more.'
          : 'The goal was kept: Hearth. Next step done.'
      const call = step < 3 ? { index: 0, id: `c${step}`, function: { name: 'read', arguments: '{"path":"a.ts"}' } } : null
      const prompt = step === 2 ? 4000 : 10
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], timings: { prompt_n: prompt, predicted_n: 20, cache_n: 0 } })}\n\n`)
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
  assert.match(bodies[2]?.messages.map((message) => message.content).join('\n') ?? '', /Keep the name Hearth/)
  ok('the snapshot is accepted, and the next request still has the goal')
  assert.equal(result.outcome, 'answered')
  assert.match(result.answer, /Hearth/)
  ok('the task still completes, and the answer still has the goal')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log('\na refused snapshot on overflow still compacts')
{
  const root = await mkdtemp(join(tmpdir(), 'snap-over-'))
  await writeFile(join(root, 'a.ts'), 'export const name = "Hearth"\n')
  let step = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      step += 1
      if (step === 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'request exceeds context size' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Still here.' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 10, predicted_n: 2, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Say hello.',
    grant: await Grant.open(root),
    settings,
    snapshot: true,
    proposeSnapshot: () => null,
    onEvent: (item) => events.push(item)
  })
  assert.ok(events.some((item) => item.type === 'snapshot' && !item.accepted))
  assert.ok(events.some((item) => item.type === 'checkpoint'))
  assert.equal(result.outcome, 'answered')
  ok('a refused snapshot falls back to the prose checkpoint so the retry can finish')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log('\na tool that throws does not end the run')
{
  const root = await mkdtemp(join(tmpdir(), 'snap-throw-'))
  await mkdir(join(root, 'dir'))
  await writeFile(join(root, 'a.ts'), 'export const name = "Hearth"\n')
  let step = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      step += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const call = step === 1 ? { index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":"dir","content":"x"}' } } : null
      const content = step === 1 ? '' : 'Continued after the tool failed.'
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], timings: { prompt_n: 10, predicted_n: 2, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Write something.',
    grant: await Grant.open(root, 'edit'),
    settings,
    mode: 'edit',
    onEvent: (item) => events.push(item)
  })
  const tool = events.find((item) => item.type === 'tool.result')
  assert.equal(tool && tool.type === 'tool.result' && tool.ok, false)
  assert.equal(result.outcome, 'answered')
  ok('a thrown tool comes back as a failed result and the run goes on')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log('\na snapshot mid-run carries the edited file’s hash')
{
  const base = await mkdtemp(join(tmpdir(), 'snap-hash-'))
  const project = join(base, 'project')
  const copy = join(base, 'copy')
  await mkdir(project)
  const before = 'export const name = "Hearth"\n'
  const after = 'export const name = "Kept"\n'
  await writeFile(join(project, 'a.ts'), before)
  const ws = await Workspace.create(project, copy)
  let step = 0
  const bodies: Array<{ messages: Array<{ content: string }> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      step += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const bulky = Array.from({ length: 80 }, (_, i) => `line ${i} talks about a different fact ${i * 17}.`).join(' ')
      const content = step === 1 ? bulky : step === 2 ? 'Looking once more.' : 'The name is Kept.'
      const call = step === 1
        ? { index: 0, id: 'c1', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.ts', find: before, replace: after }) } }
        : step === 2
          ? { index: 0, id: 'c2', function: { name: 'read', arguments: '{"path":"a.ts"}' } }
          : null
      const prompt = step === 2 ? 4000 : 10
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], timings: { prompt_n: prompt, predicted_n: 20, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Rename Hearth to Kept.',
    grant: await Grant.open(ws.root, 'edit'),
    settings,
    contextLimit: 4096,
    mode: 'edit',
    snapshot: true,
    proposeSnapshot: () => snapshot(),
    onEvent: (item) => events.push(item)
  })
  const hash = createHash('sha256').update(after).digest('hex')
  assert.equal(createHash('sha256').update(await readFile(join(ws.root, 'a.ts'))).digest('hex'), hash)
  assert.equal(events.some((item) => item.type === 'applied'), false)
  assert.ok(events.some((item) => item.type === 'snapshot' && item.accepted))
  assert.match(bodies[2]?.messages.map((message) => message.content).join('\n') ?? '', new RegExp(`a\\.ts \\(${hash.slice(0, 12)}\\)`))
  assert.equal(result.outcome, 'answered')
  ok('an edited file’s hash is in the snapshot before anything is applied')
  server.close()
  await rm(base, { recursive: true, force: true })
}

console.log('\na deadline during a command ends the run')
{
  const root = await mkdtemp(join(tmpdir(), 'snap-stop-'))
  await writeFile(join(root, 'a.ts'), 'export const name = "Hearth"\n')
  let requests = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const call = { index: 0, id: 'c', function: { name: 'run_command', arguments: '{"command":"sleep 30"}' } }
      const content = requests === 1 ? '' : 'The command failed, so here is another turn.'
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: requests === 1 ? [call] : [] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }], timings: { prompt_n: 10, predicted_n: 2, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Run the tests.',
    grant: await Grant.open(root, 'run'),
    settings,
    mode: 'run',
    timeoutMs: 250,
    execute: (_command, signal) =>
      new Promise((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error('The operation was aborted due to timeout')
          err.name = 'TimeoutError'
          reject(err)
        }
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      }),
    onEvent: (item) => events.push(item)
  })
  assert.equal(requests, 1)
  assert.ok(events.some((item) => item.type === 'tool.call' && item.name === 'run_command'))
  assert.equal(events.some((item) => item.type === 'tool.result'), false)
  assert.equal(result.outcome, 'timeout')
  ok('a deadline inside run_command ends the run, and the model does not get another turn')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
