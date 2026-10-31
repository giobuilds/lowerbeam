import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { estimateTokens } from '../../src/context/snapshot.js'
import { mapReadReport, renderRepoMap, repoMapCacheStats, resetRepoMapCache, REPO_MAP_TOKENS } from '../../src/agent/repoMap.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}

const base = await mkdtemp(join(tmpdir(), 'repomap-'))
const project = join(base, 'project')
const outside = join(base, 'outside')
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(outside)
await writeFile(join(project, 'src', 'app.ts'), 'export function main() {\n  greet("ada")\n}\n')
await writeFile(join(project, 'src', 'greet.ts'), 'export function greet(name: string) {\n  return name\n}\n')
await writeFile(join(outside, 'secret.ts'), 'export function secret() { return 1 }\n')
await symlink(join(outside, 'secret.ts'), join(project, 'src', 'secret.ts'))

console.log('a map stays inside the budget, the grant and the cache')
{
  resetRepoMapCache()
  const grant = await Grant.open(project)
  const map = await renderRepoMap(grant, { focus: 'greet', budget: REPO_MAP_TOKENS })
  assert.ok(estimateTokens(map) <= REPO_MAP_TOKENS)
  ok('the map is within the token budget')
  assert.ok(!map.includes('secret'))
  ok('a file outside the grant is not listed')
  assert.ok(map.indexOf('greet.ts') < map.indexOf('app.ts'))
  ok('a file the focus names is ranked ahead of one that only calls it')
  const before = repoMapCacheStats().parses
  await renderRepoMap(grant, { focus: 'greet' })
  assert.equal(repoMapCacheStats().parses, before)
  assert.ok(repoMapCacheStats().hits >= 2)
  ok('an unchanged file is not parsed again')
}

console.log('\nwhat a harness comparison reports')
{
  const report = mapReadReport([
    { id: 'locate-context-per-slot', withMap: 1, withoutMap: 3 },
    { id: 'explain-reader-no-preload', withMap: 2, withoutMap: 2 }
  ])
  assert.match(report, /locate-context-per-slot: 1 with the map, 3 without/)
  assert.match(report, /total: 3 with the map, 5 without/)
  ok('whole-file reads are reported with the map and without it')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
