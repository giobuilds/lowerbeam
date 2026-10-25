import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAll } from '../../src/main/probe.js'
import { DownloadManager, repoCacheDir } from '../../src/main/downloads.js'
import type { DownloadJob } from '@shared/types.js'

let n = 0
const ok = (m: string): void => { n++; console.log('  ok', m) }
const bin = (await probeAll())[0]!

/**
 * A stored download record says what happened at the time. It cannot say what is
 * on disk now: a later attempt may have completed the file, or it may have been
 * deleted by hand. Reporting "partial file kept" when nothing is kept sends
 * someone looking for a file that does not exist.
 *
 * The files live in a cache this suite creates. The real Hugging Face cache is
 * whatever the person has downloaded, and deleting a model must not change the
 * result.
 */
const hub = await mkdtemp(join(tmpdir(), 'lowerbeam-download-state-'))
process.env['HF_HUB_CACHE'] = hub

try {
  console.log('history is judged against the disk, not from the record')

  const presentRepo = 'example/present'
  const presentFile = 'present.gguf'
  const snap = join(repoCacheDir(presentRepo), 'snapshots', 'rev')
  await mkdir(snap, { recursive: true })
  await writeFile(join(snap, presentFile), 'weights')

  const mgr = new DownloadManager(() => bin)
  mgr.restore([
    {
      id: 'a', repo: presentRepo, file: presentFile, expectedBytes: 7, receivedBytes: 0,
      state: 'cancelled', error: null, modelPath: null, startedAt: 1, finishedAt: 2
    },
    {
      id: 'b', repo: presentRepo, file: 'never-fetched.gguf', expectedBytes: 1, receivedBytes: 0,
      state: 'cancelled', error: null, modelPath: null, startedAt: 1, finishedAt: 2
    }
  ] as DownloadJob[])

  const jobs = await mgr.listWithDiskState()
  const cancelledButPresent = jobs.find((j) => j.file === presentFile)!
  const cancelledAndAbsent = jobs.find((j) => j.file === 'never-fetched.gguf')!

  console.log(`   ${presentFile}: onDisk=${cancelledButPresent.onDisk}`)
  console.log(`   never-fetched.gguf: onDisk=${cancelledAndAbsent.onDisk}`)

  assert.equal(cancelledButPresent.onDisk, true)
  ok('a cancelled download whose file later completed is reported as present')
  assert.equal(cancelledAndAbsent.onDisk, false)
  ok('a file that never arrived is reported as absent')
  assert.ok(!cancelledButPresent.partialBytes)
  ok('no partial is claimed when none is on disk')

  console.log('\na genuine partial is reported with its size')
  const fakeRepo = 'fake-org/fake-repo'
  const blobs = join(repoCacheDir(fakeRepo), 'blobs')
  await mkdir(blobs, { recursive: true })
  await writeFile(join(blobs, 'abc123.downloadInProgress'), Buffer.alloc(4096))
  const mgr2 = new DownloadManager(() => bin)
  mgr2.restore([
    {
      id: 'c', repo: fakeRepo, file: 'x.gguf', expectedBytes: 999999, receivedBytes: 4096,
      state: 'cancelled', error: null, modelPath: null, startedAt: 1, finishedAt: 2
    }
  ] as DownloadJob[])
  const partial = (await mgr2.listWithDiskState())[0]!
  assert.equal(partial.partialBytes, 4096)
  ok(`reports the ${partial.partialBytes} bytes actually kept`)
  assert.equal(partial.onDisk, false)
  ok('and does not claim the finished file exists')
} finally {
  delete process.env['HF_HUB_CACHE']
  await rm(hub, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
process.exit(0)
