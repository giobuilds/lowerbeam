import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { probeSandbox, runInSandbox, bwrapArgs, overlaySupported, DEPS_DIR } from '../../src/main/coding/sandbox.js'
import { execFileSync, spawn } from 'node:child_process'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// This suite needs bubblewrap. Where it is absent the probe says so and that
// is the whole result: Coding would launch read-only there, and this suite
// reports nothing rather than pretending.
const probe = await probeSandbox()
if (!probe.ok) {
  console.log(`  skipped: ${probe.reason}`)
  console.log('\n0 assertions passed')
  process.exit(0)
}

const base = await mkdtemp(join(tmpdir(), 'sandbox-'))
const project = join(base, 'project')
const workspace = join(base, 'workspace')
await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep"\n')
await mkdir(workspace)
await writeFile(join(workspace, 'hello.js'), 'console.log("hello from", process.cwd() === process.env.PWD ? "cwd" : process.cwd())\n')
const opts = { workspace, projectRoot: project, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 }

console.log('a command runs in the workspace')
{
  const r = await runInSandbox({ ...opts, command: 'node hello.js && echo done' })
  assert.equal(r.exitCode, 0); ok('and exits with its own code')
  assert.match(r.stdout, /hello from/); assert.match(r.stdout, /done/); ok('its output comes back')
  const r2 = await runInSandbox({ ...opts, command: 'exit 3' })
  assert.equal(r2.exitCode, 3); ok('a failing command reports its exit code')
  const piped = await runInSandbox({ ...opts, command: 'sh -c "echo out; exit 3" | head -1' })
  assert.equal(piped.exitCode, 3); assert.match(piped.stdout, /out/); ok('and so does a failing command piped through head')
}

console.log('\nthe box is the whole world')
{
  const r = await runInSandbox({ ...opts, command: `ls ${homedir()} ${homedir()}/.ssh 2>&1; echo "code $?"` })
  assert.match(r.stdout, /No such file|cannot access/); ok('the home directory does not exist inside')
  const net = await runInSandbox({ ...opts, command: `node -e 'fetch("http://127.0.0.1:1/").then(()=>console.log("reached")).catch(e=>console.log("blocked", e.cause?.code))'` })
  assert.match(net.stdout, /blocked/); ok('there is no network, loopback included')
  const w = await runInSandbox({ ...opts, command: 'echo x > inside.txt; echo x > node_modules/evil.js 2>&1; echo x > /usr/evil 2>&1; echo end' })
  assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'x\n'); ok('a write to the workspace lands and is visible outside')
  assert.equal(await stat(join(project, 'node_modules', 'evil.js')).then(() => true, () => false), false); ok('the lent dependency tree is read only')
  assert.match(w.stdout + w.stderr, /Read-only|read-only|Permission/); ok('and the system is')
  const dep = await runInSandbox({ ...opts, command: `node -e 'console.log(require("dep"))'` })
  assert.match(dep.stdout, /dep/); ok('but the dependency tree is there to require from')
}

console.log('\nlimits hold')
{
  const t0 = Date.now()
  const r = await runInSandbox({ ...opts, command: 'sleep 30; echo never', timeoutMs: 1500 })
  assert.equal(r.timedOut, true); ok('a command past its time is killed and reported as timed out')
  assert.ok(Date.now() - t0 < 10_000); ok('promptly')
  assert.ok(!r.stdout.includes('never')); ok('with no output from after the kill')

  const big = await runInSandbox({ ...opts, command: 'node -e \'process.stdout.write("y".repeat(200000))\'', maxOutputBytes: 1000 })
  assert.equal(big.stdout.length, 1000); assert.equal(big.stdoutTruncated, true); ok('output past the cap is dropped and the drop is reported')

  const abort = new AbortController()
  setTimeout(() => abort.abort(), 500)
  const c = await runInSandbox({ ...opts, command: 'sleep 4747', signal: abort.signal })
  assert.equal(c.cancelled, true); ok('a stop from outside ends it, reported as cancelled')
  assert.equal(await settled(() => boxed('sleep 4747')), 0); ok('and the command it stopped is gone, not orphaned')
}

