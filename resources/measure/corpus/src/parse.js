import { isIsoDate } from './dates.js'
import { normalise } from './categories.js'

/**
 * Amounts are held as whole cents, never as decimal numbers. Binary floating
 * point cannot represent most decimal fractions exactly: 0.1 + 0.2 is
 * 0.30000000000000004, and a year of entries summed as floats drifts by
 * cents. Integers add up exactly, so every amount becomes cents the moment
 * it is read and stays that way until it is formatted for display.
 */
export function toCents(text) {
  const trimmed = String(text).trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error(`not an amount: ${text}`)
  return Math.round(Number(trimmed) * 100)
}

/** One line of a log, `date, category, amount`, as an entry. Blank lines and `#` comments give null. */
export function parseLine(line) {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return null
  const parts = text.split(',').map((p) => p.trim())
  if (parts.length !== 3) throw new Error(`expected date, category, amount: ${line}`)
  const [date, category, amount] = parts
  if (!isIsoDate(date)) throw new Error(`not a date: ${date}`)
  return { date, category: normalise(category), cents: toCents(amount) }
}

/** Every entry in a log, in the order written. */
export function parseLog(text) {
  return text.split('\n').map(parseLine).filter((e) => e !== null)
}
