import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runAgentTool, readBudgetBytes } from '../../src/agent/tools.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// A project, a file outside it, and every route a model might take from one
// to the other.
const base = await mkdtemp(join(tmpdir(), 'grant-'))
const project = join(base, 'project')
const outside = join(base, 'outside')
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(outside)
await writeFile(join(project, 'src', 'a.ts'), 'export const answer = 42\n// the comment that explains it\n')
await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
await writeFile(join(outside, 'secret.txt'), 'CANARY-deadbeef\n')
await symlink(join(outside, 'secret.txt'), join(project, 'src', 'escape.txt'))
await symlink(outside, join(project, 'src', 'escape-dir'))
await writeFile(join(project, 'src', 'big.bin'), Buffer.from([0, 1, 2, 3, 0, 0, 255]))

const grant = await Grant.open(project)

console.log('what is inside')
{
  const r = await grant.resolve('src/a.ts')
  assert.ok(r.ok && r.relative === 'src/a.ts'); ok('a relative path inside the project resolves')
  const abs = await grant.resolve(join(project, 'src', 'a.ts'))
  assert.ok(abs.ok); ok('so does an absolute path that lands inside')
  const dot = await grant.resolve('.')
  assert.ok(dot.ok && dot.relative === '.'); ok('and the root itself')
}

console.log('\nevery way out')
{
  const up = await grant.resolve('../outside/secret.txt')
  assert.ok(!up.ok && up.denied); ok('.. traversal is refused, and counted as a denial')
  const abs = await grant.resolve(join(outside, 'secret.txt'))
  assert.ok(!abs.ok && abs.denied); ok('an absolute path elsewhere is refused')
  const link = await grant.resolve('src/escape.txt')
  assert.ok(!link.ok && link.denied); ok('a symlink to a file outside is refused, whatever its name')
  const dir = await grant.resolve('src/escape-dir/secret.txt')
  assert.ok(!dir.ok && dir.denied); ok('and so is a path through a symlinked directory')
  const git = await grant.resolve('.git/HEAD')
  assert.ok(!git.ok && git.denied); ok('repository control files are outside the normal grant')
  const dep = await grant.resolve('node_modules/dep/index.js')
  assert.ok(!dep.ok && dep.denied); ok('as is the dependency tree')
  const missing = await grant.resolve('src/nope.ts')
  assert.ok(!missing.ok && !missing.denied); ok('a path that does not exist is not-found, not denied')
}

console.log('\nthe tools respect it')
{
  const read = await runAgentTool(grant, 'read', { path: 'src/escape.txt' })
  assert.equal(read.ok, false); assert.equal(read.denied, true); ok('read refuses the escape')
  assert.ok(!read.content.includes('CANARY')); ok('and the canary never reaches the content')

  const list = await runAgentTool(grant, 'list_files', { path: '.' })
  assert.ok(list.ok && !list.content.includes('node_modules') && !list.content.includes('.git'))
  ok('list hides what the grant excludes')

  const search = await runAgentTool(grant, 'search', { query: 'CANARY' })
  assert.ok(search.ok && search.content.includes('No lines contain')); ok('search cannot find outside the project')
  const found = await runAgentTool(grant, 'search', { query: 'comment that explains' })
  assert.ok(found.ok && found.content.includes('src/a.ts:2')); ok('but finds what is inside, with path:line')

  const bin = await runAgentTool(grant, 'read', { path: 'src/big.bin' })
  assert.equal(bin.ok, false); ok('a binary file is refused rather than dumped')

  const unknown = await runAgentTool(grant, 'delete_everything', {})
  assert.equal(unknown.ok, false); assert.ok(!unknown.denied); ok('an unknown tool fails closed')
}

