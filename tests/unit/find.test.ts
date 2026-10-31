import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant } from '../../src/agent/grant.js'
import { runAgentTool } from '../../src/agent/tools.js'
import { toolsForRun } from '../../src/agent/loop.js'
import {
  FIND_TOOL,
  chunkSource,
  cosine,
  embedTexts,
  findInGrant,
  rankChunks,
  vectorsInOrder
} from '../../src/agent/find.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}

console.log('spans and ranking')
{
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  const chunks = chunkSource('src/a.ts', lines.join('\n'))
  assert.deepEqual(chunks.map((c) => c.line), [1, 33, 65]); ok('a long file is spans of forty lines, stepping by thirty-two')
  assert.equal(chunks[0]!.text.split('\n').length, 40); ok('the first span is forty lines')
  assert.ok(chunks[0]!.text.includes('line 33') && chunks[1]!.text.startsWith('line 33')); ok('the next span repeats the last eight lines')
  assert.ok(chunks[2]!.text.startsWith('line 65') && chunks[2]!.text.endsWith('line 100')); ok('the last span runs to the end of the file')
  assert.deepEqual(chunkSource('a.ts', 'one\ntwo'), [{ path: 'a.ts', line: 1, text: 'one\ntwo' }]); ok('a short file is one span')
  assert.deepEqual(chunkSource('a.ts', ''), []); assert.deepEqual(chunkSource('a.ts', '\n\n'), []); ok('empty text is no span')
  assert.equal(chunkSource('a.ts', '\n\nkept\n').at(0)?.line, 3); ok('the line number is the first line that says something')

  assert.equal(cosine([1, 0], [1, 0]), 1); ok('a vector matches itself')
  assert.equal(cosine([1, 0], [0, 1]), 0); ok('an unrelated vector does not')
  assert.ok(cosine([1, 0], [-1, 0]) < 0); ok('an opposite vector ranks below no match')
  assert.equal(cosine([0, 0], [1, 0]), 0); ok('a zero vector is no match')
  const ranked = rankChunks(
    [1, 0],
    [
      { path: 'b.ts', line: 1, vector: [0, 1] },
      { path: 'a.ts', line: 8, vector: [1, 0] },
      { path: 'a.ts', line: 2, vector: [1, 0] },
      { path: 'c.ts', line: 1, vector: [0.2, 0.9] }
    ],
    2
  )
  assert.deepEqual(ranked.map((item) => `${item.path}:${item.line}`), ['a.ts:2', 'a.ts:8']); ok('the closest spans come first, and a draw keeps path then line')
  assert.equal(vectorsInOrder([{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], 2)?.[0]?.[0], 1); ok('embeddings come back in input order')
  assert.equal(vectorsInOrder([{ index: 0, embedding: [] }], 1), null); ok('an empty vector is refused')
  assert.equal(vectorsInOrder([{ index: 0, embedding: [1] }], 2), null); ok('a short reply is refused')
}

console.log('\nthe request')
{
  const previous = globalThis.fetch
  try {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), 'http://127.0.0.1:9/v1/embeddings')
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
      assert.deepEqual(body, { model: 'bge', input: ['a', 'b'] })
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.authorization, 'Bearer k')
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 })
    }) as typeof fetch
    const vectors = await embedTexts({ baseUrl: 'http://127.0.0.1:9/', apiKey: 'k', model: 'bge', input: ['a', 'b'] })
    assert.deepEqual(vectors, [[1, 0], [0, 1]]); ok('the client posts the model and the text, and sorts the reply by index')
  } finally {
    globalThis.fetch = previous
  }
}

console.log('\nwhat a run is offered')
{
  const inspect = toolsForRun('inspect', false, null).map((tool) => tool.name)
  assert.deepEqual(inspect, ['list_files', 'search', 'read', 'repo_map']); ok('without an embedding model, inspect is list, search, read and a repo map')
  assert.deepEqual(toolsForRun('inspect', false, 'bge').map((tool) => tool.name), ['list_files', 'search', 'read', 'repo_map', 'find']); ok('with one, find is added and search is unchanged')
  assert.ok(!toolsForRun('edit', false, null).some((tool) => tool.name === 'find')); ok('an edit run without one does not grow a tool')
  assert.ok(FIND_TOOL.description.includes('path:line') && FIND_TOOL.description.includes('this project')); ok('find says it returns excerpts from this project')
}

