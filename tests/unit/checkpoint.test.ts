import assert from 'node:assert/strict'
import { checkpointFrom, renderCheckpoint, renderReminder, verifyCheckpoint, compactWorkingSet } from '@context/checkpoint.js'
import type { JournalEvent } from '@shared/coding.js'
import type { ChatTurn } from '@shared/chatClient.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
let seq = 0
const ev = (rest: Record<string, unknown>): JournalEvent => ({ v: 1, run: 'r', seq: seq++, ts: seq, ...rest }) as JournalEvent
const call = (id: string, name: string, args: Record<string, unknown>) => ev({ type: 'tool.call', callId: id, name, args })
const result = (id: string, summary: string, ok = true, denied = false) => ev({ type: 'tool.result', callId: id, ok, denied, summary, chars: summary.length })
const cmd = (command: string, exitCode: number) => ev({ type: 'command.finished', command, exitCode, ms: 10, timedOut: false, outputBytes: 0, truncated: false })
const said = (round: number, say: string) => ev({ type: 'model.response', round, contentChars: say.length, reasoningChars: 0, toolCalls: 1, usage: null, finishReason: 'tool_calls', ms: 1, say })

// A run that searched, read, edited, ran the tests, was refused once, edited again.
const events: JournalEvent[] = [
  ev({ type: 'run.started', task: 'fix it', model: 'm', grantRoot: '/p', mode: 'run' }),
  ev({ type: 'model.request', round: 1, turns: 2, tools: [] }),
  call('a', 'search', { query: 'isHttpUrl' }), result('a', 'src/shared/url.ts:12: export function isHttpUrl'),
  ev({ type: 'model.request', round: 2, turns: 4, tools: [] }),
  call('b', 'read', { path: 'src/shared/url.ts' }), result('b', 'src/shared/url.ts (40 lines, sha256 abc)'),
  call('c', 'read', { path: 'tests/unit/url.test.ts', start: 30, end: 60 }), result('c', 'tests/unit/url.test.ts (312 lines, sha256 def)'),
  ev({ type: 'model.request', round: 3, turns: 8, tools: [] }),
  said(3, 'The gate accepts javascript: URLs. I will remove that branch and run the suite.'),
  call('d', 'edit_file', { path: 'src/shared/url.ts', find: 'x', replace: 'y' }), result('d', 'Edited src/shared/url.ts at line 14: 1 line(s) replaced by 1.'),
  ev({ type: 'model.request', round: 4, turns: 10, tools: [] }),
  call('e', 'run_command', { command: 'node tests/run.mjs url' }), cmd('node tests/run.mjs url', 1), result('e', '$ node tests/run.mjs url'),
  ev({ type: 'model.request', round: 5, turns: 12, tools: [] }),
  said(5, 'The suite still fails. I will read the file again and copy the passage exactly.'),
  call('f', 'edit_file', { path: 'src/shared/url.ts', find: 'nope', replace: 'y' }), result('f', 'Not found in src/shared/url.ts: the text to find does not appear.', false),
  call('g', 'read', { path: '../outside' }), result('g', 'Outside the project', false, true)
]
const throughRound5 = seq - 1