console.log('\nreads are bounded')
{
  await writeFile(join(project, 'src', 'long.txt'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'))
  const first = await runAgentTool(grant, 'read', { path: 'src/long.txt' })
  assert.ok(first.ok && first.content.includes('200| line 200') && !first.content.includes('line 201'))
  ok('a long file comes back 200 lines at a time')
  assert.ok(first.content.includes('read from 201')); ok('and says where to continue')
  const later = await runAgentTool(grant, 'read', { path: 'src/long.txt', start: 480 })
  assert.ok(later.ok && later.content.includes('500| line 500')); ok('a start line reads further in')
}

console.log('\na read takes at most a third of the window')
{
  assert.equal(readBudgetBytes(16384), 16 * 1024); ok('at the full window, the 16 KB it has always been')
  assert.equal(readBudgetBytes(null), 16 * 1024); ok('and when the window is unknown, the same')
  assert.equal(readBudgetBytes(6144), 6144); ok('a 6k window gives a 6 KB read')
  assert.equal(readBudgetBytes(1024), 4 * 1024); ok('with a floor, since a read too small is not worth making')
  assert.equal(readBudgetBytes(65536), 16 * 1024); ok('and a ceiling, since a huge window is not a reason to return a whole file')

  // Dense lines, so the byte cap binds before the 200-line one.
  const dense = Array.from({ length: 400 }, (_, i) => `const value${i} = ${'x'.repeat(60)}`).join('\n')
  await writeFile(join(project, 'src', 'dense.ts'), dense)
  const full = await runAgentTool(grant, 'read', { path: 'src/dense.ts' })
  const small = await runAgentTool(grant, 'read', { path: 'src/dense.ts' }, { contextLimit: 6144 })
  const lines = (r: { content: string }): number => r.content.split('\n').filter((l) => /^\s*\d+\|/.test(l)).length
  assert.ok(lines(full) > lines(small)); ok(`a smaller window returns fewer lines (${lines(full)} against ${lines(small)})`)
  assert.ok(small.content.includes('not shown; read from')); ok('and still says where to read on from')
  // The line cap is independent of the window, which is what keeps the
  // planted READ_MAX_LINES bug detectable in a small window too.
  const short = await runAgentTool(grant, 'read', { path: 'src/long.txt' }, { contextLimit: 6144 })
  assert.ok(short.content.includes('200| line 200')); assert.ok(!short.content.includes('201| line 201'))
  ok('short lines still come 200 at a time, whatever the window')
}

console.log('\nsearch takes a file as well as a directory')
{
  const inFile = await runAgentTool(grant, 'search', { query: 'line 5', path: 'src/long.txt' })
  assert.equal(inFile.ok, true); assert.match(inFile.content, /src\/long\.txt:5:/); ok('a search restricted to one file searches that file')
  const none = await runAgentTool(grant, 'search', { query: 'zzz-not-here', path: 'src/long.txt' })
  assert.match(none.content, /No lines contain "zzz-not-here" in src\/long\.txt/); ok('and an empty result names the file it searched')
  const missing = await runAgentTool(grant, 'search', { query: 'x', path: 'src/nope.ts' })
  assert.equal(missing.ok, false); ok('a path that does not exist is an error, not an empty result')
}

console.log('\na folder the grant also names is readable, never written, and only that folder')
{
  const also = join(base, 'also')
  await mkdir(join(also, 'lib'), { recursive: true })
  await mkdir(join(also, 'node_modules'))
  await writeFile(join(also, 'lib', 'shared.ts'), 'export const shared = 1\n')
  await writeFile(join(also, 'node_modules', 'x.js'), '')
  const wide = await Grant.open(project, 'edit', [also])
  const r = await wide.resolve(join(also, 'lib', 'shared.ts'))
  assert.ok(r.ok && r.path === join(also, 'lib', 'shared.ts') && r.relative === join(also, 'lib', 'shared.ts')); ok('a file in the extra root resolves, and is named by its full path')
  const viaLink = await wide.resolve('src/escape-dir/../lib/shared.ts')
  assert.ok(!viaLink.ok); ok('a route through a link to somewhere else is still refused: the extra root is the folder named, not a way out')
  const w = await wide.resolveForWrite(join(also, 'lib', 'shared.ts'))
  assert.ok(!w.ok && w.denied); ok('and nothing in it can be written, whatever the mode')
  const deps = await wide.resolve(join(also, 'node_modules', 'x.js'))
  assert.ok(!deps.ok && deps.denied && deps.reason.includes('node_modules')); ok('the excluded names apply at its top level too, as at the project\u2019s')
  const other = await wide.resolve(join(outside, 'secret.txt'))
  assert.ok(!other.ok && other.denied && other.reason.includes('folders the grant names')); ok('anywhere else is refused as before, and the refusal says the grant has named folders')
  const listed = await runAgentTool(wide, 'search', { query: 'shared', path: join(also, 'lib') })
  assert.ok(listed.ok && listed.content.includes(join(also, 'lib', 'shared.ts'))); ok('search in it names hits by their full path, so the model can read them back')
  assert.equal(wide.nameFor(join(project, 'src', 'a.ts')), join('src', 'a.ts')); assert.equal(wide.nameFor(join(also, 'x')), join(also, 'x')); ok('inside the project a path is still relative')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
