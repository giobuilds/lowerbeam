import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Grant, secretReason } from '../../src/agent/grant.js'
import { runAgentTool } from '../../src/agent/tools.js'
import { checkProjectRoot } from '../../src/main/coding/supervisor.js'
import { Workspace } from '../../src/main/coding/workspace.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// Reproduced in #73: the home folder could be the project, and a run read
// .ssh/id_ed25519 from it; inside any project, .env was readable and copied.
const base = await mkdtemp(join(tmpdir(), 'credentials-'))
const own = join(base, 'userData')
const project = join(base, 'project')
await mkdir(own)
const put = async (rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(project, rel)), { recursive: true })
  await writeFile(join(project, rel), text)
}
await put('src/a.ts', 'export const needle = 1\n')
await put('.ssh/id_ed25519', 'needle PRIVATE KEY\n')
await put('.env', 'TOKEN=needle\n')
await put('sub/.env.local', 'TOKEN=needle\n')
await put('config/.aws/credentials', 'needle\n')
await put('.env.example', 'TOKEN=needle-goes-here\n')

console.log('a project folder too broad to grant is refused')
{
  await assert.rejects(checkProjectRoot('/', own), /cannot be the whole filesystem/); ok('the filesystem')
  await assert.rejects(checkProjectRoot(homedir(), own), /cannot be the whole home directory/); ok('the home directory')
  await assert.rejects(checkProjectRoot(dirname(homedir()), own), /which holds the home directory/); ok('a folder above it')
  await assert.rejects(checkProjectRoot(own, own), /own state lives there/); ok('Lowerbeam’s own state')
  await assert.rejects(checkProjectRoot(base, own), /own state lives there/); ok('a folder holding it')
  await mkdir(join(own, 'inside'))
  await assert.rejects(checkProjectRoot(join(own, 'inside'), own), /own state lives there/); ok('a folder inside it')
  await assert.rejects(checkProjectRoot(join(project, '.ssh'), own), /folder of credentials/); ok('a folder of credentials')
  await assert.rejects(checkProjectRoot(join(base, 'missing'), own), /does not exist/); ok('a folder that is not there')
  await assert.rejects(checkProjectRoot(join(project, '.env'), own), /not a folder/); ok('a file')
  await checkProjectRoot(project, own); ok('an ordinary project is accepted')
}

console.log('\ncredentials inside a project are not part of the grant')
{
  const grant = await Grant.open(project)
  for (const path of ['.ssh/id_ed25519', '.env', 'sub/.env.local', 'config/.aws/credentials', join(project, '.env')]) {
    const r = await runAgentTool(grant, 'read', { path })
    assert.ok(!r.ok && !r.content.includes('needle'), path)
  }
  ok('read refuses keys and .env files at any depth, by any spelling')
  const r = await runAgentTool(grant, 'read', { path: '.ssh/id_ed25519' })
  assert.match(r.content, /\.ssh holds credentials/); ok('and says why')
  assert.match((await runAgentTool(grant, 'read', { path: '.env.example' })).content, /needle-goes-here/); ok('a .env template is readable')
  const list = await runAgentTool(grant, 'list_files', { path: '.' })
  assert.ok(list.ok && !/\.ssh|\.env\n|\.env$/m.test(list.content) && list.content.includes('.env.example')); ok('list leaves them out')
  const search = await runAgentTool(grant, 'search', { query: 'needle' })
  const hits = search.content.split('\n').map((l) => l.split(':')[0]).sort()
  assert.deepEqual(hits, ['.env.example', 'src/a.ts']); ok('search never looks inside them')
  const edit = await Grant.open(project, 'edit')
  const w = await edit.resolveForWrite('.env')
  assert.ok(!w.ok && w.denied); ok('and they cannot be written')
  assert.ok(secretReason(join(homedir(), '.local', 'share', 'keyrings', 'login.keyring'), 'login.keyring')); ok('the desktop keyrings are refused by where they are')
}

console.log('\ncredentials are not copied into a workspace')
{
  const ws = await Workspace.create(project, join(base, 'ws'))
  assert.deepEqual(Object.keys(ws.manifest.files).sort(), ['.env.example', 'src/a.ts']); ok('the baseline names only the rest')
  for (const rel of ['.ssh/id_ed25519', '.env', 'sub/.env.local', 'config/.aws/credentials']) {
    assert.equal(await stat(join(ws.root, rel)).then(() => true, () => false), false, rel)
  }
  ok('and none of them is in the copy')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
