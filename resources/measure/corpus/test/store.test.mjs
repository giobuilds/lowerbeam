import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from './harness.mjs'
import { loadLedger, saveLedger } from '../src/store.js'

test('a ledger saved is the ledger loaded, with nothing left beside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
  try {
    const path = join(dir, 'ledger.txt')
    assert.deepEqual(await loadLedger(path), [])
    const entries = [{ date: '2026-01-03', category: 'groceries', cents: 1250 }]
    await saveLedger(path, entries)
    assert.deepEqual(await loadLedger(path), entries)
    assert.deepEqual(await readdir(dir), ['ledger.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