console.log('\nthe app dying takes the box with it')
{
  // The shape the app spawns, spawned the way the app spawns it — from a
  // process that is then killed outright, as a crash or a kill -9 would.
  const args = await bwrapArgs(workspace, project)
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    spawn('bwrap', ${JSON.stringify([...args, '--', 'sh', '-c', 'sleep 4848'])}, { detached: true, stdio: 'ignore' })
    setInterval(() => {}, 1000)
  `], { stdio: 'ignore' })
  assert.equal(await settled(() => boxed('sleep 4848'), (n) => n > 0), 1); ok('a boxed command is running under a parent process')
  parent.kill('SIGKILL')
  assert.equal(await settled(() => boxed('sleep 4848')), 0); ok('when the parent is killed outright, the boxed command dies with it')
}

console.log('\nnothing outlives the run')
{
  const r = await runInSandbox({ ...opts, command: 'sleep 47 & sleep 47 & echo started; sleep 0.3', timeoutMs: 2000 })
  assert.match(r.stdout, /started/)
  assert.equal(await settled(() => boxed('sleep 47')), 0); ok('background children started by the command are gone once it ends')
}

console.log('\nthe box\u2019s shape follows the terms of the grant')
{
  const plain = await bwrapArgs(workspace, project)
  assert.ok(plain.includes('--unshare-all') && !plain.includes('--share-net')); ok('by default the network is not there')
  assert.ok(plain.some((a, k) => a === '--ro-bind' && plain[k + 2] === join(workspace, 'node_modules'))); ok('and the project\u2019s node_modules is lent read only')
  const net = await bwrapArgs(workspace, project, { alsoRead: [], network: true, install: false })
  assert.ok(net.includes('--share-net') && net.indexOf('--share-net') > net.indexOf('--unshare-all')); ok('network: shared back in after everything else is unshared')
  const install = { alsoRead: [], network: false, install: true }
  const inst = await bwrapArgs(workspace, project, install)
  assert.ok(!inst.some((a, k) => a === '--ro-bind' && inst[k + 2] === join(workspace, 'node_modules'))); ok('install: the project\u2019s node_modules is not lent read only')
  if (await overlaySupported()) {
    assert.ok(inst.includes('--overlay-src') && inst[inst.indexOf('--overlay-src') + 1] === join(project, 'node_modules')); ok('it is the lower layer of an overlay instead')
    const sees = await runInSandbox({ ...opts, command: 'cat node_modules/dep/index.js && echo added > node_modules/added.js && ls node_modules', terms: install })
    assert.equal(sees.exitCode, 0); assert.ok(sees.stdout.includes('dep') && sees.stdout.includes('added.js')); ok('inside the box the project\u2019s dependencies are there and an install can add to them')
    assert.equal(await stat(join(project, 'node_modules', 'added.js')).then(() => true, () => false), false); ok('the project\u2019s tree is not written')
    assert.equal(await stat(join(workspace, DEPS_DIR, 'upper', 'added.js')).then(() => true, () => false), true); ok('the write landed beside the copy, where a change listing never looks')
    const again = await runInSandbox({ ...opts, command: 'cat node_modules/added.js', terms: install })
    assert.equal(again.exitCode, 0); assert.ok(again.stdout.includes('added')); ok('and it is still there for the next command')
  } else {
    const r = await runInSandbox({ ...opts, command: 'ls node_modules', terms: install })
    assert.equal(r.exitCode, 0); assert.ok(!r.stdout.includes('dep')); ok('no overlay on this kernel: the copy\u2019s own node_modules starts empty')
  }
  const also = await bwrapArgs(workspace, project, { alsoRead: [project], network: false, install: false })
  assert.ok(also.some((a, k) => a === '--ro-bind' && also[k + 1] === project && also[k + 2] === project)); ok('an extra root is bound read only at its own path')
  const seen = await runInSandbox({ ...opts, command: `cat ${join(project, 'node_modules', 'dep', 'index.js')}`, terms: { alsoRead: [project], network: false, install: false } })
  assert.equal(seen.exitCode, 0); assert.ok(seen.stdout.includes('dep')); ok('and a command can read it')
  const wr = await runInSandbox({ ...opts, command: `touch ${join(project, 'marker')}`, terms: { alsoRead: [project], network: false, install: false } })
  assert.notEqual(wr.exitCode, 0); ok('and cannot write it')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)

/** Processes running `command` inside a pid namespace other than this one's — i.e. inside a box. */
function boxed(command: string): number {
  const script = `host=$(readlink /proc/self/ns/pid); n=0
    for p in $(pgrep -f -x '${command}'); do [ "$(readlink /proc/$p/ns/pid 2>/dev/null)" != "$host" ] && n=$((n+1)); done; echo $n`
  return Number(execFileSync('sh', ['-c', script]).toString().trim())
}

/** The pid namespace tears down when the box exits, but not to the microsecond; poll until `done` holds or two seconds pass. */
async function settled(count: () => number, done: (n: number) => boolean = (n) => n === 0): Promise<number> {
  let n = count()
  for (let i = 0; i < 20 && !done(n); i++) { await new Promise((r) => setTimeout(r, 100)); n = count() }
  return n
}
