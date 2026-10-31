import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fold, locate, levelNote } from '../../src/agent/match.js'
import { Grant } from '../../src/agent/grant.js'
import { runAgentTool } from '../../src/agent/tools.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}

console.log('each match level')
{
  const file = 'alpha \nbeta\ngamma\n'
  assert.equal(locate(file, 'beta').matches[0]?.level, 1)
  ok('an exact passage is level 1')
  assert.equal(locate(file, 'alpha\nbeta').matches[0]?.level, 2)
  assert.match(levelNote(2), /level 2/)
  ok('trailing space is level 2')
  const indented = '  alpha\n    beta\n'
  assert.equal(locate(indented, 'alpha\nbeta').matches[0]?.level, 3)
  ok('leading space is level 3')
  assert.equal(locate('say \u201Chello\u201D\n', 'say "hello"').matches[0]?.level, 4)
  ok('curly quotes are level 4')
  assert.equal(locate('alpha\nbeta\nalpha\n', 'alpha').matches.length, 2)
  assert.deepEqual(locate('alpha\nbeta\nalpha\n', 'alpha').matches.map((match) => match.line), [1, 3])
  ok('two matches at a loose level stay ambiguous, with their lines')
}

console.log('\nlevel 4 does not fold other characters')
{
  assert.equal(fold('café — “x”'), 'café - "x"')
  assert.equal(locate('colour\n', 'color').matches.length, 0)
  ok('a letter that is not a quote, dash or non-breaking space still misses')
}

console.log('\nCRLF, and the ends of a file')
{
  const crlf = 'alpha\r\nbeta\r\n'
  const mid = locate(crlf, 'beta')
  assert.equal(mid.matches[0]?.line, 2)
  assert.equal(crlf.slice(mid.matches[0]!.start, mid.matches[0]!.end), 'beta')
  ok('a CRLF file matches a line, and the span is the original text')
  assert.equal(locate('alpha\nbeta', 'alpha').matches[0]?.start, 0)
  assert.equal(locate('alpha\nbeta', 'beta').matches[0]?.end, 'alpha\nbeta'.length)
  ok('a match can be the first line or the last')
}

console.log('\nedit_file says which level matched')
{
  const root = await mkdtemp(join(tmpdir(), 'match-'))
  await writeFile(join(root, 'a.ts'), 'const name = \u201Cada\u201D\n')
  const grant = await Grant.open(root, 'edit')
  const edited = await runAgentTool(grant, 'edit_file', { path: 'a.ts', find: 'const name = "ada"', replace: 'const name = "bea"' })
  assert.equal(edited.ok, true)
  assert.match(edited.content, /indentation taken from the file/)
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const name = "bea"\n')
  ok('a curly quote matches, and the file indentation is kept')
  const missing = await runAgentTool(grant, 'edit_file', { path: 'a.ts', find: 'const missing = 1', replace: 'x' })
  assert.match(missing.content, /Not found/)
  assert.match(missing.content, /closest line/)
  ok('a miss still says not found, and names a nearby line')
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
