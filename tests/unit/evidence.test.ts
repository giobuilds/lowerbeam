import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureLines, classifyFailures, sameCommand, isTestPath, evidenceFrom, withRerun } from '@shared/evidence.js'
import type { JournalEvent } from '@shared/coding.js'
import { CodingSupervisor } from '../../src/main/coding/supervisor.js'
import { Workspace } from '../../src/main/coding/workspace.js'
import { probeSandbox } from '../../src/main/coding/sandbox.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('failure lines are picked out of a runner’s output and normalised')
{
  const out = [
    '  ok   unit/url  8 assertions',
    ' FAIL  unit/command',
    '\x1b[31mAssertionError [ERR_ASSERTION]: Expected values to be strictly equal\x1b[0m',
    '[12:00:01] error: something broke (12ms)',
    '20 suites, 331 assertions passed',
    '0 errors',
    'no failures',
    'errors were logged',
    ' FAIL  unit/command'
  ].join('\n')
  const lines = failureLines(out)
  assert.deepEqual(lines, ['FAIL unit/command', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal', 'error: something broke'])
  ok('FAIL, AssertionError and error: lines, once each, without colour codes, timestamps or timings; counts and "errors were logged" are not failures')
  assert.deepEqual(failureLines(''), []); ok('and an empty output has none')
}

console.log('\nfailures either side of a change are compared as sets')
{
  const c = classifyFailures(['FAIL a', 'FAIL b'], ['FAIL b', 'FAIL c'])
  assert.deepEqual(c, { newFailures: ['FAIL c'], preexisting: ['FAIL b'], fixed: ['FAIL a'] }); ok('new, pre-existing, fixed')
}

console.log('\nthe same command with a different tail is the same command')
{
  assert.ok(sameCommand('node tests/run.mjs command', 'node tests/run.mjs command 2>&1 | head -50')); ok('| head -N does not make a different test run')
  assert.ok(sameCommand('npm test 2>&1 | tail -30', 'npm test')); ok('nor 2>&1 | tail -N')
  assert.ok(!sameCommand('node tests/run.mjs command', 'node tests/run.mjs grant')); ok('a different suite is a different command')
}

console.log('\ntest files by the conventions runners share')
{
  for (const p of ['tests/unit/url.test.ts', 'src/url.spec.js', 'pkg/thing_test.go', 'tests/test_x.py', 'spec/models/user_spec.rb', '__tests__/a.tsx']) assert.ok(isTestPath(p), p)
  for (const p of ['src/shared/url.ts', 'src/main/coding/supervisor.ts', 'README.md', 'contest/rules.md']) assert.ok(!isTestPath(p), p)
  ok('tests/, __tests__/, spec/, .test., .spec., _test.go, test_*.py, _spec.rb — and not contest/')
}

let seq = 0
const ev = (rest: Record<string, unknown>): JournalEvent => ({ v: 1, run: 'r', seq: seq++, ts: seq, ...rest }) as JournalEvent
const call = (id: string, name: string, args: Record<string, unknown>) => ev({ type: 'tool.call', callId: id, name, args })
const result = (id: string, summary: string, ok = true) => ev({ type: 'tool.result', callId: id, ok, denied: false, summary, chars: summary.length })
const cmd = (command: string, exitCode: number) => ev({ type: 'command.finished', command, exitCode, ms: 10, timedOut: false, outputBytes: 0, truncated: false })

console.log('\nevidence is read off the record')
{
  const events: JournalEvent[] = [
    ev({ type: 'run.started', task: 'fix it', model: 'm', grantRoot: '/p', mode: 'run' }),
    call('a', 'run_command', { command: 'node tests/run.mjs command 2>&1 | head -50' }), cmd('node tests/run.mjs command 2>&1 | head -50', 1), result('a', '$ node tests/run.mjs command'),
    call('b', 'read', { path: 'src/shared/command.ts' }), result('b', 'src/shared/command.ts (33 lines)'),
    call('c', 'edit_file', { path: 'src/shared/command.ts', find: 'x', replace: 'y' }), result('c', 'Edited src/shared/command.ts at line 12: 1 line(s) replaced by 1.'),
    call('d', 'edit_file', { path: 'tests/unit/command.test.ts', find: 'x', replace: 'y' }), result('d', 'Edited tests/unit/command.test.ts at line 4: 1 line(s) replaced by 1.'),
    call('e', 'run_command', { command: 'node tests/run.mjs command' }), cmd('node tests/run.mjs command', 0), result('e', '$ node tests/run.mjs command')
  ]
  const before = ' FAIL  unit/command\nAssertionError: slug\n FAIL  unit/old\n'
  const after = '  ok   unit/command  12 assertions\n FAIL  unit/old\n'
  const e = evidenceFrom(events, { 1: before, 2: after }, ['src/shared/command.ts', 'tests/unit/command.test.ts'])
  assert.equal(e.verification?.command, 'node tests/run.mjs command'); assert.equal(e.verification?.exitCode, 0); ok('the verification is the last command after the last edit')
  assert.equal(e.baseline?.source, 'record'); assert.equal(e.baseline?.exitCode, 1); ok('the baseline is the same command before any edit, from the run itself')
  assert.deepEqual(e.newFailures, []); assert.deepEqual(e.preexisting, ['FAIL unit/old']); assert.deepEqual(e.fixed, ['FAIL unit/command', 'AssertionError: slug'])
  ok('a failure that was there before the run is not the run’s; what went away is named')
  assert.deepEqual(e.testFilesChanged, ['tests/unit/command.test.ts']); ok('and the test file it edited is named, so the pass is not taken as proof')

  const missing = evidenceFrom(events, { 1: null, 2: after }, [])
  assert.equal(missing.baseline?.outputAvailable, false); assert.deepEqual(missing.preexisting, []); ok('without the baseline output nothing is classified, and the record says the output is missing')

  const none = evidenceFrom(events.slice(0, 6), { 1: before }, ['src/shared/command.ts'])
  assert.equal(none.verification, null); ok('a run that ran nothing after its edit has no verification')

  const rerun = withRerun(e, { command: 'node tests/run.mjs command', exitCode: 1, timedOut: false, output: ' FAIL  unit/command\n FAIL  unit/old\n', drifted: ['README.md'] })
  assert.equal(rerun.baseline?.source, 'rerun'); assert.deepEqual(rerun.fixed, ['FAIL unit/command']); assert.deepEqual(rerun.drifted, ['README.md'])
  ok('a rerun on the baseline replaces the record’s baseline and names what drifted')
}

console.log('\nthe supervisor reads evidence from the journal and the kept outputs')
{
  const base = await mkdtemp(join(tmpdir(), 'evidence-'))
  const project = join(base, 'project')
  const dir = join(base, 'coding')
  await mkdir(join(project, 'tests'), { recursive: true })
  await writeFile(join(project, 'status.txt'), 'FAIL old\n')
  await writeFile(join(project, 'tests', 'a.test.js'), 'old\n')
  const id = '11111111-2222-4333-8444-555555555555'
  await mkdir(join(dir, 'workspaces'), { recursive: true })
  const ws = await Workspace.create(project, join(dir, 'workspaces', id))
  // The run edited a source file and a test, then ran `cat status.txt`.
  await writeFile(join(ws.root, 'status.txt'), 'FAIL new\n')
  await writeFile(join(ws.root, 'tests', 'a.test.js'), 'new\n')
  seq = 0
  const events: JournalEvent[] = [
    ev({ type: 'run.started', task: 'fix it', model: 'm', grantRoot: ws.root, mode: 'run' }),
    call('a', 'run_command', { command: 'cat status.txt' }), cmd('cat status.txt', 0), result('a', '$ cat status.txt'),
    call('b', 'edit_file', { path: 'status.txt', find: 'old', replace: 'new' }), result('b', 'Edited status.txt at line 1: 1 line(s) replaced by 1.'),
    call('c', 'run_command', { command: 'cat status.txt' }), cmd('cat status.txt', 0), result('c', '$ cat status.txt'),
    ev({ type: 'run.finished', outcome: 'answered', answer: 'done', rounds: 3, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 }, denials: 0 })
  ]
  await writeFile(join(dir, `${id}.jsonl`), events.map((e) => JSON.stringify({ ...e, run: id })).join('\n') + '\n')
  await writeFile(join(dir, `${id}.cmd-1.txt`), '$ cat status.txt\nFAIL old\n')
  await writeFile(join(dir, `${id}.cmd-2.txt`), '$ cat status.txt\nFAIL new\n')
  const supervisor = new CodingSupervisor(dir, () => null)
  await supervisor.load()
  const e = (await supervisor.evidence(id))!
  assert.equal(e.baseline?.source, 'record'); assert.deepEqual(e.newFailures, ['FAIL new']); assert.deepEqual(e.fixed, ['FAIL old']); assert.deepEqual(e.testFilesChanged, ['tests/a.test.js'])
  ok('the k-th kept output goes with the k-th command, the echoed command line dropped')
  assert.equal(await supervisor.evidence('not-a-run'), null); ok('an unknown run has none')

  if ((await probeSandbox()).ok) {
    // The project moved on since the baseline; the rerun says so.
    await writeFile(join(project, 'README.md'), 'later\n')
    const r = (await supervisor.checkBaseline(id))!
    assert.equal(r.baseline?.source, 'rerun'); assert.deepEqual(r.baseline?.failures, ['FAIL old']); assert.deepEqual(r.newFailures, ['FAIL new'])
    ok('rerun on a fresh copy of the project, the baseline still says FAIL old')
    assert.deepEqual(r.drifted, ['README.md']); ok('and a file the project gained since the baseline is named as drift')
    const again = (await supervisor.evidence(id))!
    assert.equal(again.baseline?.source, 'rerun'); ok('the rerun is kept and read back with the evidence')
  } else {
    console.log('  skipped the rerun: no sandbox here')
  }
  await rm(base, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
