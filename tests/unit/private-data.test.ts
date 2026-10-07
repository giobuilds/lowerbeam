import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/main/atomicWrite.js'
import { tightenTree } from '../../src/main/private.js'
import { Journal } from '../../src/main/coding/journal.js'
import { Workspace } from '../../src/main/coding/workspace.js'
import { ConversationStore } from '../../src/main/conversations.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777

// #129: the app's data is its user's alone, including what older versions left.
const base = await mkdtemp(join(tmpdir(), 'private-'))

console.log('what the app writes is private from the start')
{
  await writeFileAtomic(join(base, 'fresh', 'settings.json'), '{}')
  assert.equal(await mode(join(base, 'fresh', 'settings.json')), 0o600); assert.equal(await mode(join(base, 'fresh')), 0o700); ok('an atomic write: the file 0600, a folder it made 0700')
  await writeFile(join(base, 'old.json'), 'old', { mode: 0o644 }); await chmod(join(base, 'old.json'), 0o644)
  await writeFileAtomic(join(base, 'old.json'), 'new')
  assert.equal(await mode(join(base, 'old.json')), 0o600); ok('replacing a 0644 file leaves a 0600 one')
  const journal = new Journal(join(base, 'run.jsonl'))
  await journal.append({ v: 1, run: 'r', seq: 0, at: 0, type: 'run.finished', outcome: 'answered', answer: '', rounds: 0, ms: 0, tokens: { promptTokens: 0, predictedTokens: 0 } } as never)
  assert.equal(await mode(join(base, 'run.jsonl')), 0o600); ok('a run’s journal is 0600')
  const project = join(base, 'project'); await mkdir(project); await writeFile(join(project, 'a.txt'), 'a')
  const ws = await Workspace.create(project, join(base, 'coding', 'ws'))
  assert.equal(await mode(ws.root), 0o700); assert.equal(await mode(join(ws.root, '.lowerbeam-baseline.json')), 0o600); ok('a workspace copy sits in a 0700 folder, its manifest 0600')
  const store = new ConversationStore(join(base, 'conversations'))
  const conversation = await store.create()
  const convDir = join(base, 'conversations')
  assert.equal(await mode(convDir), 0o700)
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(convDir)).filter((f) => f.includes(conversation.id))
  assert.ok(files.length > 0); for (const f of files) assert.equal(await mode(join(convDir, f)), 0o600); ok('a conversation: its folder 0700, its file 0600')
}

console.log('\nwhat an older version left is tightened on start')
{
  const data = join(base, 'userData')
  await mkdir(join(data, 'coding', 'ws'), { recursive: true })
  await chmod(data, 0o755); await chmod(join(data, 'coding'), 0o755)
  await writeFile(join(data, 'settings.json'), '{"localApi":{"apiKey":"k"}}'); await chmod(join(data, 'settings.json'), 0o644)
  await writeFile(join(data, 'coding', 'ws', 'run.sh'), '#!/bin/sh\n'); await chmod(join(data, 'coding', 'ws', 'run.sh'), 0o755)
  const outside = join(base, 'outside.txt'); await writeFile(outside, 'not ours'); await chmod(outside, 0o644)
  await symlink(outside, join(data, 'coding', 'link'))
  const changed = await tightenTree(data)
  assert.equal(await mode(data), 0o700); assert.equal(await mode(join(data, 'coding')), 0o700); ok('folders become 0700')
  assert.equal(await mode(join(data, 'settings.json')), 0o600); ok('files become 0600')
  assert.equal(await mode(join(data, 'coding', 'ws', 'run.sh')), 0o700); ok('an executable keeps its owner’s execute bit, and loses everyone else’s')
  assert.equal(await mode(outside), 0o644); assert.ok((await lstat(join(data, 'coding', 'link'))).isSymbolicLink()); ok('a link is not followed: what it points at is not the app’s')
  assert.ok(changed >= 5); assert.equal(await tightenTree(data), 0); ok('a second pass has nothing left to change')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
