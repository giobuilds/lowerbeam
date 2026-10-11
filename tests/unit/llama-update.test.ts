import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LLAMA_CHECK_INTERVAL_MS,
  LLAMA_UPDATE_LABEL,
  checkDue,
  llamaUpdateView,
  newerOfficialBuild,
  offerSentence,
  rollbackSentence,
  tagBuildNumber,
  updateCheckApplies
} from '../../src/shared/llamaOffer.js'
import { llamaOfferSchema, llamaUpdateSetSchema } from '../../src/shared/schema.js'
import type { BinaryInfo, ManagedBuild } from '../../src/shared/types.js'
import type { InstalledBuild, ResolvedAsset } from '../../src/main/llamaRelease.js'
import { SettingsStore } from '../../src/main/settings.js'
import {
  LlamaUpdateSchedule,
  expectNoChoice,
  installOfferedUpdate,
  restorePreviousBuild,
  runLlamaUpdateCheck,
  type LlamaUpdateClient
} from '../../src/main/llamaUpdate.js'

let n = 0
const ok = (message: string): void => {
  n++
  console.log('  ok', message)
}

const DIGEST = 'ab'.repeat(32)
const DAY = '2026-10-11T00:00:00.000Z'

function managedAt(root: string, tag: string, backend: ManagedBuild['backend'] = 'vulkan'): ManagedBuild {
  return {
    tag,
    backend,
    path: join(root, `${tag}-${backend}`, 'llama'),
    digest: DIGEST,
    installedAt: DAY
  }
}

function binaryAt(path: string, build: number): BinaryInfo {
  return {
    path,
    kind: 'unified',
    argvPrefix: ['serve'],
    version: `0.6.0-dev (build ${build}, commit abc)`,
    flags: [],
    flagDocs: [],
    flashAttnStyle: 'bare',
    devices: [],
    label: 'llama serve'
  }
}

function asset(tag: string): ResolvedAsset {
  return {
    tag,
    backend: 'vulkan',
    name: `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`,
    url: 'https://127.0.0.1/unused',
    size: 4,
    digest: DIGEST
  }
}

function installedBuild(root: string, tag: string): InstalledBuild {
  const llamaPath = managedAt(root, tag).path
  return {
    tag,
    backend: 'vulkan',
    dir: join(root, `${tag}-vulkan`),
    llamaPath,
    digest: DIGEST,
    size: 4,
    binary: binaryAt(llamaPath, Number(tag.slice(1)))
  }
}

interface Stub {
  client: LlamaUpdateClient
  calls: string[]
}

function stub(tag: string, install: () => Promise<InstalledBuild>): Stub {
  const calls: string[] = []
  return {
    calls,
    client: {
      async resolve(backend) {
        calls.push(`resolve:${backend}`)
        return asset(tag)
      },
      async installResolved() {
        calls.push('install')
        return install()
      }
    }
  }
}

