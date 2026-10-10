import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecks } from '../harness/checks.ts'
import { STORY_TASKS } from '../harness/story-tasks.ts'

let n = 0
const ok = (m: string) => { n++; console.log('  ok', m) }

const repo = process.cwd()
const corpus = join(repo, 'tests/harness/corpora/story')
const fix = STORY_TASKS.find((t) => t.id === 'story-fix-north')
if (!fix?.mutate || !fix.check) throw new Error('story-fix-north lost its check')

console.log('the story corpus')
{
  const ids = STORY_TASKS.map((t) => t.id)
  assert.deepEqual(ids, ['story-locate-exits', 'story-explain-wall', 'story-fix-north']); ok('three tasks, and they are not the default set')
  const source = await readFile(join(corpus, 'engine.c'), 'utf8')
  assert.ok(source.includes(fix.mutate.find)); ok('the north exit is open in the committed file')
  assert.ok(!source.includes(fix.mutate.replace)); ok('the planted wall is not committed')
}

console.log('the fix is checkable without a model')
{
  const dir = await mkdtemp(join(tmpdir(), 'lowerbeam-story-'))
  try {
    await cp(corpus, dir, { recursive: true })
    const passed = await runChecks(dir, repo, fix)
    assert.deepEqual(passed, []); ok('north from the cell prints the hall')

    const engine = join(dir, 'engine.c')
    const broken = (await readFile(engine, 'utf8')).replace(fix.mutate.find, fix.mutate.replace)
    await writeFile(engine, broken)
    const failed = await runChecks(dir, repo, fix)
    assert.ok(failed.some((line) => line.includes('A short hall.'))); ok('with the exit walled off, that check fails')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n${n} assertions passed`)
