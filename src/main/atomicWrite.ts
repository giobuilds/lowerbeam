import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { PRIVATE_DIR, PRIVATE_FILE } from './private.js'

/**
 * Write a file so it is never observed half-written.
 *
 * Writing in place is not safe even on its own: a shorter write over a longer
 * file can leave the tail of the old content behind if anything interleaves,
 * producing a file that is valid JSON followed by garbage. That is exactly how a
 * settings file came to end with `"downloadHistory": []}` followed by 613 bytes
 * of the previous version, after which it no longer parsed and the application
 * silently fell back to defaults, losing the calibration it had measured.
 *
 * Writing to a temporary file and renaming makes the replacement atomic: readers
 * see either the old file or the new one, never a mixture.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  // Everything written this way is the app's own data: its user's alone.
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR })
  // Same directory, so the rename cannot cross a filesystem boundary.
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, contents, { encoding: 'utf8', mode: PRIVATE_FILE })
  await rename(temporary, path)
}

/**
 * Run tasks one after another.
 *
 * Concurrent writers to one file corrupt it however atomic each write is —
 * the last to finish wins, and a caller that computed its content from an
 * earlier state silently discards whatever happened in between. Chaining makes
 * every write see the result of the one before it.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    // A rejection must not poison the chain for later writers.
    this.tail = next.catch(() => undefined)
    return next
  }
}