async function withSettings(fn: (store: SettingsStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'llama-up-'))
  try {
    const store = new SettingsStore(join(root, 'settings.json'))
    await store.load()
    await fn(store, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('what a newer build is')
{
  assert.equal(LLAMA_UPDATE_LABEL, 'Check for newer official llama.cpp builds (once a day)')
  assert.equal(offerSentence('b11430'), 'llama.cpp b11430 is available')
  assert.equal(rollbackSentence('b11429'), 'Go back to b11429')
  assert.equal(tagBuildNumber('b11429'), 11429)
  assert.equal(tagBuildNumber('b1'), 1)
  assert.equal(tagBuildNumber('latest'), null)
  assert.equal(tagBuildNumber('build 11429'), null)
  assert.equal(newerOfficialBuild(11429, 11430), 11430)
  assert.equal(newerOfficialBuild(11429, 11429), null)
  assert.equal(newerOfficialBuild(11429, 11428), null)
  assert.equal(newerOfficialBuild(null, 11430), null)
  assert.equal(newerOfficialBuild(11429, null), null)
  ok('a newer build number is offered, and an equal, older or missing one is not')

  assert.equal(updateCheckApplies({ enabled: false, currentPath: '/m', managedPath: '/m' }), false)
  assert.equal(updateCheckApplies({ enabled: true, currentPath: '/own', managedPath: '/m' }), false)
  assert.equal(updateCheckApplies({ enabled: true, currentPath: '/m', managedPath: '/m' }), true)
  assert.equal(updateCheckApplies({ enabled: true, currentPath: '', managedPath: null }), false)
  const now = Date.parse(DAY)
  assert.equal(checkDue(null, now), true)
  assert.equal(checkDue('not-a-date', now), true)
  assert.equal(checkDue(DAY, now + LLAMA_CHECK_INTERVAL_MS - 1), false)
  assert.equal(checkDue(DAY, now + LLAMA_CHECK_INTERVAL_MS), true)
  ok('the check applies only to the managed build, and at most once a day')

  const managed = { tag: 'b2', path: '/m/llama', backend: 'vulkan' as const }
  const offer = { tag: 'b3', backend: 'vulkan' as const }
  const rollback = { tag: 'b1', path: '/old/llama' }
  assert.deepEqual(
    llamaUpdateView({ enabled: true, currentPath: '/m/llama', managed, offer, rollback: null }),
    { enabled: true, offerTag: 'b3', rollbackTag: null }
  )
  assert.deepEqual(
    llamaUpdateView({ enabled: false, currentPath: '/m/llama', managed, offer, rollback }),
    { enabled: false, offerTag: null, rollbackTag: 'b1' }
  )
  assert.deepEqual(
    llamaUpdateView({ enabled: true, currentPath: '/usr/bin/llama', managed, offer, rollback }),
    { enabled: true, offerTag: null, rollbackTag: null }
  )
  assert.equal(
    llamaUpdateView({
      enabled: true,
      currentPath: '/m/llama',
      managed,
      offer: { tag: 'b2', backend: 'vulkan' },
      rollback: null
    }).offerTag,
    null
  )
  ok('the offer is hidden for a build the person chose, and when the check is off')

  assert.equal(llamaUpdateSetSchema.parse('on'), 'on')
  assert.equal(llamaUpdateSetSchema.parse('off'), 'off')
  assert.throws(() => llamaUpdateSetSchema.parse('vulkan'))
  assert.throws(() => llamaUpdateSetSchema.parse({ url: 'https://evil.example/a.tar.gz' }))
  assert.throws(() => llamaOfferSchema.parse({ tag: 'b1', backend: 'vulkan', url: 'https://evil.example/a.tar.gz' }))
  expectNoChoice([])
  expectNoChoice([undefined])
  assert.throws(() => expectNoChoice(['b2']), /path or a URL/)
  assert.throws(() => expectNoChoice([{ tag: 'b2' }]), /path or a URL/)
  ok('turning the check on or off is the only word the window may send')
}

console.log('\nasking once')
{
  await withSettings(async (store, root) => {
    assert.equal(store.current.llamaUpdateCheck, false)
    assert.equal(store.current.llamaUpdateOffer, null)
    assert.equal(store.current.llamaRollback, null)
    await writeFile(join(root, 'settings.json'), '{}\n')
    await store.load()
    assert.equal(store.current.llamaUpdateCheck, false)
    ok('a settings file from before the check stays off')

    const managed = managedAt(root, 'b1')
    await store.patch({
      llamaUpdateCheck: true,
      binaryPath: managed.path,
      managedBuild: managed,
      llamaUpdateOffer: { tag: 'b2', backend: 'vulkan' }
    })
    let calls = 0
    const resolve = async (): Promise<{ tag: string }> => {
      calls += 1
      return { tag: 'b3' }
    }
    assert.equal(
      await runLlamaUpdateCheck({
        settings: store,
        currentPath: '/usr/bin/llama',
        now: new Date(DAY),
        resolve
      }),
      'skipped'
    )
    await store.patch({ llamaUpdateCheck: false })
    assert.equal(
      await runLlamaUpdateCheck({ settings: store, currentPath: managed.path, now: new Date(DAY), resolve }),
      'skipped'
    )
    assert.equal(calls, 0)
    assert.equal(store.current.llamaUpdateOffer?.tag, 'b2')
    ok('off, or a binary the person chose, does not ask and does not drop a saved offer')

    await store.patch({ llamaUpdateCheck: true })
    assert.equal(
      await runLlamaUpdateCheck({ settings: store, currentPath: managed.path, now: new Date(DAY), resolve }),
      'checked'
    )
    assert.equal(store.current.llamaUpdateOffer?.tag, 'b3')
    assert.equal(calls, 1)
    assert.equal(
      await runLlamaUpdateCheck({
        settings: store,
        currentPath: managed.path,
        now: new Date(Date.parse(DAY) + 60_000),
        resolve
      }),
      'skipped'
    )
    assert.equal(calls, 1)
    ok('a newer tag is recorded, and the rest of that day does not ask again')

    calls = 0
    const failed = async (): Promise<{ tag: string }> => {
      calls += 1
      throw new Error('offline')
    }
    const later = new Date(Date.parse(DAY) + LLAMA_CHECK_INTERVAL_MS + 1000)
    assert.equal(
      await runLlamaUpdateCheck({ settings: store, currentPath: managed.path, now: later, resolve: failed }),
      'failed'
    )
    assert.equal(store.current.llamaUpdateOffer?.tag, 'b3')
    assert.equal(store.current.managedBuild?.tag, 'b1')
    assert.equal(calls, 1)
    ok('a failed check does not install and keeps the offer already found')

    assert.equal(
      await runLlamaUpdateCheck({
        settings: store,
        currentPath: managed.path,
        now: new Date(later.getTime() + LLAMA_CHECK_INTERVAL_MS + 1000),
        resolve: async () => ({ tag: 'b1' })
      }),
      'checked'
    )
    assert.equal(store.current.llamaUpdateOffer, null)
    ok('an equal tag clears the offer')
  })
}

console.log('\ninstall and go back')
{
  await withSettings(async (store, root) => {
    const current = managedAt(root, 'b1')
    await store.patch({
      llamaUpdateCheck: true,
      binaryPath: current.path,
      managedBuild: current,
      llamaUpdateOffer: { tag: 'b2', backend: 'vulkan' }
    })
    const stopped = stub('b9', async () => installedBuild(root, 'b9'))
    await assert.rejects(
      installOfferedUpdate({
        settings: store,
        client: stopped.client,
        root,
        currentPath: current.path,
        assertStopped: () => {
          throw new Error('Stop the running server before changing the binary.')
        }
      }),
      /Stop the running server/
    )
    assert.deepEqual(stopped.calls, [])
    assert.equal(store.current.managedBuild?.tag, 'b1')
    ok('a running server is not switched, and GitHub is not asked')

    const own = stub('b2', async () => installedBuild(root, 'b2'))
    await assert.rejects(
      installOfferedUpdate({
        settings: store,
        client: own.client,
        root,
        currentPath: '/usr/bin/llama',
        assertStopped: () => {}
      }),
      /left as it is/
    )
    assert.deepEqual(own.calls, [])
    ok('a build the person chose is not replaced')

    await store.patch({ llamaUpdateCheck: false })
    const off = stub('b2', async () => installedBuild(root, 'b2'))
    await assert.rejects(
      installOfferedUpdate({
        settings: store,
        client: off.client,
        root,
        currentPath: current.path,
        assertStopped: () => {}
      }),
      /No newer official build/
    )
    assert.deepEqual(off.calls, [])
    await store.patch({ llamaUpdateCheck: true })
    ok('install does nothing while the check is off')

    const same = stub('b1', async () => {
      throw new Error('should not install')
    })
    await assert.rejects(
      installOfferedUpdate({
        settings: store,
        client: same.client,
        root,
        currentPath: current.path,
        assertStopped: () => {},
        now: new Date('2026-10-12T00:00:00.000Z')
      }),
      /No newer official build/
    )
    assert.deepEqual(same.calls, ['resolve:vulkan'])
    assert.equal(store.current.managedBuild?.tag, 'b1')
    assert.equal(store.current.llamaRollback, null)
    assert.equal(store.current.llamaUpdateOffer, null)
    ok('install stops when the pinned tag is no longer newer')

    await store.patch({ llamaUpdateOffer: { tag: 'b2', backend: 'vulkan' } })
    const broken = stub('b2', async () => {
      throw new Error('The build did not run. Use your own build.')
    })
    await assert.rejects(
      installOfferedUpdate({
        settings: store,
        client: broken.client,
        root,
        currentPath: current.path,
        assertStopped: () => {}
      }),
      /did not run/
    )
    assert.deepEqual(broken.calls, ['resolve:vulkan', 'install'])
    assert.equal(store.current.managedBuild?.tag, 'b1')
    assert.equal(store.current.binaryPath, current.path)
    assert.equal(store.current.llamaRollback, null)
    ok('a failed probe leaves the managed build where it was')

    const good = stub('b2', async () => installedBuild(root, 'b2'))
    const updated = await installOfferedUpdate({
      settings: store,
      client: good.client,
      root,
      currentPath: current.path,
      assertStopped: () => {}
    })
    assert.equal(updated.tag, 'b2')
    assert.equal(store.current.managedBuild?.tag, 'b2')
    assert.equal(store.current.binaryPath, updated.llamaPath)
    assert.equal(store.current.llamaRollback?.tag, 'b1')
    assert.equal(store.current.llamaRollback?.path, current.path)
    assert.equal(store.current.llamaUpdateOffer, null)
    ok('the managed build is replaced only after install returns')

    await mkdir(join(root, 'b1-vulkan'), { recursive: true })
    await writeFile(current.path, 'kept', { mode: 0o700 })
    let probed = false
    await assert.rejects(
      restorePreviousBuild({
        settings: store,
        root,
        currentPath: updated.llamaPath,
        assertStopped: () => {
          throw new Error('Stop the running server before changing the binary.')
        },
        probe: async () => {
          probed = true
          return binaryAt(current.path, 1)
        }
      }),
      /Stop the running server/
    )
    assert.equal(probed, false)
    assert.equal(store.current.managedBuild?.tag, 'b2')
    ok('go back also waits until the server is stopped')

    await assert.rejects(
      restorePreviousBuild({
        settings: store,
        root,
        currentPath: '/usr/bin/llama',
        assertStopped: () => {},
        probe: async () => binaryAt(current.path, 1)
      }),
      /left as it is/
    )
    assert.equal(store.current.managedBuild?.tag, 'b2')
    ok('go back does not replace a build the person chose')

    await assert.rejects(
      restorePreviousBuild({
        settings: store,
        root,
        currentPath: updated.llamaPath,
        assertStopped: () => {},
        probe: async () => {
          throw new Error('The build did not run. Use your own build.')
        }
      }),
      /did not run/
    )
    assert.equal(store.current.managedBuild?.tag, 'b2')
    assert.equal(store.current.llamaRollback?.tag, 'b1')
    ok('go back leaves the current build when the previous one fails the probe')

    const back = await restorePreviousBuild({
      settings: store,
      root,
      currentPath: updated.llamaPath,
      assertStopped: () => {},
      probe: async (path) => binaryAt(path, 1)
    })
    assert.equal(back.path, current.path)
    assert.equal(store.current.managedBuild?.tag, 'b1')
    assert.equal(store.current.binaryPath, current.path)
    assert.equal(store.current.llamaRollback, null)
    assert.equal(store.current.llamaUpdateOffer?.tag, 'b2')
    ok('go back selects the kept build and offers the one just left')
  })
}

console.log('\nonce a day from the schedule')
{
  await withSettings(async (store, root) => {
    const managed = managedAt(root, 'b1')
    await store.patch({ binaryPath: managed.path, managedBuild: managed, llamaUpdateCheck: false })
    let calls = 0
    const schedule = new LlamaUpdateSchedule(
      store,
      async () => {
        calls += 1
        return { tag: 'b2' }
      },
      () => managed.path,
      () => new Date(DAY)
    )
    try {
      schedule.start()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(calls, 0)
      await store.patch({ llamaUpdateCheck: true })
      schedule.nudge()
      for (let i = 0; i < 50 && store.current.llamaCheckedAt !== DAY; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(calls, 1)
      assert.equal(store.current.llamaUpdateOffer?.tag, 'b2')
      schedule.nudge()
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(calls, 1)
      ok('the schedule asks when the check is turned on, and not again that day')
    } finally {
      schedule.stop()
    }
  })
}

console.log(`\n${n} assertions passed`)