console.log('\nthe project, and nothing else')
{
  const base = await mkdtemp(join(tmpdir(), 'find-'))
  const project = join(base, 'project')
  const outside = join(base, 'outside')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(outside)
  const clock = join(project, 'src', 'clock.ts')
  await writeFile(clock, "export const clock = 'the mantel clock'\nNOT_IN_EXCERPT_zz\n")
  await writeFile(join(project, 'src', 'other.ts'), "export const bowl = 'unrelated pottery'\n")
  await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'DEP_ONLY_TOKEN\n')
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(project, '.env'), 'ENV_TOKEN=1\n')
  await writeFile(join(outside, 'secret.txt'), 'CANARY-deadbeef\n')
  await symlink(join(outside, 'secret.txt'), join(project, 'src', 'escape.txt'))
  await writeFile(join(project, 'src', 'skip.bin'), Buffer.from('BIN_TOKEN\0rest'))
  await writeFile(join(project, 'src', 'huge.txt'), 'BIG_TOKEN\n' + 'x'.repeat(512 * 1024))
  const grant = await Grant.open(project)

  const closed = await runAgentTool(grant, 'find', { query: 'clock' })
  assert.equal(closed.ok, false); assert.match(closed.content, /no tool called find/i); ok('the ordinary tool switch still has no find, so a measured run cannot call it')

  const seen: string[] = []
  const embed = async (input: string[]): Promise<number[][]> => {
    seen.push(...input)
    return input.map((text) => (text.toLowerCase().includes('clock') || text.toLowerCase().includes('timepiece') ? [1, 0] : [0, 1]))
  }
  const ask = (query: string) => findInGrant({ grant, query, baseUrl: 'http://127.0.0.1:9', apiKey: null, model: 'bge', embed })

  const empty = await ask('   ')
  assert.equal(empty.ok, false); ok('an empty description is refused')
  const noModel = await findInGrant({ grant, query: 'clock', baseUrl: 'http://127.0.0.1:9', apiKey: null, model: '  ', embed })
  assert.equal(noModel.ok, false); assert.match(noModel.content, /no embedding model/i); ok('no embedding model fails closed')

  const found = await ask('a timepiece')
  assert.equal(found.ok, true)
  const hits = found.content.split('\n')
  assert.ok(hits[0]!.startsWith('src/clock.ts:1: ')); ok('the closest file is named with its line')
  assert.ok(hits[0]!.includes('mantel clock')); ok('the hit is an excerpt')
  assert.ok(!found.content.includes('NOT_IN_EXCERPT_zz')); ok('the rest of the file is not returned')
  const otherAt = hits.findIndex((line) => line.startsWith('src/other.ts:'))
  const clockAt = hits.findIndex((line) => line.startsWith('src/clock.ts:'))
  assert.ok(clockAt >= 0 && otherAt > clockAt); ok('a weaker span comes after')
  for (const hidden of ['CANARY', 'DEP_ONLY_TOKEN', 'ENV_TOKEN', 'BIN_TOKEN', 'BIG_TOKEN', 'refs/heads']) {
    assert.ok(!found.content.includes(hidden), hidden)
  }
  ok('links out, dependencies, git, secrets, binaries and oversized files are not indexed')

  seen.length = 0
  await ask('a timepiece')
  assert.deepEqual(seen, ['a timepiece']); ok('a file that has not changed is not embedded again')

  await writeFile(clock, "export const clock = 'the mantel clock'\nNOT_IN_EXCERPT_zz\nexport const extra = 1\n")
  seen.length = 0
  await ask('a timepiece')
  assert.ok(seen.some((text) => text.includes('mantel clock'))); ok('a file that changed is embedded again')

  const failed = await findInGrant({
    grant,
    query: 'a timepiece',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: null,
    model: 'bge',
    embed: async () => {
      throw new Error('embeddings down')
    }
  })
  assert.equal(failed.ok, false); assert.match(failed.content, /embeddings down/); ok('a failed embedding model is reported, and nothing is guessed')

  await rm(base, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
