import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JournalEvent } from '@shared/coding.js'
import { CodingSupervisor, pendingCommits } from '../../src/main/coding/supervisor.js'
import { Workspace } from '../../src/main/coding/workspace.js'
import { Journal } from '../../src/main/coding/journal.js'
import { gitState } from '../../src/main/coding/git.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const exists = (p: string) => stat(p).then(() => true, () => false)

// #109: apply as a commit, optionally on a new branch, and undo by reverting it.
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const base = await mkdtemp(join(tmpdir(), 'git-apply-'))
const dir = join(base, 'coding')
const project = join(base, 'project')
const g = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

await mkdir(project, { recursive: true })
assert.equal((await gitState(project)).repo, false); ok('a folder that is not a repository says so')
g('init', '-q', '-b', 'main')
await writeFile(join(project, 'a.txt'), 'a\n'); await writeFile(join(project, 'b.txt'), 'b\n'); await writeFile(join(project, 'keep.txt'), 'keep\n')
g('add', '.'); g('commit', '-q', '-m', 'start')
// Something the person has staged, unrelated to the run.
await writeFile(join(project, 'keep.txt'), 'keep, staged by hand\n'); g('add', 'keep.txt')
// A hook that would leave a mark, and fail the commit, if it ran.
await writeFile(join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${join(base, 'hook-ran')}"\nexit 1\n`); await chmod(join(project, '.git', 'hooks', 'pre-commit'), 0o755)

const state = await gitState(project)
assert.ok(state.repo && state.branch === 'main' && state.head && state.changed === 1 && state.untracked === 0); ok('a repository: its branch, HEAD and what is uncommitted')

let seq = 0
const newRun = async (id: string, edit: (root: string) => Promise<void>) => {
  await mkdir(join(dir, 'workspaces'), { recursive: true })
  const ws = await Workspace.create(project, join(dir, 'workspaces', id))
  await edit(ws.root)
  seq = 0
  const ev = (e: Record<string, unknown>) => ({ v: 1, run: id, seq: seq++, ts: Date.now(), ...e }) as JournalEvent
  await writeFile(join(dir, `${id}.jsonl`), [ev({ type: 'run.started', task: 'change things', model: 'm', grantRoot: ws.root, mode: 'edit' }), ev({ type: 'run.finished', outcome: 'answered', answer: 'ok', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 } })].map((e) => JSON.stringify(e)).join('\n') + '\n')
}
const supervisor = async () => { const s = new CodingSupervisor(dir, () => null); await s.load(); return s }