console.log('a checkpoint is a projection of the journal')
{
  const c = checkpointFrom(events)
  assert.equal(c.throughSeq, throughRound5); assert.equal(c.rounds, 5); ok('it covers the record to its last sequence and knows the round')
  assert.deepEqual(c.read, [{ path: 'src/shared/url.ts', range: 'all 40 lines' }, { path: 'tests/unit/url.test.ts', range: 'lines 30–60 of 312' }])
  ok('files read, with the range that was shown')
  assert.deepEqual(c.searched, [{ query: 'isHttpUrl', result: 'src/shared/url.ts:12: export function isHttpUrl' }]); ok('searches, with their first line')
  assert.deepEqual(c.changed, [{ path: 'src/shared/url.ts', how: 'edited', times: 1 }]); ok('files changed, by successful edits only')
  assert.deepEqual(c.commands, [{ command: 'node tests/run.mjs url', exitCode: 1, timedOut: false }]); ok('commands with their exit codes')
  assert.deepEqual(c.verification, { status: 'failed', command: 'node tests/run.mjs url' }); ok('verification: the last command after the last edit failed')
  assert.deepEqual(c.problems, ['edit_file: Not found in src/shared/url.ts: the text to find does not appear.', 'read: Outside the project'])
  ok('unresolved problems: the refusals since the last successful edit')
  assert.deepEqual(c.intent, { round: 5, text: 'The suite still fails. I will read the file again and copy the passage exactly.' })
  ok('and what the model last said it was doing, in its own words — the newest, not the first')
  const newer = checkpointFrom([...events, said(6, 'The suite still fails. I will read the test.')])
  assert.equal(newer.intent?.round, 6); ok('a newer statement replaces it rather than joining it')
  // Transient means replaced every step. An intent nothing has replaced for
  // several rounds is a stale plan, and handing it back reinforces a loop.
  const stale = checkpointFrom([...events, ev({ type: 'model.request', round: 8, turns: 20, tools: [] })])
  assert.equal(stale.rounds, 8); assert.equal(stale.intent, null)
  ok('an intent the model has not restated for two rounds is dropped, not repeated back')
  assert.equal(checkpointFrom(events.slice(0, 6)).intent, null); ok('and a run that has said nothing has no intent, not an invented one')
  assert.equal(checkpointFrom(events.slice(0, 13)).intent?.round, 3); ok('an earlier statement stands while it is still the newest')
}

console.log('\nverification status follows the record')
{
  const passed = checkpointFrom([...events, call('h', 'edit_file', { path: 'src/shared/url.ts', find: 'y', replace: 'z' }), result('h', 'Edited src/shared/url.ts at line 14: 1 line(s) replaced by 1.'), call('i', 'run_command', { command: 'npm test' }), cmd('npm test', 0), result('i', '$ npm test')])
  assert.deepEqual(passed.verification, { status: 'passed', command: 'npm test' }); ok('a passing command after the last edit is passed')
  assert.equal(passed.changed[0]!.times, 2); assert.deepEqual(passed.problems, []); ok('the second edit counts, and clears the earlier refusal')
  const stale = checkpointFrom([...events, call('h', 'edit_file', { path: 'src/shared/url.ts', find: 'y', replace: 'z' }), result('h', 'Edited src/shared/url.ts at line 14: 1 line(s) replaced by 1.')])
  assert.equal(stale.verification.status, 'stale'); ok('an edit after the last command makes it stale')
  const none = checkpointFrom(events.slice(0, 12))
  assert.equal(none.verification.status, 'none'); assert.equal(none.rounds, 3); ok('no command at all is none')
  const beforeAnyEdit = checkpointFrom([...events.slice(0, 10), call('x', 'run_command', { command: 'npm test' }), cmd('npm test', 0), result('x', '$ npm test')])
  assert.deepEqual(beforeAnyEdit.verification, { status: 'none', command: null }); assert.equal(beforeAnyEdit.commands.length, 1)
  ok('a command run before any edit is listed but verifies nothing')
  const partial = checkpointFrom(events, events[9]!.seq)
  assert.equal(partial.rounds, 3); assert.deepEqual(partial.changed, []); ok('a record through an earlier sequence stops there')
}

console.log('\nthe notes are prose from a template')
{
  const text = renderCheckpoint(checkpointFrom(events))
  assert.match(text, /after 5 rounds/); assert.match(text, /read a file again/); ok('it says what it is and what is gone')
  assert.match(text, /Files read: src\/shared\/url\.ts \(all 40 lines\); tests\/unit\/url\.test\.ts \(lines 30–60 of 312\)\./); ok('files read')
  assert.match(text, /Changes made so far, in the copy: src\/shared\/url\.ts \(edited\)\./); ok('changes')
  assert.match(text, /`node tests\/run\.mjs url` → exit 1/); assert.match(text, /failed after the last edit; its output is not kept here, so run it again/); ok('commands, and a failed verification says to run again')
  assert.match(text, /Unresolved: edit_file: Not found/); ok('problems')
  assert.match(text, /On round 5 you said: "The suite still fails\. I will read the file again and copy the passage exactly\."$/)
  ok('and the model\'s own last words, quoted, last')
  const fresh = renderCheckpoint(checkpointFrom(events.slice(0, 2)))
  assert.match(fresh, /No files read yet\./); assert.match(fresh, /No files changed yet\./); assert.ok(!/Verification/.test(fresh)); ok('a run that has done nothing says so without inventing a verification line')
}

