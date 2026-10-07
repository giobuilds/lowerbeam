import { readFile, rename, writeFile } from 'node:fs/promises'
import { parseLog } from './parse.js'
import { formatCents } from './money.js'

/** A ledger file's entries. A file that does not exist yet is an empty ledger. */
export async function loadLedger(path) {
  try {
    return parseLog(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * Write the ledger to a temporary file beside it, then rename that over the
 * real one. A rename within one directory replaces the file in a single step,
 * so a crash or a full disk mid-write leaves the old ledger whole rather than
 * half of a new one.
 */
export async function saveLedger(path, entries) {
  const text = entries.map((e) => `${e.date}, ${e.category}, ${formatCents(e.cents)}`).join('\n') + '\n'
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text)
  await rename(temp, path)
}
