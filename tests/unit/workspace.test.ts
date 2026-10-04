import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/coding/workspace.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const base = await mkdtemp(join(tmpdir(), 'ws-'))
const project = join(base, 'project')
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1\n')
await writeFile(join(project, 'src', 'b.ts'), 'export const b = 2\n')
await writeFile(join(project, 'README.md'), '# p\n')
await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'x')

console.log('a workspace is a copy with a baseline')
const ws = await Workspace.create(project, join(base, 'ws1'))
{
  assert.equal(await readFile(join(ws.root, 'src', 'a.ts'), 'utf8'), 'export const a = 1\n'); ok('files are copied')
  assert.ok(!('node_modules/dep/index.js' in ws.manifest.files)); ok('dependency trees are not')
  assert.equal(Object.keys(ws.manifest.files).length, 3); ok('the manifest names every copied file')
  assert.match(ws.manifest.files['src/a.ts']!, /^[a-f0-9]{64}$/); ok('with a content hash each')
  const reopened = await Workspace.open(ws.root)
  assert.deepEqual(reopened.manifest.files, ws.manifest.files); ok('and it reopens from disk with the same baseline')
}

console.log('\nchanges are what differs from the baseline')
{
  assert.deepEqual((await ws.changes()).files, []); ok('nothing, before anything is written')
  await writeFile(join(ws.root, 'src', 'a.ts'), 'export const a = 10\n')
  await writeFile(join(ws.root, 'src', 'c.ts'), 'export const c = 3\n')
  await rm(join(ws.root, 'src', 'b.ts'))
  const changes = await ws.changes()
  const kinds = Object.fromEntries(changes.files.map((f) => [f.path, f.kind]))
  assert.deepEqual(kinds, { 'src/a.ts': 'modified', 'src/c.ts': 'created', 'src/b.ts': 'deleted' })
  ok('a modification, a creation and a deletion are each reported as what they are')
  const a = changes.files.find((f) => f.path === 'src/a.ts')!
  assert.ok(a.diff.includes('-export const a = 1') && a.diff.includes('+export const a = 10')); ok('with a unified diff')
  assert.ok(!(await ws.changes()).files.some((f) => f.path.includes('baseline'))); ok('the baseline file itself is never a change')
}

console.log('\napply puts changes into the project, unless the project moved')
{
  // The user edited b.ts in the project while the run was deleting it.
  await writeFile(join(project, 'src', 'b.ts'), 'export const b = 22 // user edit\n')
  const result = await ws.apply()
  assert.deepEqual(result.applied.sort(), ['src/a.ts', 'src/c.ts']); ok('unchanged files are applied')
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0]!.path, 'src/b.ts')
  ok('a file edited in the project since the baseline is a conflict, not a merge')
  assert.match(result.conflicts[0]!.reason, /edited in the project/); ok('and the reason says so')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'export const a = 10\n'); ok('the project has the applied change')
  assert.equal(await readFile(join(project, 'src', 'b.ts'), 'utf8'), 'export const b = 22 // user edit\n'); ok('and the user edit is untouched')
  assert.equal(await readFile(join(project, 'src', 'c.ts'), 'utf8'), 'export const c = 3\n'); ok('and the created file exists')
}

console.log('\nundo reverses an apply, unless the project moved again')
{
  await writeFile(join(project, 'src', 'c.ts'), 'export const c = 3 // touched after apply\n')
  const result = await ws.undo()
  assert.deepEqual(result.applied, ['src/a.ts']); ok('a file still as applied is restored')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'export const a = 1\n'); ok('to what it held before')
  assert.equal(result.conflicts[0]?.path, 'src/c.ts'); ok('a file edited after apply is left alone and reported')
  assert.ok(await stat(join(project, 'src', 'c.ts')).then(() => true, () => false)); ok('so the created file, since edited, stays')
}

console.log('\napply of a created file the project now has is a conflict')
{
  const ws2 = await Workspace.create(project, join(base, 'ws2'))
  await writeFile(join(ws2.root, 'NEW.md'), 'from the run\n')
  await writeFile(join(project, 'NEW.md'), 'from the user\n')
  const result = await ws2.apply()
  assert.equal(result.applied.length, 0); assert.equal(result.conflicts[0]?.path, 'NEW.md')
  ok('the user file is not overwritten')
  await ws2.discard()
  assert.equal(await stat(ws2.root).then(() => true, () => false), false); ok('discard removes the workspace')
}

