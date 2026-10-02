/**
 * Web access for the model.
 *
 * The governing constraint is context, not bandwidth. Measured on this machine,
 * one page of raw HTML is about 14,000 tokens — roughly 43% of a conversation's
 * whole context — while the same page extracted to text is about 1,300, and its
 * search snippet about 380. So the model is never shown a page: it is shown
 * text, and only when a snippet was not enough.
 *
 * Everything here runs in the main process. The renderer's CSP allows loopback
 * only, which is deliberate, and fetching arbitrary sites from the page that
 * renders model output would be the wrong place for it regardless.
 *
 * A page fetch reaches the public internet and nothing else. Chat runs tool
 * calls without asking, so a page that says "now read 127.0.0.1:8080/slots"
 * is an instruction the model may follow — and llama-server there has no API
 * key. Every address a fetch connects to is checked, after DNS and after every
 * redirect, at the moment of connecting, so a name that resolves somewhere
 * public once and somewhere private the next time is caught as well.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** A budget in characters, converted to tokens at roughly four characters each. */
export interface WebLimits {
  /** Results returned by a search. */
  maxResults: number
  /** Characters of snippet kept per result. */
  snippetChars: number
  /** Characters of extracted text returned by a page fetch. */
  pageChars: number
  /** Bytes downloaded before giving up, so a huge page cannot stall a reply. */
  maxDownloadBytes: number
  timeoutMs: number
}

export const DEFAULT_LIMITS: WebLimits = {
  maxResults: 5,
  snippetChars: 240,
  pageChars: 6000,
  maxDownloadBytes: 3_000_000,
  timeoutMs: 20_000
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface PageResult {
  url: string
  title: string
  text: string
  /** True when the page was longer than the budget and was cut. */
  truncated: boolean
  bytes: number
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'"
  }
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+|#x?\w+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole)
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Search without an API key, so the feature works out of the box.
 *
 * DuckDuckGo's HTML endpoint is scraped rather than called as an API, which
 * means its markup can change; a failure here returns nothing rather than
 * throwing, so the model is told the search found nothing instead of the reply
 * failing outright.
 */
export class SearchRateLimited extends Error {
  constructor() {
    super('The search engine is rate limiting requests. Wait a few seconds before searching again.')
    this.name = 'SearchRateLimited'
  }
}

/** Identical queries within this window are answered from memory. */
const CACHE_TTL_MS = 10 * 60_000
/** DuckDuckGo starts refusing after roughly two rapid requests. */
const MIN_GAP_MS = 1500

const cache = new Map<string, { at: number; results: SearchResult[] }>()
let lastRequestAt = 0

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Search through a SearXNG instance instead of the default engine.
 *
 * SearXNG aggregates other engines and, on an instance you run yourself,
 * imposes no rate limit — which is the default's real weakness. Most public
 * instances disable this JSON API precisely because it is easy to abuse, so
 * this is worth configuring only if you host one.
 */
export async function searchSearxng(
  instanceUrl: string,
  query: string,
  limits = DEFAULT_LIMITS
): Promise<SearchResult[]> {
  const base = instanceUrl.replace(/\/+$/, '')
  const url = base + '/search?' + new URLSearchParams({ q: query, format: 'json' }).toString()
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(limits.timeoutMs)
  })
  if (!res.ok) throw new Error('The SearXNG instance returned HTTP ' + res.status + '.')

  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    // An instance with the JSON API switched off answers with its search page,
    // which is a configuration problem worth naming rather than a parse error.
    throw new Error('That instance did not return JSON. Enable the json format in its settings.')
  }

  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return (body.results ?? [])
    .filter((r) => typeof r.url === 'string' && /^https?:/i.test(r.url))
    .slice(0, limits.maxResults)
    .map((r) => ({
      title: (r.title ?? '').slice(0, 160),
      url: r.url!,
      snippet: (r.content ?? '').slice(0, limits.snippetChars)
    }))
}

