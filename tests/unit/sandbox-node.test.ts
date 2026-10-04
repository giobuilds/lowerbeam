import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findNode, lendNode, probeSandbox } from '../../src/main/coding/sandbox.js'

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

console.log('\na version manager\u2019s shim is followed to the node it runs')
{
  // Volta's layout (#97): ~/.volta/bin/node -> volta-shim, which runs a
  // version under ~/.volta/tools/image. The shim here is a script that does
  // the same; what matters is that the shim is never what is lent.
  const volta = join(home, '.volta')
  const image = join(volta, 'tools', 'image', 'node', '24.0.0')
  await mkdir(join(image, 'bin'), { recursive: true })
  await copyFile(process.execPath, join(image, 'bin', 'node'))
  const shim = await file(join(volta, 'bin', 'volta-shim'), `#!/bin/sh\nexec ${join(image, 'bin', 'node')} "$@"\n`)
  await chmod(shim, 0o755)
  await symlink('volta-shim', join(volta, 'bin', 'node'))
  const found = await findNode(`${join(volta, 'bin')}:/usr/bin:/bin`, base)
  assert.equal(found.node, join(image, 'bin', 'node')); ok('findNode names the image\u2019s binary, not the shim')
  const loan = await lendNode(found.node!, home)
  assert.deepEqual(bound(loan.args), [image]); ok('and the image\u2019s root is what is lent, not ~/.volta')
  assert.equal(loan.bin, join(image, 'bin')); ok('with its bin first on PATH')

  const broken = join(base, 'broken')
  await file(join(broken, 'volta-shim'), '#!/bin/sh\necho "volta: no default node version" >&2\nexit 1\n')
  await chmod(join(broken, 'volta-shim'), 0o755)
  await symlink('volta-shim', join(broken, 'node'))
  const none = await findNode(`${broken}:/usr/bin:/bin`, base)
  assert.equal(none.node, null); ok('a shim that names no node lends nothing')
  assert.match(none.note, /volta-shim, a version manager.s shim.*no default node version.*system.s tools only/); ok('and the note says so, with the shim\u2019s own words')
  const empty = await findNode(join(base, 'nowhere'), base)
  assert.match(empty.note, /No node was found on PATH/); ok('no node on PATH at all says that')
}

console.log('\na binary under another name is still node')
{
  const renamed = await file(join(home, 'bin', 'node-24'))
  const loan = await lendNode(renamed, home)
  const k = loan.args.indexOf('--symlink')
  assert.deepEqual(loan.args.slice(k, k + 3), ['--symlink', renamed, join(home, 'bin', 'node')]); ok('it is linked as node beside itself')
}

console.log('\nin a real box, the Volta image\u2019s node is the one that runs')
{
  const probe = await probeSandbox()
  if (!probe.ok) console.log(`  skipped: ${probe.reason}`)
  else {
    const found = await findNode(`${join(home, '.volta', 'bin')}:/usr/bin:/bin`, base)
    const loan = await lendNode(found.node!, home)
    const args = ['--ro-bind', '/usr', '/usr', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--die-with-parent']
    for (const dir of ['/lib64', '/lib', '/bin']) if (await stat(dir).then(() => true, () => false)) args.push('--ro-bind', dir, dir)
    const out = execFileSync('bwrap', [...args, ...loan.args, '--setenv', 'PATH', `${loan.bin}:/usr/bin:/bin`, '--', 'sh', '-c', 'command -v node; node --version'], { encoding: 'utf8' }).trim().split('\n')
    assert.equal(out[0], join(loan.bin, 'node')); ok('`node` on PATH inside is the image\u2019s, not /usr/bin/node')
    assert.equal(out[1], process.version); ok('and its version is the host\u2019s')
  }
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
