import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lendNode, probeSandbox } from '../../src/main/coding/sandbox.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// How node is lent to the box, for each place it is commonly installed. No
// bubblewrap needed except for the last section. Reproduced in #75: node in
// ~/bin had its install root, the home folder, bound read-only.
const base = await mkdtemp(join(tmpdir(), 'sandbox-node-'))
const home = join(base, 'home', 'me')
const file = async (path: string, text = ''): Promise<string> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}
const bound = (args: string[]): string[] => args.flatMap((a, i) => (a === '--ro-bind' ? [args[i + 1]!] : []))
const neverHome = (args: string[]): boolean =>
  bound(args).every((d) => d !== home && !home.startsWith(d + '/') && dirname(d) !== home)

console.log('node in ~/bin is lent alone')
{
  const node = await file(join(home, 'bin', 'node'))
  const loan = await lendNode(node, home)
  assert.deepEqual(loan.args, ['--ro-bind', node, node]); ok('only the binary is bound')
  assert.ok(neverHome(loan.args)); ok('not the home folder')
  assert.equal(loan.bin, join(home, 'bin')); ok('and its folder goes on PATH')
  assert.match(loan.note, /binary alone: .* is the home folder/); ok('the note says why')
}

console.log('\nnode in ~/.local/bin is lent alone, with npm and npx')
{
  const local = join(home, '.local')
  const node = await file(join(local, 'bin', 'node'))
  await file(join(local, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  await file(join(local, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  await file(join(local, 'share', 'keyrings', 'login.keyring'), 'secret')
  await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(local, 'bin', 'npm'))
  await symlink('../lib/node_modules/npm/bin/npx-cli.js', join(local, 'bin', 'npx'))
  await symlink(join(base, 'elsewhere', 'tool.js'), join(local, 'bin', 'corepack'))
  const loan = await lendNode(node, home)
  assert.ok(neverHome(loan.args)); ok('~/.local is not bound')
  assert.deepEqual(bound(loan.args), [node, join(local, 'lib', 'node_modules', 'npm')]); ok('the binary and the npm package are')
  assert.deepEqual(loan.args.filter((a) => a === '--symlink').length, 2); ok('with npm and npx as links to it, nothing else')
  assert.match(loan.note, /with npm: .* directly in the home folder/); ok('and the note says so')
}

console.log('\nnode from its own install is lent whole')
{
  const nvm = await file(join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin', 'node'))
  const loan = await lendNode(nvm, home)
  assert.deepEqual(bound(loan.args), [join(home, '.nvm', 'versions', 'node', 'v24.18.0')]); ok('nvm: the version folder, inside the home folder but not the home folder')
  const opt = await file(join(base, 'opt', 'node', 'bin', 'node'))
  assert.deepEqual(bound((await lendNode(opt, home)).args), [join(base, 'opt', 'node')]); ok('an install outside the home folder: its root')
  assert.deepEqual(bound((await lendNode('/usr/bin/node', home)).args), ['/usr']); ok('the system node: /usr, which the box has anyway')
  assert.deepEqual(bound((await lendNode('/bin/node', home)).args), ['/bin/node']); ok('a root of / is never bound')
}

console.log('\nin a real box, node in ~/bin runs and the home folder is not there')
{
  const probe = await probeSandbox()
  if (!probe.ok) console.log(`  skipped: ${probe.reason}`)
  else {
    assert.ok(probe.toolchain.startsWith('Node is lent')); ok('the probe says how node is lent')
    const box = join(base, 'box')
    const node = join(box, 'bin', 'node')
    await mkdir(dirname(node), { recursive: true })
    await copyFile(process.execPath, node)
    await file(join(box, 'secret.txt'), 'secret')
    const loan = await lendNode(node, box)
    const args = ['--ro-bind', '/usr', '/usr', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--die-with-parent']
    for (const dir of ['/lib64', '/lib', '/bin']) if (await stat(dir).then(() => true, () => false)) args.push('--ro-bind', dir, dir)
    const inside = (cmd: string): string => execFileSync('bwrap', [...args, ...loan.args, '--', 'sh', '-c', cmd], { encoding: 'utf8' }).trim()
    assert.equal(inside(`${node} -e 'console.log(process.version)'`), process.version); ok('node runs from the binary alone')
    assert.equal(inside(`test -e ${join(box, 'secret.txt')} && echo there || echo gone`), 'gone'); ok('and a file beside it in the home folder does not exist')
  }
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
