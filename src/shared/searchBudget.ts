/**
 * How many times one reply may search the web.
 *
 * The default engine refuses after about two rapid requests, and a small model
 * spends both on rephrased queries, then keeps calling the tool until the turn
 * is cut off with no answer. The loop matches that limit: one search is sent
 * per step, two per reply, and a rate limit ends searching immediately.
 */

export const WEB_SEARCH = 'web_search'
export const FETCH_PAGE = 'fetch_page'

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

const STOP = new Set(['what', 'is', 'on', 'the', 'a', 'an', 'please', 'tell', 'me', 'about', 'of', 'for', 'to', 'and', 'how', 'does', 'do', 'can', 'you'])

/**
 * When the question already names a site, read that site instead of searching.
 *
 * A pasted address is fetched as given. GitHub, named in the question or in
 * the one search this step may send, becomes a repository search. A URL that
 * appears only inside the model's query is left alone: that is usually a
 * snippet, and fetching it spends the page budget on whatever ranked first.
 */
export function zoneSkipUrl(userText: string, query: string): string | null {
  const pasted = firstHttpUrl(userText)
  if (pasted) return pasted
  const blob = `${userText}\n${query}`
  const repo = blob.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)
  if (repo && !repo[1]!.toLowerCase().startsWith('search/')) {
    return `https://github.com/${repo[1]!.replace(/\.git$/i, '')}`
  }
  if (/\bgithub(?:\.com)?\b/i.test(blob)) {
    const source = /\bgithub(?:\.com)?\b/i.test(userText) ? userText : query
    const q = source
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\bgithub(?:\.com)?\b/gi, ' ')
      .split(/[^\p{L}\p{N}.+-]+/u)
      .filter((word) => word && !STOP.has(word.toLowerCase()))
      .join(' ')
    return `https://github.com/search?q=${encodeURIComponent(q || 'repositories')}&type=repositories`
  }
  return null
}

function firstHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>)]+/i)
  if (!match) return null
  return match[0]!.replace(/[.,;:]+$/, '')
}
