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
// #94: token files and key-shaped names beyond the first list.
const MORE = ['.npmrc', '.yarnrc.yml', '.netrc', '.git-credentials', '.pypirc', '.docker/config.json', 'home/.config/gh/hosts.yml',
  'home/.config/gcloud/credentials.db', 'keys/id_rsa', 'keys/id_ed25519.pub', 'keys/id_ecdsa', 'tls/server.pem', 'tls/server.key',
  'tls/client.p12', 'tls/client.pfx', 'gcp-credentials.json', 'config/secrets.json', 'config/secrets.yaml']
for (const rel of MORE) await put(rel, 'needle\n')
await put('config/secrets.example.json', '{"token": "needle-goes-here"}\n')
await put('src/secrets.ts', 'export const needle = process.env.TOKEN\n')
await put('home/.config/other/settings.json', '{}\n')

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
  for (const dot of ['.config', '.local', '.cache']) {
    await assert.rejects(checkProjectRoot(join(homedir(), dot), own), /settings folder directly in the home directory|does not exist/, dot)
  }
  ok('a dot-folder directly in home: ~/.config, ~/.local, ~/.cache')
  const { checkTerms } = await import('../../src/main/coding/supervisor.js')
  const configDir = join(homedir(), '.config')
  if (await stat(configDir).then(() => true, () => false)) {
    await assert.rejects(checkTerms({ alsoRead: [configDir], network: false, install: false }, 'run', own), /settings folder directly in the home directory/); ok('and ~/.config as an extra root')
  }
  await assert.rejects(checkProjectRoot(join(project, 'home', '.config', 'gh'), own), /folder of credentials/); ok('.config/gh is a folder of credentials')
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
  assert.deepEqual(hits, ['.env.example', 'config/secrets.example.json', 'src/a.ts', 'src/secrets.ts']); ok('search never looks inside them')
  const edit = await Grant.open(project, 'edit')
  const w = await edit.resolveForWrite('.env')
  assert.ok(!w.ok && w.denied); ok('and they cannot be written')
  assert.ok(secretReason(join(homedir(), '.local', 'share', 'keyrings', 'login.keyring'), 'login.keyring')); ok('the desktop keyrings are refused by where they are')
  for (const path of MORE) {
    const r = await runAgentTool(grant, 'read', { path })
    assert.ok(!r.ok && !r.content.includes('needle'), path)
  }
  ok('read refuses token files, keys, certificates and credentials files')
  assert.match((await runAgentTool(grant, 'read', { path: 'tls/server.pem' })).content, /named like a key.*test fixtures included/); ok('a name refused by its shape says so')
  assert.match((await runAgentTool(grant, 'read', { path: 'config/secrets.example.json' })).content, /needle-goes-here/); ok('a secrets template is readable')
  assert.match((await runAgentTool(grant, 'read', { path: 'src/secrets.ts' })).content, /needle/); ok('and so is code named secrets')
  assert.ok((await runAgentTool(grant, 'read', { path: 'home/.config/other/settings.json' })).ok); ok('a .config folder that is not gh or gcloud is not refused')
  const deep = await runAgentTool(grant, 'list_files', { path: 'home/.config' })
  assert.ok(deep.ok && !deep.content.includes('gh') && !deep.content.includes('gcloud') && deep.content.includes('other'), deep.content); ok('list leaves out .config/gh and .config/gcloud')
}

console.log('\ncredentials are not copied into a workspace')
{
  const ws = await Workspace.create(project, join(base, 'ws'))
  assert.deepEqual(Object.keys(ws.manifest.files).sort(), ['.env.example', 'config/secrets.example.json', 'home/.config/other/settings.json', 'src/a.ts', 'src/secrets.ts']); ok('the baseline names only the rest')
  for (const rel of ['.ssh/id_ed25519', '.env', 'sub/.env.local', 'config/.aws/credentials', ...MORE]) {
    assert.equal(await stat(join(ws.root, rel)).then(() => true, () => false), false, rel)
  }
  ok('and none of them is in the copy')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
