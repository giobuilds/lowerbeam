import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runTask } from '../../src/agent/loop.js'
import { REPEAT_PROSE_KEEP, RepeatGuard, callKey } from '../../src/agent/repeatGuard.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}
const settings = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }

console.log('the same call and result')
{
  const guard = new RepeatGuard()
  const args = { path: 'a.ts', start: 1 }
  const swapped = { start: 1, path: 'a.ts' }
  assert.equal(callKey('read', args), callKey('read', swapped))
  ok('argument key order does not matter')
  assert.equal(guard.observeCall('read', args, 'file text', true), null)
  const nudge = guard.observeCall('read', swapped, 'file text', true)
  assert.equal(nudge?.action, 'nudge')
  assert.equal(nudge?.count, 2)
  ok('the second identical call and result is a nudge')
  const stop = guard.observeCall('read', args, 'file text', true)
  assert.equal(stop?.action, 'stop')
  assert.equal(stop?.reason, 'repeating')
  ok('the third stops the run')
}

console.log('\nthe same error, and a write that breaks the loop')
{
  const guard = new RepeatGuard()
  assert.equal(guard.observeCall('read', { path: 'a.ts' }, 'No such path', false)?.action, undefined)
  assert.equal(guard.observeCall('read', { path: 'b.ts' }, 'No such path', false), null)
  const stop = guard.observeCall('search', { query: 'x' }, 'No such path', false)
  assert.equal(stop?.reason, 'repeating_error')
  ok('the same error three times, with different arguments, stops the run')

  const again = new RepeatGuard()
  again.observeCall('read', { path: 'a.ts' }, 'one', true)
  again.observeCall('read', { path: 'a.ts' }, 'one', true)
  again.noteWrite('edit_file', { path: 'a.ts' })
  assert.equal(again.observeCall('read', { path: 'a.ts' }, 'one', true), null)
  ok('an identical call after a successful edit of that file is not a repeat')

  const prose = new RepeatGuard()
  const chunk = 'The same paragraph comes back word for word, long enough to count as a repeated stretch of the answer. '.repeat(3)
  assert.equal(prose.observeProse(chunk), null)
  assert.equal(prose.observeProse(chunk), null)
  assert.equal(prose.observeProse(chunk)?.reason, 'repeating_text')
  ok('the same stretch of prose three times stops the run')

  const capped = new RepeatGuard()
  const oldProse = 'A paragraph that is long enough to be remembered as prose, and that should fall out of the history. '.repeat(3)
  capped.observeProse(oldProse)
  capped.observeProse(oldProse)
  for (let i = 0; i < REPEAT_PROSE_KEEP; i++) {
    capped.observeProse(`Reply ${i} is its own paragraph, long enough to be stored, and not a copy of the first. `.repeat(3))
  }
  assert.equal(capped.observeProse(oldProse), null)
  ok('prose older than the remembered replies does not count toward a stop')
}

console.log('\na coding run that keeps reading one file')
{
  const root = await mkdtemp(join(tmpdir(), 'repeat-'))
  await writeFile(join(root, 'a.ts'), 'export const hi = 1\n')
  let requests = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const call = { index: 0, id: 'c', function: { name: 'read', arguments: '{"path":"a.ts"}' } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], timings: { prompt_n: 20, predicted_n: 8, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const events: JournalEvent[] = []
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'Read a.ts',
    grant: await Grant.open(root),
    settings,
    maxRounds: 8,
    onEvent: (event) => events.push(event)
  })
  assert.equal(result.outcome, 'repeating')
  ok('the run stops with repeating')
  const guards = events.filter((event) => event.type === 'repeat_guard')
  assert.equal(guards.length, 2)
  assert.equal(guards[0] && guards[0].type === 'repeat_guard' && guards[0].action, 'nudge')
  assert.equal(guards[1] && guards[1].type === 'repeat_guard' && guards[1].action, 'stop')
  ok('the journal has the nudge and then the stop')
  assert.equal(requests, 3)
  ok('it does not ask the model again after the third call')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