console.log('\nevery claim in a record must be in the journal')
{
  const c = checkpointFrom(events)
  assert.deepEqual(verifyCheckpoint(c, events), []); ok('the projection is supported in full')
  const forged = { ...c, read: [...c.read, { path: 'src/main/index.ts', range: null }], changed: [{ path: 'src/shared/host.ts', how: 'created' as const, times: 1 }], commands: [{ command: 'npm test', exitCode: 0, timedOut: false }], intent: { round: 5, text: 'I have finished and everything passes.' } }
  assert.deepEqual(verifyCheckpoint(forged, events), ['read src/main/index.ts', 'changed src/shared/host.ts', 'command npm test → 0', 'said on round 5'])
  ok('a read, a change, a command and a quote the journal does not hold are each named as unsupported')
  const early = { ...c, throughSeq: events[9]!.seq }
  assert.ok(verifyCheckpoint(early, events).includes('changed src/shared/url.ts')); ok('a claim from after the covered sequence is unsupported too')
}

console.log('\nthe working set after compaction')
{
  const turns: ChatTurn[] = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'the task' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read', argumentsJson: '{}' }] },
    { role: 'tool', toolCallId: '1', content: 'a.ts (3 lines)\n1| x\n2| y\n3| z' },
    { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'read', argumentsJson: '{}' }, { id: '3', name: 'search', argumentsJson: '{}' }] },
    { role: 'tool', toolCallId: '2', content: 'b.ts (2 lines)\n1| p\n2| q' },
    { role: 'tool', toolCallId: '3', content: 'No lines contain "q".' }
  ]
  const out = compactWorkingSet(turns, 'NOTES', false)
  assert.deepEqual(out.map((t) => t.role), ['system', 'user', 'system', 'assistant', 'tool', 'tool']); ok('policy, task, notes, then the newest round whole')
  assert.equal(out[0]!.content, 'policy'); assert.equal(out[1]!.content, 'the task'); assert.equal(out[2]!.content, 'NOTES'); ok('the first two turns are untouched, so their prefix stays cached')
  assert.equal(out[4]!.content, 'b.ts (2 lines)\n1| p\n2| q'); ok('the newest results are kept in full')
  const again = compactWorkingSet(out, 'NOTES 2', true)
  assert.deepEqual(again.map((t) => t.role), ['system', 'user', 'system', 'assistant', 'tool', 'tool']); assert.equal(again[2]!.content, 'NOTES 2')
  ok('a second compaction replaces the notes rather than stacking them')
  assert.equal(again[4]!.content, 'b.ts (2 lines)\n(result folded — ask again to see it in full)'); assert.equal(again[5]!.content, 'No lines contain "q".')
  ok('with the newest round folded when asked, one-line results left as they are')
  assert.deepEqual(compactWorkingSet(turns.slice(0, 2), 'N', false).map((t) => t.role), ['system', 'user', 'system']); ok('and nothing breaks before the first round')
}

console.log('\nthe reminder a write run gets when it has changed nothing')
{
  // The record after the reads and the search, before anything was edited.
  const before = checkpointFrom(events, events[8]!.seq)
  const text = renderReminder(before, 6)
  assert.ok(text.startsWith('You have used 2 rounds and changed nothing yet; 6 remain.')); ok('it says how many rounds are spent and how many are left')
  assert.ok(text.includes('Files read: src/shared/url.ts (all 40 lines); tests/unit/url.test.ts (lines 30–60 of 312).')); ok('and what the record shows was read, with ranges')
  assert.ok(text.includes('Searches: "isHttpUrl" → src/shared/url.ts:12: export function isHttpUrl.')); ok('and what was searched')
  assert.ok(!text.includes('Commands run')); ok('nothing about commands when none were run')
  assert.ok(text.includes('change it now with edit_file')); assert.ok(text.endsWith('it is not done until a file has changed.')); ok('and asks for the edit')
  const one = renderReminder({ ...before, rounds: 1 }, 1)
  assert.ok(one.startsWith('You have used 1 round and changed nothing yet; 1 remains.')); ok('singulars')
  const late = renderReminder(checkpointFrom(events), 3)
  assert.ok(late.includes('Commands run: `node tests/run.mjs url` → exit 1.')); assert.ok(late.includes('Unresolved: edit_file: Not found')); ok('later, the commands and the unresolved refusals are in it too')
}

console.log(`\n${n} assertions passed`)
