/**
 * Whether a compaction record is still supported by the transcript it came from.
 *
 * A path, a flag, a command or a copied span has to occur in those turns.
 * Anything else was paraphrased or carried in from an earlier note, and a
 * person can see that without reading the whole chat. The check is the
 * spelling, not a guess about what the line means.
 */
import type { ChatMessageView } from '@shared/types.js'

/** Lines of the record that are not a span of `source`. Blank lines are not claims. */
export function unsupportedLines(record: string, source: string): string[] {
  const missing: string[] = []
  for (const raw of record.split('\n')) {
    const line = raw.trim()
    if (!line || source.includes(line)) continue
    missing.push(line)
  }
  return missing
}

/**
 * The turns a record stands in for: everything up to and including the
 * message it was built through. Later turns were kept word for word and
 * are not part of the check.
 */
export function transcriptThrough(messages: ChatMessageView[], throughMessageId: string): string {
  const at = messages.findIndex((message) => message.id === throughMessageId)
  if (at < 0) return ''
  return messages.slice(0, at + 1).map((message) => message.content).join('\n')
}
