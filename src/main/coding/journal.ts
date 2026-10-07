import { appendFile, readFile } from 'node:fs/promises'
import type { JournalEvent } from '@shared/coding.js'
import { PRIVATE_FILE } from '../private.js'

/**
 * One run's journal: append-only JSONL, one event per line.
 *
 * Appends are chained so events land in the order they were emitted even
 * though each write is asynchronous — a tool result written before its call
 * would make the record lie about what happened. Nothing is ever rewritten;
 * reconstruction reads the file back and takes it as the truth.
 */
export class Journal {
  private chain: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  append(event: JournalEvent): Promise<void> {
    const write = this.chain.then(() => appendFile(this.path, JSON.stringify(event) + '\n', { mode: PRIVATE_FILE }))
    // A failed write must not poison every later one; it is reported where
    // it happened and the chain goes on.
    this.chain = write.catch(() => {})
    return write
  }

  /** Everything written so far, in order. Waits for pending appends first. */
  async read(): Promise<JournalEvent[]> {
    await this.chain
    return Journal.read(this.path)
  }

  static async read(path: string): Promise<JournalEvent[]> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const events: JournalEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as JournalEvent)
      } catch {
        // A torn last line is what a crash mid-write looks like. Everything
        // before it is still good, and that is what gets returned.
      }
    }
    return events
  }
}
