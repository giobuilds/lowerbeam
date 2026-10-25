/**
 * A spread across draws of the same chat.
 *
 * One draw is a single roll of the model. The number worth reporting is the
 * middle of several draws, with the lowest and highest beside it.
 */

export interface Spread {
  median: number
  low: number
  high: number
  draws: number
}

export function spread(values: number[]): Spread {
  if (values.length === 0) throw new Error('A spread needs at least one draw.')
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return { median, low: sorted[0]!, high: sorted[sorted.length - 1]!, draws: sorted.length }
}

/** "8 (6–11)" for a range, or "8" when every draw agreed. */
export function formatSpread(values: number[]): string {
  const result = spread(values)
  const mid = Number.isInteger(result.median) ? String(result.median) : result.median.toFixed(1)
  if (result.low === result.high) return mid
  return `${mid} (${result.low}–${result.high})`
}
