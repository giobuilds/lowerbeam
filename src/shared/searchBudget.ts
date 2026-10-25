/**
 * How many times one reply may search the web.
 *
 * The default engine refuses after about two rapid requests, and a small model
 * spends both on rephrased queries, then keeps calling the tool until the turn
 * is cut off with no answer. The loop matches that limit: one search is sent
 * per step, two per reply, and a rate limit ends searching immediately.
 */

export const WEB_SEARCH = 'web_search'

/** Real searches one reply may send. DuckDuckGo's HTML endpoint allows about two. */
export const SEARCHES_PER_REPLY = 2

/** Shown on the tool result when the engine refused. The loop treats this as final. */
export const SEARCH_RATE_LIMITED = 'Search is rate limited'

export const HELD_THIS_STEP = {
  ok: false as const,
  summary: 'Not sent',
  content: 'Not sent. One search already ran for this step.'
}

export const SEARCH_CLOSED = {
  ok: false as const,
  summary: 'Not sent',
  content:
    'Not sent. Web search is no longer available for this reply. Answer from what you have, or read a page a search already found.'
}

export interface SearchBudget {
  used: number
  limited: boolean
}

export function searchOpen(budget: SearchBudget): boolean {
  return !budget.limited && budget.used < SEARCHES_PER_REPLY
}

/** The one search in this step that may be sent, and the ones that must not. */
export function partitionSearches<T extends { name: string }>(
  calls: T[],
  open: boolean
): { send: T | null; held: T[] } {
  const searches = calls.filter((call) => call.name === WEB_SEARCH)
  if (!open || searches.length === 0) return { send: null, held: searches }
  return { send: searches[0] ?? null, held: searches.slice(1) }
}