console.log('\napply as a commit on a new branch')
const ONE = '11111111-2222-4333-8444-000000000001'
await newRun(ONE, async (root) => {
  await writeFile(join(root, 'a.txt'), 'a changed\n')
  await writeFile(join(root, 'c.txt'), 'new\n')
  await rm(join(root, 'b.txt'))
})
{
  const s = await supervisor()
  const r = await s.apply(ONE, { commit: { message: 'Lowerbeam: change things', branch: 'lowerbeam/one' } })
  assert.deepEqual(r.applied.sort(), ['a.txt', 'b.txt', 'c.txt']); assert.ok(r.commit && 'sha' in r.commit && r.commit.branch === 'lowerbeam/one'); ok('applied, committed, on the new branch')
  assert.equal(g('branch', '--show-current'), 'lowerbeam/one')
  assert.deepEqual(g('show', '--name-status', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Lowerbeam: change things', 'M\ta.txt', 'D\tb.txt', 'A\tc.txt']); ok('the commit holds the run’s three changes, created, changed and removed, with the message given')
  assert.equal(g('diff', '--cached', '--name-only'), 'keep.txt'); ok('what the person had staged is still staged, and not in the commit')
  assert.ok(!(await exists(join(base, 'hook-ran')))); ok('the pre-commit hook did not run')
  const applied = (await Journal.read(join(dir, `${ONE}.jsonl`))).at(-1)!
  assert.ok(applied.type === 'applied' && applied.commit?.branch === 'lowerbeam/one'); ok('the journal records the commit')

  console.log('\nundo reverts it')
  const u = await s.undo(ONE)
  assert.deepEqual(u.conflicts, []); assert.equal(u.reverted?.length, 1)
  assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'a\n'); assert.ok(await exists(join(project, 'b.txt'))); assert.ok(!(await exists(join(project, 'c.txt')))); ok('the files are as they were')
  assert.match(g('log', '-1', '--format=%s'), /^Revert "Lowerbeam: change things"/); assert.equal(g('rev-list', '--count', 'HEAD'), '3'); ok('by a revert commit: history added to, not rewritten')
  assert.equal(g('diff', '--cached', '--name-only'), 'keep.txt'); assert.equal(g('show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(' '), 'a.txt b.txt c.txt'); ok('with the person’s staged work still staged and out of it, which git revert would have refused over')
  assert.deepEqual(pendingCommits(await Journal.read(join(dir, `${ONE}.jsonl`))), []); assert.equal((await supervisor()).list().find((r) => r.id === ONE)!.appliedAt, null); ok('nothing left to revert, and the run is not applied, after a restart too')
}

console.log('\nrefused before anything is written')
const TWO = '11111111-2222-4333-8444-000000000002'
await newRun(TWO, async (root) => { await writeFile(join(root, 'a.txt'), 'a again\n') })
{
  const s = await supervisor()
  await writeFile(join(project, 'a.txt'), 'edited by hand, not committed\n')
  const before = g('rev-parse', 'HEAD')
  await assert.rejects(s.apply(TWO, { commit: { message: 'x', branch: 'lowerbeam/two' } }), /not committed, and a commit would include them: a\.txt/)
  assert.equal(g('rev-parse', 'HEAD'), before); assert.equal(g('branch', '--show-current'), 'lowerbeam/one'); assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'edited by hand, not committed\n'); ok('a file with the person’s own uncommitted edit: refused, no branch, no write')
  g('checkout', '-q', '--', 'a.txt')
  await assert.rejects(s.apply(TWO, { commit: { message: 'x', branch: 'lowerbeam/one' } }), /already exists/); ok('a branch name already taken is refused')
  await assert.rejects(s.apply(TWO, { commit: { message: 'x', branch: 'bad..name' } }), /not a valid branch name/); ok('so is one git would not accept')
}

console.log('\nundo on another branch')
{
  const s = await supervisor()
  const r = await s.apply(TWO, { commit: { message: 'second' } })
  assert.ok(r.commit && 'sha' in r.commit && r.commit.branch === 'lowerbeam/one'); ok('without a branch name, the commit goes on the current branch')
  g('switch', '-q', 'main')
  const u = await s.undo(TWO)
  assert.equal(u.conflicts.length, 1); assert.match(u.conflicts[0]!.reason, /not on the branch the project is on now \(main\)/); ok('undo from another branch is refused, saying which')
  g('switch', '-q', 'lowerbeam/one')
  assert.deepEqual((await s.undo(TWO)).conflicts, []); assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'a\n'); ok('back on the branch, it reverts')
}

console.log('\nwithout git, apply and undo are as before')
{
  const plain = join(base, 'plain'); await mkdir(plain); await writeFile(join(plain, 'x.txt'), 'x\n')
  const id = '11111111-2222-4333-8444-000000000003'
  await mkdir(join(dir, 'workspaces'), { recursive: true })
  const ws = await Workspace.create(plain, join(dir, 'workspaces', id)); await writeFile(join(ws.root, 'x.txt'), 'y\n')
  await writeFile(join(dir, `${id}.jsonl`), JSON.stringify({ v: 1, run: id, seq: 0, ts: 1, type: 'run.started', task: 't', model: 'm', grantRoot: ws.root, mode: 'edit' }) + '\n' + JSON.stringify({ v: 1, run: id, seq: 1, ts: 2, type: 'run.finished', outcome: 'answered', answer: '', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 } }) + '\n')
  const s = await supervisor()
  await assert.rejects(s.apply(id, { commit: { message: 'x' } }), /not a git repository/); ok('asking for a commit outside a repository is refused')
  assert.deepEqual((await s.apply(id)).applied, ['x.txt']); assert.deepEqual((await s.undo(id)).applied, ['x.txt']); ok('a plain apply and undo still work')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
