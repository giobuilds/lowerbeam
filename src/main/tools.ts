import { searchWeb, searchSearxng, fetchPage, SearchRateLimited, DEFAULT_LIMITS } from './web.js'
import type { ToolDefinition, ToolResult } from '@shared/types.js'

/**
 * Tools the model can call.
 *
 * Definitions are sent with every request, so each one costs tokens on every
 * message whether it is used or not — measured at about 50 tokens for a
 * single-parameter tool on this machine. That is why they are individually
 * switchable rather than all-or-nothing, and why the descriptions are written
 * to be short as well as clear.
 *
 * Search is deliberately two-tiered. A search returns titles and snippets for
 * about 400 tokens; fetching a page costs roughly 1,300. Most questions are
 * answered by the first, so the second exists but is not the default path.
 */

export const WEB_SEARCH = 'web_search'
export const FETCH_PAGE = 'fetch_page'

export const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: WEB_SEARCH,
    label: 'Web search',
    source: 'builtin',
    description:
      'Search the web and return titles, addresses and short extracts. Use for anything ' +
      'recent, live, or that you are unsure of. Prefer this over fetching a page.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' }
      },
      required: ['query']
    }
  },
  {
    name: FETCH_PAGE,
    label: 'Read a page',
    source: 'builtin',
    description:
      'Read one web page as text. Only use it when a search extract was not enough, ' +
      'and only for an address a search returned. Addresses on this computer or the local network are refused.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http or https address' }
      },
      required: ['url']
    }
  }
]

/**
 * Run a tool call and return text for the model.
 *
 * Failures come back as text rather than exceptions: a model that is told the
 * search failed can say so or try something else, whereas a thrown error ends
 * the reply and tells the person nothing.
 */
/**
 * Where searches go. A configured SearXNG instance is preferred because a
 * self-hosted one has no rate limit; the default engine very much does.
 */
let searxngUrl = ''
export function setSearxngUrl(url: string): void {
  searxngUrl = url.trim()
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === WEB_SEARCH) return await runSearch(String(args['query'] ?? ''))
    if (name === FETCH_PAGE) return await runFetch(String(args['url'] ?? ''))
    return { ok: false, summary: `Unknown tool ${name}`, content: `There is no tool called ${name}.` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, summary: `${name} failed`, content: `The tool failed: ${message}` }
  }
}

async function runSearch(query: string): Promise<ToolResult> {
  if (!query.trim()) {
    return { ok: false, summary: 'Empty search', content: 'No query was given.' }
  }
  let results
  try {
    results = searxngUrl ? await searchSearxng(searxngUrl, query) : await searchWeb(query)
  } catch (err) {
    if (err instanceof SearchRateLimited) {
      // Told plainly, so the model waits or answers from what it has instead of
      // rephrasing a query that was never the problem.
      return {
        ok: false,
        summary: 'Search is rate limited',
        content:
          'The search engine is temporarily refusing requests. Do not rephrase and retry — ' +
          'either answer from what you already have, or say that the search was unavailable.'
      }
    }
    throw err
  }
  if (results.length === 0) {
    return {
      ok: true,
      summary: `Searched “${query}” — nothing found`,
      content: `No results for "${query}".`
    }
  }
  // Numbered so the model can refer to a result, and compact so five of them
  // stay within a few hundred tokens.
  const content = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join('\n\n')
  return {
    ok: true,
    summary: `Searched “${query}” — ${results.length} results`,
    content,
    sources: results.map((r) => ({ title: r.title, url: r.url }))
  }
}

async function runFetch(url: string): Promise<ToolResult> {
  const page = await fetchPage(url, DEFAULT_LIMITS)
  return {
    ok: true,
    summary: `Read ${page.title || page.url}${page.truncated ? ' (shortened)' : ''}`,
    content: `${page.title}\n${page.url}\n\n${page.text}`,
    sources: [{ title: page.title, url: page.url }]
  }
}