console.log('\nwhat git lists and what a walk lists is not a change')
{
  // A repository: git names tracked files under a fixture's node_modules and
  // symlinks, which the walk that lists a copy does not. Seen in the app as
  // thirteen deletions in a run that edited nothing.
  const repo = join(base, 'repo')
  await mkdir(join(repo, 'spec', 'fixtures', 'pkg', 'node_modules', 'native'), { recursive: true })
  await mkdir(join(repo, 'docs'))
  await writeFile(join(repo, 'README.md'), '# r\n')
  await writeFile(join(repo, 'spec', 'fixtures', 'pkg', 'node_modules', 'native', 'main.js'), 'native\n')
  await symlink('../README.md', join(repo, 'docs', 'contributing.md'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git('init', '-q'); git('add', '-A')
  const ws4 = await Workspace.create(repo, join(base, 'ws4'))
  assert.ok('spec/fixtures/pkg/node_modules/native/main.js' in ws4.manifest.files && 'docs/contributing.md' in ws4.manifest.files); ok('git lists a tracked fixture under node_modules and a symlink, so the baseline holds both')
  assert.deepEqual((await ws4.changes()).files, []); ok('and neither is a change until something changes')
  await rm(join(ws4.root, 'spec', 'fixtures', 'pkg', 'node_modules', 'native', 'main.js'))
  await writeFile(join(ws4.root, 'README.md'), '# changed\n')
  const kinds = Object.fromEntries((await ws4.changes()).files.map((f) => [f.path, f.kind]))
  assert.deepEqual(kinds, { 'README.md': 'modified', 'spec/fixtures/pkg/node_modules/native/main.js': 'deleted' })
  ok('a fixture file the run removes is a deletion, and the symlink whose target changed is not reported twice')
}

console.log('\napply and undo never write through a symlink in the project')
{
  // The copy skips a symlinked folder, so a run can create docs/new.md in a
  // plain docs/ there; in the project, docs/ is a link. Reproduced in #69.
  const linked = join(base, 'linked')
  const outside = join(base, 'outside')
  await mkdir(join(linked, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(linked, 'src', 'a.ts'), 'a\n')
  await symlink(outside, join(linked, 'docs'))
  await symlink(join(linked, 'src'), join(linked, 'alias'))
  const ws5 = await Workspace.create(linked, join(base, 'ws5'))
  await mkdir(join(ws5.root, 'docs')); await writeFile(join(ws5.root, 'docs', 'new.md'), 'from the run\n')
  await mkdir(join(ws5.root, 'alias')); await writeFile(join(ws5.root, 'alias', 'b.ts'), 'from the run\n')
  await writeFile(join(ws5.root, 'src', 'a.ts'), 'a, changed\n')
  const result = await ws5.apply()
  assert.deepEqual(result.applied, ['src/a.ts']); ok('a change at a plain path is applied')
  assert.equal(await stat(join(outside, 'new.md')).then(() => true, () => false), false); ok('nothing is created where a link out of the project points')
  assert.equal(await stat(join(linked, 'src', 'b.ts')).then(() => true, () => false), false); ok('nor where a link inside the project points')
  const reasons = Object.fromEntries(result.conflicts.map((c) => [c.path, c.reason]))
  assert.deepEqual(Object.keys(reasons).sort(), ['alias/b.ts', 'docs/new.md']); ok('both are listed as conflicts')
  assert.match(reasons['docs/new.md']!, /^docs is a symlink/); ok('naming the link')

  // A folder swapped for a link after apply: undo must not follow it either.
  await rm(join(linked, 'src'), { recursive: true })
  await mkdir(join(outside, 'src')); await writeFile(join(outside, 'src', 'a.ts'), 'a, changed\n')
  await symlink(join(outside, 'src'), join(linked, 'src'))
  const undone = await ws5.undo()
  assert.deepEqual(undone.applied, []); assert.equal(undone.conflicts[0]?.path, 'src/a.ts'); ok('undo through a link is a conflict')
  assert.equal(await readFile(join(outside, 'src', 'a.ts'), 'utf8'), 'a, changed\n'); ok('and the file it points at is untouched')
}

console.log('\na symlink in the copy is never followed')
{
  // A command in the box swaps a tracked file for a link to a host file the
  // box cannot see. Reproduced in #71: the secret showed in the diff.
  const host = join(base, 'host')
  await mkdir(host)
  await writeFile(join(host, 'id_ed25519'), 'SECRET KEY\n')
  const plain = join(base, 'plain')
  await mkdir(plain)
  await writeFile(join(plain, 'z.txt'), 'z\n')
  const ws6 = await Workspace.create(plain, join(base, 'ws6'))
  await rm(join(ws6.root, 'z.txt'))
  await symlink(join(host, 'id_ed25519'), join(ws6.root, 'z.txt'))
  await symlink(join(host, 'id_ed25519'), join(ws6.root, 'key.txt'))
  const changes = await ws6.changes()
  const kinds = Object.fromEntries(changes.files.map((f) => [f.path, f.kind]))
  assert.deepEqual(kinds, { 'z.txt': 'symlink', 'key.txt': 'symlink' }); ok('a file swapped for a link, and a new link, are each a symlink change')
  assert.ok(!JSON.stringify(changes).includes('SECRET')); ok('and nothing they point at is read into Changes')
  assert.equal(changes.files.find((f) => f.path === 'z.txt')!.diff, `symlink → ${join(host, 'id_ed25519')}`); ok('only the link text is shown')
  const result = await ws6.apply()
  assert.deepEqual(result.applied, []); assert.equal(result.conflicts.length, 2); ok('neither can be applied')
  assert.match(result.conflicts[0]!.reason, /never applied/); ok('and the reason says why')
  assert.equal(await readFile(join(plain, 'z.txt'), 'utf8'), 'z\n'); ok('the project file is untouched')
  assert.equal(await stat(join(plain, 'key.txt')).then(() => true, () => false), false); ok('and no link is made in the project')
}

console.log('\nundo restores the original bytes, not a text reading of them')
{
  // Reproduced in #72: ff fe came back as two replacement characters.
  const bin = join(base, 'bin')
  await mkdir(bin)
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x01])
  await writeFile(join(bin, 'blob.dat'), original)
  const ws7 = await Workspace.create(bin, join(base, 'ws7'))
  await writeFile(join(ws7.root, 'blob.dat'), Buffer.from([0x00, 0x01, 0x02]))
  assert.deepEqual((await ws7.apply()).applied, ['blob.dat']); ok('a binary change is applied')
  assert.deepEqual((await ws7.undo()).applied, ['blob.dat']); ok('and undone')
  assert.ok((await readFile(join(bin, 'blob.dat'))).equals(original)); ok('to exactly the bytes it held')
}

console.log('\na file that cannot be written partway through is a conflict, and the rest can still be undone')
{
  // Reproduced in #70: one failure left earlier files applied with no undo record.
  const part = join(base, 'part')
  await mkdir(part)
  for (const f of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(part, f), `${f} before\n`)
  const ws8 = await Workspace.create(part, join(base, 'ws8'))
  for (const f of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(ws8.root, f), `${f} after\n`)
  await chmod(join(part, 'b.txt'), 0o444)
  const result = await ws8.apply()
  assert.deepEqual(result.applied, ['a.txt', 'c.txt']); ok('the files around the failure are applied')
  assert.equal(result.conflicts[0]?.path, 'b.txt'); assert.match(result.conflicts[0]!.reason, /could not be applied: .*EACCES/); ok('the failure is returned as a conflict with its reason, not thrown')
  assert.equal(await readFile(join(part, 'b.txt'), 'utf8'), 'b.txt before\n'); ok('and the file that failed is as it was')
  const undone = await ws8.undo()
  assert.deepEqual(undone.applied.sort(), ['a.txt', 'c.txt']); assert.deepEqual(undone.conflicts, []); ok('undo covers what was applied')
  for (const f of ['a.txt', 'c.txt']) assert.equal(await readFile(join(part, f), 'utf8'), `${f} before\n`)
  ok('and restores it')
  await chmod(join(part, 'b.txt'), 0o644)
}

console.log('\nan undo record from before 0.9.21 still undoes')
{
  const old = join(base, 'old')
  await mkdir(old)
  await writeFile(join(old, 'x.txt'), 'x before\n')
  const ws9 = await Workspace.create(old, join(base, 'ws9'))
  await writeFile(join(old, 'x.txt'), 'x after\n')
  await mkdir(join(ws9.root, '.lowerbeam-undo'))
  const { createHash } = await import('node:crypto')
  const appliedHash = createHash('sha256').update('x after\n').digest('hex')
  await writeFile(join(ws9.root, '.lowerbeam-undo', 'record.json'), JSON.stringify({ at: 1, entries: { 'x.txt': { before: 'x before\n', appliedHash } } }))
  assert.deepEqual((await ws9.undo()).applied, ['x.txt']); ok('the old shape is read')
  assert.equal(await readFile(join(old, 'x.txt'), 'utf8'), 'x before\n'); ok('and the text it kept is restored')
}

console.log('\nan old record whose text is not the original\u2019s bytes is reported, not written')
{
  // #98: a binary original kept as text by a version before 0.9.21.
  const legacy = join(base, 'legacy')
  await mkdir(legacy)
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x01])
  await writeFile(join(legacy, 'blob.dat'), original)
  const ws10 = await Workspace.create(legacy, join(base, 'ws10'))
  await writeFile(join(legacy, 'blob.dat'), 'applied\n')
  await mkdir(join(ws10.root, '.lowerbeam-undo'))
  const { createHash } = await import('node:crypto')
  const appliedHash = createHash('sha256').update('applied\n').digest('hex')
  await writeFile(join(ws10.root, '.lowerbeam-undo', 'record.json'), JSON.stringify({ at: 1, entries: { 'blob.dat': { before: original.toString('utf8'), appliedHash } } }))
  const undone = await ws10.undo()
  assert.deepEqual(undone.applied, []); assert.match(undone.conflicts[0]?.reason ?? '', /before 0\.9\.21.*not the original.s bytes/); ok('it is a conflict that says why')
  assert.equal(await readFile(join(legacy, 'blob.dat'), 'utf8'), 'applied\n'); ok('and the file keeps what it has, not a text reading of the original')
  assert.deepEqual((await readdir(legacy)).sort(), ['blob.dat']); ok('with nothing left beside it')
}

