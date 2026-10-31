import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runAgentTool } from '../../src/agent/tools.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const base = await mkdtemp(join(tmpdir(), 'write-'))
const project = join(base, 'project')
const outside = join(base, 'outside')
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(outside)
await writeFile(join(project, 'src', 'a.ts'), 'const x = 1\nconst y = 2\nconst x2 = 1\n')
await writeFile(join(outside, 'target.txt'), 'must not change\n')
await symlink(join(outside, 'target.txt'), join(project, 'src', 'link.txt'))

console.log('read-only runs cannot write at all')
{
  const inspect = await Grant.open(project)
  const r = await runAgentTool(inspect, 'edit_file', { path: 'src/a.ts', find: 'const y = 2', replace: 'const y = 3' })
  assert.equal(r.ok, false); assert.equal(r.denied, true); ok('edit_file is refused in inspect mode')
  const w = await runAgentTool(inspect, 'write_file', { path: 'src/new.ts', content: 'x' })
  assert.equal(w.ok, false); assert.equal(w.denied, true); ok('so is write_file')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'const x = 1\nconst y = 2\nconst x2 = 1\n'); ok('and nothing changed')
}

const edit = await Grant.open(project, 'edit')

console.log('\nedit_file must match exactly once')
{
  const amb = await runAgentTool(edit, 'edit_file', { path: 'src/a.ts', find: 'const x', replace: 'const z' })
  assert.equal(amb.ok, false); assert.match(amb.content, /more than once/); ok('an ambiguous passage is refused, with the reason')
  const miss = await runAgentTool(edit, 'edit_file', { path: 'src/a.ts', find: 'const q = 9', replace: 'const q = 10' })
  assert.equal(miss.ok, false); assert.match(miss.content, /Not found/); ok('a passage that is not there is refused')
  const good = await runAgentTool(edit, 'edit_file', { path: 'src/a.ts', find: 'const y = 2', replace: 'const y = 3' })
  assert.equal(good.ok, true); assert.match(good.content, /line 2/); ok('a unique passage is replaced, and the line is reported')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'const x = 1\nconst y = 3\nconst x2 = 1\n'); ok('exactly that passage changed')
}

console.log('\nedit_file tolerates the indentation a model cannot see')
{
  await writeFile(join(project, 'src', 'ind.ts'), 'function f() {\n  const a = 1\n  return a\n}\n')
  // Copied out of numbered output: a stray space at the start of every line.
  const stray = await runAgentTool(edit, 'edit_file', { path: 'src/ind.ts', find: '   const a = 1\n   return a', replace: '   const a = 2\n   return a' })
  assert.equal(stray.ok, true); assert.match(stray.content, /indentation taken from the file/)
  ok('a uniform extra space on every line still matches, and says the file indentation was used')
  assert.equal(await readFile(join(project, 'src', 'ind.ts'), 'utf8'), 'function f() {\n  const a = 2\n  return a\n}\n')
  ok('the file keeps its own indentation, not the stray space')

  await writeFile(join(project, 'src', 'ind.ts'), 'function f() {\n  const a = 1\n  return a\n}\nfunction g() {\n  const a = 1\n  return a\n}\n')
  const amb = await runAgentTool(edit, 'edit_file', { path: 'src/ind.ts', find: 'const a = 1\nreturn a', replace: 'x' })
  assert.equal(amb.ok, false); assert.match(amb.content, /more than once/); ok('tolerant matching still has to be unique')
  const none = await runAgentTool(edit, 'edit_file', { path: 'src/ind.ts', find: 'const b = 1', replace: 'x' })
  assert.equal(none.ok, false); assert.match(none.content, /Not found/); ok('and still fails when the words are not there')
  // A different *relative* indentation is not a uniform offset: matching it
  // would mean inventing indentation for the replacement. That is refused,
  // and the model is told to copy the passage as it is.
  const nested = await runAgentTool(edit, 'edit_file', { path: 'src/ind.ts', find: 'function g() {\n    const a = 1', replace: 'function g() {\n    const a = 9' })
  assert.equal(nested.ok, false); assert.match(nested.content, /Found in src\/ind\.ts at line \d+, but the relative indentation differs/)
  ok('a block whose inner indentation differs says where it was found, not that it is missing')

  await writeFile(join(project, 'src', 'quote.ts'), '  const name = "hi"\n')
  const curly = await runAgentTool(edit, 'edit_file', { path: 'src/quote.ts', find: '    const name = \u201Chi\u201D', replace: '    const name = "yo"' })
  assert.equal(curly.ok, true); assert.match(curly.content, /indentation taken from the file/)
  assert.equal(await readFile(join(project, 'src', 'quote.ts'), 'utf8'), '  const name = "yo"\n')
  ok('a curly quote with a uniform indent offset keeps the file indentation')
  await writeFile(join(project, 'src', 'quote.ts'), 'function g() {\n  const a = "x"\n    return a\n}\n')
  const uneven = await runAgentTool(edit, 'edit_file', { path: 'src/quote.ts', find: 'function g() {\n    const a = \u201Cx\u201D', replace: 'function g() {\n    const a = "z"' })
  assert.equal(uneven.ok, false); assert.match(uneven.content, /relative indentation differs/)
  ok('a curly quote whose relative indentation differs is refused the same way')
}

console.log('\nwrite_file needs the hash to overwrite')
{
  const create = await runAgentTool(edit, 'write_file', { path: 'src/new.ts', content: 'export {}\n' })
  assert.equal(create.ok, true); assert.match(create.content, /Created/); ok('a new file is created')
  const nested = await runAgentTool(edit, 'write_file', { path: 'src/deep/er/f.ts', content: '1' })
  assert.equal(nested.ok, true); ok('parents are created as needed')
  const blind = await runAgentTool(edit, 'write_file', { path: 'src/a.ts', content: 'gone' })
  assert.equal(blind.ok, false); assert.match(blind.content, /already exists/); ok('overwriting without a hash is refused')
  const read = await runAgentTool(edit, 'read', { path: 'src/a.ts' })
  const hash = /sha256 ([a-f0-9]+)/.exec(read.content)![1]!
  const stale = await runAgentTool(edit, 'write_file', { path: 'src/a.ts', content: 'gone', expected_sha256: 'deadbeef' })
  assert.equal(stale.ok, false); assert.match(stale.content, /changed since/); ok('a wrong hash is refused as a stale write')
  const fresh = await runAgentTool(edit, 'write_file', { path: 'src/a.ts', content: 'rewritten\n', expected_sha256: hash })
  assert.equal(fresh.ok, true); assert.match(fresh.content, /Overwrote/); ok('the hash from read allows the overwrite')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'rewritten\n'); ok('and it took')
}

console.log('\nwrites cannot leave the project either')
{
  const link = await runAgentTool(edit, 'edit_file', { path: 'src/link.txt', find: 'must', replace: 'did' })
  assert.equal(link.ok, false); assert.equal(link.denied, true); ok('editing through a symlink out is refused')
  const up = await runAgentTool(edit, 'write_file', { path: '../outside/other.txt', content: 'x' })
  assert.equal(up.ok, false); assert.equal(up.denied, true); ok('so is writing above the root')
  const git = await runAgentTool(edit, 'write_file', { path: '.git/config', content: 'x' })
  assert.equal(git.ok, false); ok('and writing into .git')
  assert.equal(await readFile(join(outside, 'target.txt'), 'utf8'), 'must not change\n'); ok('the file outside is exactly as it was')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
