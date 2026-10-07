/** Cents as a display amount: 1250 is "12.50", -5 is "-0.05". */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * Round to a whole number, sending exact halves to the even neighbour:
 * 2.5 becomes 2 and 3.5 becomes 4. Rounding every half up adds a little to
 * each split, and over hundreds of splits the totals come out high; sending
 * halves to the even neighbour rounds up as often as down, so the bias
 * cancels out.
 */
export function roundHalfEven(x) {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/** Split an amount in cents into `ways` shares that add back up to it exactly. */
export function splitCents(cents, ways) {
  const share = roundHalfEven(cents / ways)
  const shares = Array.from({ length: ways }, () => share)
  shares[ways - 1] = cents - share * (ways - 1)
  return shares
}