export async function searchWeb(query: string, limits = DEFAULT_LIMITS): Promise<SearchResult[]> {
  const key = query.trim().toLowerCase()
  const hit = cache.get(key)
  // A repeated query costs nothing and, more usefully, does not spend one of
  // the few requests the engine will accept.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results

  // One retry after a pause: the limit is short-lived, and a model that has to
  // rephrase a perfectly good query wastes a whole round doing it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const since = Date.now() - lastRequestAt
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since)
    if (attempt > 0) await delay(2500)
    lastRequestAt = Date.now()

    const results = await searchOnce(query, limits)
    if (results !== null) {
      cache.set(key, { at: Date.now(), results })
      return results
    }
  }
  // Being rate limited is not the same as finding nothing, and saying so lets
  // the model stop rather than rephrase a query that was never the problem.
  throw new SearchRateLimited()
}

/** Returns null when the engine refused, as opposed to an empty result set. */
async function searchOnce(query: string, limits: WebLimits): Promise<SearchResult[] | null> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(limits.timeoutMs)
  })
  if (!res.ok) return null
  const html = await res.text()
  // The refusal page is a short document mentioning an anomaly, with no results.
  if (/anomaly|unusual traffic|captcha/i.test(html) && !html.includes('result__a')) return null

  const results: SearchResult[] = []
  const blocks = html.split(/class="result results_links/).slice(1)
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
    const url = unwrapRedirect(decodeEntities(link[1]!))
    if (!/^https?:\/\//i.test(url)) continue
    results.push({
      title: stripTags(link[2]!).slice(0, 160),
      url,
      snippet: snippet ? stripTags(snippet[1]!).slice(0, limits.snippetChars) : ''
    })
    if (results.length >= limits.maxResults) break
  }
  return results
}

/** DuckDuckGo wraps results in a redirect; the real address is in uddg. */
function unwrapRedirect(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/)
  if (match) return decodeURIComponent(match[1]!)
  return href.startsWith('//') ? `https:${href}` : href
}

/**
 * Fetch one page and reduce it to readable text.
 *
 * Content-bearing elements are preferred when the page marks them, because
 * navigation, headers and footers are most of a modern page's markup and none
 * of its meaning. What is returned is capped, and says so when it was cut —
 * silently truncating leaves the model reasoning about half a document without
 * knowing it.
 */
export async function fetchPage(url: string, limits = DEFAULT_LIMITS, blocked: (ip: string) => string | null = blockedAddress): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https addresses can be fetched.')

  const signal = AbortSignal.timeout(limits.timeoutMs)
  let at = new URL(url)
  let res: IncomingMessage
  for (let hop = 0; ; hop++) {
    res = await guardedGet(at, signal, blocked)
    const location = res.headers.location
    if (!location || !res.statusCode || res.statusCode < 300 || res.statusCode >= 400) break
    res.resume()
    if (hop === MAX_REDIRECTS) throw new Error(`The page redirected more than ${MAX_REDIRECTS} times.`)
    at = new URL(location, at)
    if (at.protocol !== 'http:' && at.protocol !== 'https:') throw new Error('The page redirected to an address that is not http or https.')
  }
  const status = res.statusCode ?? 0
  if (status < 200 || status >= 300) {
    res.resume()
    throw new Error(`The page returned HTTP ${status}.`)
  }

  const type = res.headers['content-type'] ?? ''
  if (!/text\/html|text\/plain|application\/(xhtml|json)/i.test(type)) {
    res.resume()
    throw new Error(`That address is ${type.split(';')[0] || 'not text'}, which cannot be read as a page.`)
  }

  const raw = await readCapped(decoded(res), limits.maxDownloadBytes)
  const text = /text\/plain|application\/json/i.test(type) ? raw : extractReadableText(raw)
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const truncated = text.length > limits.pageChars

  return {
    url: at.href,
    title: title ? stripTags(title[1]!).slice(0, 160) : url,
    text: truncated ? `${text.slice(0, limits.pageChars)}\n\n[cut here — the page continues]` : text,
    truncated,
    bytes: raw.length
  }
}

