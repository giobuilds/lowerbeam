import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadRecovery, managedLabel, showFirstRunOffer } from '../../src/shared/llamaOffer.js'
import { llamaInstallSchema } from '../../src/shared/schema.js'
import {
  binaryToProbe,
  deleteManagedDir,
  forgetManagedBuild,
  rememberManagedBuild,
  removalBlocked
} from '../../src/main/llamaManage.js'
import { SettingsStore } from '../../src/main/settings.js'

let n = 0
const ok = (message: string): void => {
  n++
  console.log('  ok', message)
}

console.log('when a binary is already there')
{
  assert.equal(showFirstRunOffer(''), true)
  assert.equal(showFirstRunOffer('/usr/bin/llama'), false)
  ok('a found binary is not offered a download, so nothing is requested until Download is clicked')

  assert.equal(
    managedLabel('0.6.0-dev (build 11429, commit abc)', 'unified', 'vulkan'),
    'Lowerbeam-managed · llama serve 0.6.0-dev (build 11429, commit abc) · Vulkan'
  )
  assert.equal(managedLabel('0.4.0', 'llama-server', 'cpu'), 'Lowerbeam-managed · llama-server 0.4.0 · CPU')
  ok('the managed build is labelled with its program, version and backend')

  const offline = downloadRecovery("Couldn't reach GitHub.", { backend: 'vulkan', channel: 'pinned' })
  assert.equal(offline.retry, true)
  assert.equal(offline.newest, false)
  assert.equal(offline.cpu, false)
  const pointer = downloadRecovery(
    'The latest release has no nightly-tag.txt, so the pinned build could not be chosen.',
    { backend: 'vulkan', channel: 'pinned' }
  )
  assert.equal(pointer.newest, true)
  assert.equal(
    downloadRecovery('The latest release has no nightly-tag.txt, so the pinned build could not be chosen.', {
      backend: 'vulkan',
      channel: 'newest'
    }).newest,
    false
  )
  assert.equal(downloadRecovery('No Vulkan GPU was found.', { backend: 'vulkan', channel: 'pinned' }).cpu, true)
  assert.equal(downloadRecovery('No Vulkan GPU was found.', { backend: 'cpu', channel: 'pinned' }).cpu, false)
  assert.equal(downloadRecovery('Download cancelled.', { backend: 'cpu', channel: 'pinned' }).retry, true)
  assert.equal(
    downloadRecovery('The download stalled. Try again and it will resume.', { backend: 'vulkan', channel: 'pinned' }).retry,
    true
  )
  ok('a failure offers retry, the newest build, or the CPU build')
}

console.log('\nwhat the window may ask')
{
  assert.deepEqual(llamaInstallSchema.parse({ backend: 'cpu', channel: 'newest' }), {
    backend: 'cpu',
    channel: 'newest'
  })
  assert.throws(() =>
    llamaInstallSchema.parse({ backend: 'vulkan', channel: 'pinned', url: 'https://evil.example/a.tar.gz' })
  )
  assert.throws(() => llamaInstallSchema.parse({ backend: 'rocm', channel: 'pinned' }))
  ok('a download request is a backend and a channel, and a URL is rejected')
}

console.log('\nwhich binary is probed')
{
  const managed = { path: '/data/llama.cpp/b1-vulkan/llama' }
  assert.equal(binaryToProbe({ binaryPath: '/usr/bin/llama', managedBuild: managed }, '/opt/llama'), '/usr/bin/llama')
  assert.equal(binaryToProbe({ managedBuild: managed }, '/opt/llama'), '/opt/llama')
  assert.equal(binaryToProbe({ binaryPath: '  ', managedBuild: managed }), managed.path)
  assert.equal(binaryToProbe({}), undefined)
  ok('a chosen binary wins, then LLAMA_SERVER_PATH, then the official build')
}

console.log('\nsettings')
{
  const root = await mkdtemp(join(tmpdir(), 'llama-set-'))
  try {
    const store = new SettingsStore(join(root, 'settings.json'))
    await store.load()
    assert.equal(store.current.managedBuild, null)
    const managed = await rememberManagedBuild(
      store,
      { tag: 'b11429', backend: 'vulkan', llamaPath: join(root, 'llama'), digest: 'ab'.repeat(32) },
      '2026-10-11T12:00:00.000Z'
    )
    const again = new SettingsStore(join(root, 'settings.json'))
    await again.load()
    assert.deepEqual(again.current.managedBuild, managed)
    assert.equal(again.current.binaryPath, managed.path)
    assert.equal(await forgetManagedBuild(again), true)
    assert.equal(again.current.managedBuild, null)
    assert.equal(again.current.binaryPath, undefined)
    const reread = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as { binaryPath?: string }
    assert.equal(reread.binaryPath, undefined)

    await rememberManagedBuild(
      again,
      { tag: 'b2', backend: 'cpu', llamaPath: '/opt/llama', digest: 'cd'.repeat(32) },
      '2026-10-11T12:00:00.000Z'
    )
    await assert.rejects(again.patch({ managedBuild: { ...managed, tag: 'latest' } }))
    assert.equal(again.current.managedBuild?.tag, 'b2')
    await again.patch({ binaryPath: '/usr/bin/llama' })
    assert.equal(await forgetManagedBuild(again), false)
    assert.equal(again.current.managedBuild, null)
    assert.equal(again.current.binaryPath, '/usr/bin/llama')
    ok('the managed build is saved with the selection, and a bad tag is refused')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\nremoving a build')
{
  assert.equal(removalBlocked(null, '/data/llama.cpp/b1-vulkan/llama'), null)
  assert.match(removalBlocked('/data/llama.cpp/b1-vulkan/llama', '/data/llama.cpp/b1-vulkan/llama') ?? '', /Stop the running server/)
  assert.equal(removalBlocked('/usr/bin/llama', '/data/llama.cpp/b1-vulkan/llama'), null)

  const root = await mkdtemp(join(tmpdir(), 'llama-rm-'))
  try {
    const dir = join(root, 'b1-vulkan')
    await mkdir(dir)
    await writeFile(join(dir, 'llama'), 'bin')
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'keep')
    await symlink(outside, join(root, 'b2-vulkan'))
    await assert.rejects(deleteManagedDir(root, join(root, 'b2-vulkan', 'llama')), /Refused/)
    assert.equal(await readFile(outside, 'utf8'), 'keep')
    await deleteManagedDir(root, join(dir, 'llama'))
    await assert.rejects(lstat(dir))
    await assert.rejects(deleteManagedDir(root, join(root, '..', 'llama')), /Refused/)
    ok('remove deletes the build directory and refuses a symlink or a path that leaves the folder')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${n} assertions passed`)
