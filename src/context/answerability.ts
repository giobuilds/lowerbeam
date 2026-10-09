/**
 * Whether a text still carries the facts a conversation was scored on.
 *
 * A fact hits when any one of its spellings occurs, ignoring case. A
 * paraphrase that does not keep the transcript's own wording is a miss:
 * that is the loss compaction is being measured for. Commands, identifiers
 * and dates are reused later word for word, so a summary that only keeps
 * their gist has already failed.
 */

export interface Fact {
  id: string
  /** Case-insensitive. Any one spelling is enough. */
  anyOf: string[]
}

export function missingFacts(text: string, facts: readonly Fact[]): Fact[] {
  const hay = text.toLowerCase()
  return facts.filter(
    (fact) =>
      fact.anyOf.length === 0 ||
      !fact.anyOf.some((spelling) => spelling.length > 0 && hay.includes(spelling.toLowerCase()))
  )
}
