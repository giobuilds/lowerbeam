/**
 * Dates stay as text, `YYYY-MM-DD`, and are compared as strings. That is only
 * correct because the format is ISO 8601 with every field zero-padded and
 * the largest unit first: comparing such strings character by character
 * gives the same order as comparing the dates. "2026-1-9" would sort after
 * "2026-10-01", which is why anything not in exactly this form is refused
 * when a log is read, instead of being parsed leniently.
 */
export function isIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** Whether `date` falls between `from` and `to`, both inclusive. */
export function inRange(date, from, to) {
  return date >= from && date <= to
}