const MAX_REDIRECTS = 5

/** Stop reading once the cap is passed, so one huge page cannot stall a reply. */
async function readCapped(body: Readable, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder()
  let out = ''
  let total = 0
  for await (const chunk of body) {
    const bytes = chunk as Buffer
    total += bytes.byteLength
    out += decoder.decode(bytes, { stream: true })
    if (total >= maxBytes) {
      body.destroy()
      break
    }
  }
  return out
}

/** The body as sent before compression, which fetch undid on its own and http does not. */
function decoded(res: IncomingMessage): Readable {
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const inflate = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null
  if (!inflate) return res
  res.on('error', (e) => inflate.destroy(e))
  return res.pipe(inflate)
}

/**
 * One GET, connecting only to an address `blocked` allows. A literal address
 * is checked here, since Node does not look one up; a name is checked in the
 * lookup the socket itself uses, so what is checked is what is connected to.
 */
function guardedGet(url: URL, signal: AbortSignal, blocked: (ip: string) => string | null): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    const why = blocked(host)
    if (why) return Promise.reject(refusal(url, host, why))
  }
  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0)
      for (const a of addresses) {
        const why = blocked(a.address)
        if (why) return callback(refusal(url, a.address, why), '', 0)
      }
      if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
      lookup,
      signal
    })
    req.on('response', resolve)
    req.on('error', reject)
    req.end()
  })
}

function refusal(url: URL, address: string, why: string): Error {
  const shown = url.hostname === address || url.hostname === `[${address}]` ? address : `${url.hostname} (${address})`
  return new Error(
    `${shown} is ${why}, so it was not fetched. Only pages on the public internet can be read; ` +
      'an address on this computer or the local network is refused even when a page or a redirect points there.'
  )
}

/**
 * What an address is, when it is somewhere a page fetch must not reach, or
 * null when it is public. Loopback, the private ranges, link-local (where cloud
 * metadata lives), carrier-grade NAT, and the reserved and multicast blocks,
 * in both families; an IPv4 address written as IPv6 is checked as IPv4.
 */
export function blockedAddress(ip: string): string | null {
  const family = isIP(ip) === 6 ? 'ipv6' : isIP(ip) === 4 ? 'ipv4' : null
  if (!family) return 'not an address'
  for (const [why, list] of RANGES) if (list.check(ip, family)) return why
  return null
}

const RANGES: Array<[string, BlockList]> = (
  [
    ['on this computer', [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]],
    ['an unspecified address', [['0.0.0.0', 8, 'ipv4'], ['::', 128, 'ipv6']]],
    ['on the local network', [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']]],
    ['a link-local address', [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']]],
    ['a carrier-grade NAT address', [['100.64.0.0', 10, 'ipv4']]],
    ['a reserved address', [['192.0.0.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['2001:db8::', 32, 'ipv6']]],
    ['a multicast address', [['224.0.0.0', 4, 'ipv4'], ['ff00::', 8, 'ipv6']]]
  ] as Array<[string, Array<[string, number, 'ipv4' | 'ipv6']>]>
).map(([why, subnets]) => {
  const list = new BlockList()
  for (const [net, prefix, family] of subnets) list.addSubnet(net, prefix, family)
  return [why, list]
})

export function extractReadableText(html: string): string {
  let working = html
    // Anything that is not prose, in rough order of how much of a page it is.
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  // If the page marks its content, trust it and drop the rest of the chrome.
  const main = working.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)
  if (main && stripTags(main[2]!).length > 400) working = main[2]!

  return (
    working
      // Block boundaries become newlines so the text keeps its shape.
      .replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((line) => decodeEntities(line).replace(/[ \t ]+/g, ' ').trim())
      .filter((line, i, all) => line.length > 0 && !(line === all[i - 1]))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
