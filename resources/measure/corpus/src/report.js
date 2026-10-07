import { inRange } from './dates.js'

/**
 * Totals in cents by calendar month, keyed `YYYY-MM`. The month is the
 * first seven characters of the date, which the parser has already checked
 * is in ISO form.
 */
export function monthlyTotals(entries) {
  const totals = new Map()
  for (const e of entries) {
    const month = e.date.slice(0, 7)
    totals.set(month, (totals.get(month) ?? 0) + e.cents)
  }
  return Object.fromEntries([...totals].sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** Totals in cents by category, over the entries dated from `from` to `to`. */
export function categoryTotals(entries, from, to) {
  const totals = {}
  for (const e of entries) {
    if (!inRange(e.date, from, to)) continue
    totals[e.category] = (totals[e.category] ?? 0) + e.cents
  }
  return totals
}