console.log('\na restore that does not match is never put in place')
{
  // #98: the check came after the write, so a mismatch stayed in the project.
  const tampered = join(base, 'tampered')
  await mkdir(tampered)
  await writeFile(join(tampered, 't.txt'), 't before\n')
  const ws11 = await Workspace.create(tampered, join(base, 'ws11'))
  await writeFile(join(ws11.root, 't.txt'), 't after\n')
  assert.deepEqual((await ws11.apply()).applied, ['t.txt'])
  const originals = join(ws11.root, '.lowerbeam-undo', 'originals')
  const [kept] = await readdir(originals)
  await writeFile(join(originals, kept!), 'damaged\n')
  const undone = await ws11.undo()
  assert.deepEqual(undone.applied, []); assert.match(undone.conflicts[0]?.reason ?? '', /does not match the original; the file was left as it is/); ok('a damaged original is a conflict')
  assert.equal(await readFile(join(tampered, 't.txt'), 'utf8'), 't after\n'); ok('and the project still holds what was applied, not the damaged copy')
  assert.deepEqual((await readdir(tampered)).sort(), ['t.txt']); ok('with no staged file left beside it')
}

console.log('\nundo takes away the folders apply made')
{
  // #98: apply made folders with mkdir -p; undo removed the files and left them.
  const tree = join(base, 'tree')
  await mkdir(join(tree, 'src'), { recursive: true })
  await writeFile(join(tree, 'src', 'a.ts'), 'a\n')
  const ws12 = await Workspace.create(tree, join(base, 'ws12'))
  await mkdir(join(ws12.root, 'src', 'deep', 'er'), { recursive: true })
  await mkdir(join(ws12.root, 'docs'), { recursive: true })
  await writeFile(join(ws12.root, 'src', 'deep', 'er', 'new.ts'), 'new\n')
  await writeFile(join(ws12.root, 'src', 'deep', 'side.ts'), 'side\n')
  await writeFile(join(ws12.root, 'docs', 'note.md'), 'note\n')
  assert.deepEqual((await ws12.apply()).applied.sort(), ['docs/note.md', 'src/deep/er/new.ts', 'src/deep/side.ts'])
  await writeFile(join(tree, 'docs', 'mine.md'), 'the person\u2019s own\n')
  const undone = await ws12.undo()
  assert.equal(undone.applied.length, 3); ok('the files are undone')
  assert.equal(await stat(join(tree, 'src', 'deep')).then(() => true, () => false), false); ok('the folders apply made are gone, nested ones included')
  assert.equal(await stat(join(tree, 'src')).then(() => true, () => false), true); ok('a folder that was there before stays')
  assert.equal(await readFile(join(tree, 'docs', 'mine.md'), 'utf8'), 'the person\u2019s own\n'); ok('and one that holds something since is kept, with what it holds')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
