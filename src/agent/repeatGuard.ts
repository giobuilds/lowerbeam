/**
 * Stop a coding run that repeats itself.
 *
 * The same call with the same result is nudged once and stopped the next
 * time. The same error three times in a row stops the run even when the
 * arguments differ, and so does the same stretch of prose. A successful
 * write clears the count for that path: the file changed, so the next
 * read is a new question.
 *
 * The idea is the one in Gemini CLI's loop detection, OpenHands' stuck
 * detector and Goose's tool monitor. This is a new implementation.
 */
import { createHash } from 'node:crypto'

/** The second identical call and result is a note, not a stop. */
export const REPEAT_NUDGE_AT = 2
/** The third identical call and result ends the run. */
export const REPEAT_STOP_AT = 3
/** The same error text, this many times in a row, ends the run. */
export const REPEAT_ERROR_STREAK = 3
/** A stretch of prose at least this long, seen this many times, ends the run. */
export const REPEAT_TEXT_CHARS = 200
export const REPEAT_TEXT_TIMES = 3

export type RepeatRule = 'same_call' | 'same_error' | 'same_text'

export interface RepeatNotice {
  action: 'nudge' | 'stop'
  rule: RepeatRule
  /** The canonical call, the error text, or the repeated stretch of prose. */
  key: string
  count: number
  reason?: 'repeating' | 'repeating_error' | 'repeating_text'
  /** What the model is told, when the action is a nudge. */
  note?: string
}

/** JSON with object keys sorted at every level, so argument order does not matter. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) out[key] = sortValue(obj[key])
    return out
  }
  return value
}

export function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${canonicalJson(args)}`
}

export function resultHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface Seen {
  hash: string
  count: number
}

/**
 * One run's memory of what it already tried.
 *
 * Counts live here, not in the loop, so a test can feed calls without a model.
 */
export class RepeatGuard {
  private readonly seen = new Map<string, Seen>()
  /** Paths a write has changed and whose call counts have not been used since. */
  private readonly changed = new Set<string>()
  private errorStreak: { hash: string; count: number; sample: string } | null = null
  private readonly prose: string[] = []

  /** A write that landed. The next identical call on this path starts again. */
  noteWrite(name: string, args: Record<string, unknown>): void {
    if (name !== 'edit_file' && name !== 'write_file') return
    const path = typeof args.path === 'string' ? args.path : ''
    if (!path) return
    this.changed.add(path)
    for (const key of [...this.seen.keys()]) {
      if (keyNamesPath(key, path)) this.seen.delete(key)
    }
  }

  /**
   * One finished tool call.
   *
   * `ok` is the tool's own flag. An error is a result that was not ok, and
   * the streak is the same error text, whatever the arguments were.
   */
  observeCall(name: string, args: Record<string, unknown>, content: string, ok: boolean): RepeatNotice | null {
    const path = typeof args.path === 'string' ? args.path : ''
    const key = callKey(name, args)
    if (path && this.changed.has(path)) {
      this.changed.delete(path)
      this.seen.delete(key)
    }
    const hash = resultHash(content)
    const prior = this.seen.get(key)
    const count = prior && prior.hash === hash ? prior.count + 1 : 1
    this.seen.set(key, { hash, count })

    if (count >= REPEAT_STOP_AT) {
      return { action: 'stop', rule: 'same_call', key, count, reason: 'repeating' }
    }

    if (!ok) {
      const streak = this.errorStreak && this.errorStreak.hash === hash ? this.errorStreak.count + 1 : 1
      const sample = content.split('\n')[0]?.slice(0, 200) ?? content.slice(0, 200)
      this.errorStreak = { hash, count: streak, sample }
      if (streak >= REPEAT_ERROR_STREAK) {
        return { action: 'stop', rule: 'same_error', key: sample, count: streak, reason: 'repeating_error' }
      }
    } else {
      this.errorStreak = null
    }

    if (count >= REPEAT_NUDGE_AT) {
      const shown = content.length > 400 ? `${content.slice(0, 400)}…` : content
      return {
        action: 'nudge',
        rule: 'same_call',
        key,
        count,
        note: `You already called ${name} with these arguments. It returned:\n${shown}\nTry something different.`
      }
    }
    return null
  }

  /** The model's own words, besides any tool call. A repeated stretch ends the run. */
  observeProse(content: string): RepeatNotice | null {
    const text = content.trim()
    if (text.length < REPEAT_TEXT_CHARS) return null
    this.prose.push(text)
    const exact = this.prose.filter((item) => item === text).length
    if (exact >= REPEAT_TEXT_TIMES) {
      return { action: 'stop', rule: 'same_text', key: text.slice(0, REPEAT_TEXT_CHARS), count: exact, reason: 'repeating_text' }
    }
    const chunk = text.slice(0, REPEAT_TEXT_CHARS)
    const all = this.prose.join('\n')
    let times = 0
    let from = 0
    while (from < all.length) {
      const at = all.indexOf(chunk, from)
      if (at < 0) break
      times += 1
      from = at + chunk.length
    }
    if (times >= REPEAT_TEXT_TIMES) {
      return { action: 'stop', rule: 'same_text', key: chunk, count: times, reason: 'repeating_text' }
    }
    return null
  }
}

function keyNamesPath(key: string, path: string): boolean {
  const json = key.slice(key.indexOf(':') + 1)
  try {
    const args = JSON.parse(json) as Record<string, unknown>
    return Object.values(args).some((value) => value === path)
  } catch {
    return false
  }
}
