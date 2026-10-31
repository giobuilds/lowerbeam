/**
 * Find the one place an edit should land when the model's copy is slightly off.
 *
 * Exact first, then trailing space, then leading and trailing space, then
 * the same with curly quotes, dashes and non-breaking spaces folded to
 * ASCII. More than one match is a refusal. The replacement is written as
 * given; this module does not re-indent it.
 *
 * The idea is Codex's seek-sequence and Gemini CLI's edit matching. This
 * is a new implementation.
 */

export type MatchLevel = 1 | 2 | 3 | 4

export interface PassageMatch {
  level: MatchLevel
  /** Index into the original text, which may use CRLF. */
  start: number
  end: number
  /** 1-based line of the first matched line. */
  line: number
}

export interface LocateResult {
  matches: PassageMatch[]
  /** A nearby line when nothing matched, so the model has somewhere to look. */
  closestLine: number | null
}

const LEVEL_NAME: Record<MatchLevel, string> = {
  1: 'exact match (level 1)',
  2: 'whitespace-tolerant match (level 2)',
  3: 'whitespace-tolerant match (level 3)',
  4: 'punctuation-tolerant match (level 4)'
}

/** The sentence an edit result uses when a looser level matched. */
export function levelNote(level: MatchLevel): string {
  if (level === 1) return ''
  return `Edited using ${LEVEL_NAME[level]}.`
}

interface LineSpan {
  text: string
  start: number
  end: number
  /** Index just after this line's break, or the end of the text. */
  next: number
}

/**
 * Try each level and stop at the first that matches at least once.
 *
 * `find` is compared as the model wrote it. The spans point at the original
 * file, including a CRLF line ending when the file has one.
 */
export function locate(content: string, find: string): LocateResult {
  if (!find) return { matches: [], closestLine: null }
  const exact = exactMatches(content, find)
  if (exact.length > 0) return { matches: exact, closestLine: null }
  const lines = splitLines(content)
  const want = find.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (want.length === 0) return { matches: [], closestLine: closest(lines, want) }
  for (const level of [2, 3, 4] as const) {
    const matches = matchesAt(lines, want, level, find.endsWith('\n'))
    if (matches.length > 0) return { matches, closestLine: null }
  }
  return { matches: [], closestLine: closest(lines, want) }
}

/**
 * Whether every non-blank line of the match differs in leading space by the
 * same amount. A relative indentation change is not that, and an edit that
 * would invent one is left for the caller to refuse.
 */
export function uniformLeadingDelta(content: string, find: string, match: PassageMatch): boolean {
  const lines = splitLines(content)
  const want = find.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const start = lines.findIndex((line) => line.start === match.start)
  if (start < 0) return false
  let delta: number | null = null
  for (let i = 0; i < want.length; i++) {
    const file = lines[start + i]?.text ?? ''
    const needle = want[i] ?? ''
    if (!file.trim() && !needle.trim()) continue
    const next = lead(file).length - lead(needle).length
    if (delta === null) delta = next
    else if (delta !== next) return false
  }
  return true
}

/** Level 1 is a substring of the file, which is how an exact passage has always matched. */
function exactMatches(content: string, find: string): PassageMatch[] {
  const hits: PassageMatch[] = []
  let from = 0
  while (from < content.length) {
    const at = content.indexOf(find, from)
    if (at < 0) break
    hits.push({ level: 1, start: at, end: at + find.length, line: content.slice(0, at).split(/\r\n|\n/).length })
    from = at + Math.max(1, find.length)
  }
  return hits
}

function matchesAt(lines: LineSpan[], want: string[], level: MatchLevel, keepBreak: boolean): PassageMatch[] {
  const hits: PassageMatch[] = []
  if (want.length === 0 || lines.length < want.length) return hits
  for (let i = 0; i + want.length <= lines.length; i++) {
    const window = lines.slice(i, i + want.length)
    if (!window.every((line, k) => sameLine(line.text, want[k] ?? '', level))) continue
    const last = window[window.length - 1]!
    hits.push({
      level,
      start: window[0]!.start,
      end: keepBreak ? last.next : last.end,
      line: i + 1
    })
  }
  return hits
}

function sameLine(file: string, needle: string, level: MatchLevel): boolean {
  if (level === 2) return file.trimEnd() === needle.trimEnd()
  if (level === 3) return file.trim() === needle.trim()
  return fold(file).trim() === fold(needle).trim()
}

/** Curly quotes, dashes and non-breaking spaces become their ASCII forms. Nothing else moves. */
export function fold(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u00A0/g, ' ')
}

function closest(lines: LineSpan[], want: string[]): number | null {
  const words = new Set(fold(want.join(' ')).toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length > 2))
  if (words.size === 0) return null
  let best = 0
  let line: number | null = null
  lines.forEach((span, index) => {
    const theirs = new Set(fold(span.text).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
    let score = 0
    for (const word of words) if (theirs.has(word)) score += 1
    if (score > best) {
      best = score
      line = index + 1
    }
  })
  return line
}

function splitLines(content: string): LineSpan[] {
  const lines: LineSpan[] = []
  let start = 0
  for (let i = 0; i <= content.length; i++) {
    const crlf = content[i] === '\r' && content[i + 1] === '\n'
    const lf = content[i] === '\n'
    if (crlf || lf || i === content.length) {
      const end = i
      const next = i === content.length ? i : i + (crlf ? 2 : 1)
      lines.push({ text: content.slice(start, end), start, end, next })
      if (i === content.length) break
      start = next
      if (crlf) i += 1
    }
  }
  if (lines.length === 0) lines.push({ text: '', start: 0, end: 0, next: 0 })
  return lines
}

function lead(text: string): string {
  return text.match(/^[ \t]*/)?.[0] ?? ''
}
