/** The share of a budget at which a category is flagged before it runs out. */
export const WARN_AT = 0.8

/**
 * Where a category stands against its budget: 'ok', 'warn' once WARN_AT of
 * it is spent, 'over' past the whole of it. A budget of zero or less means
 * no budget was set, and is always 'ok'.
 */
export function budgetState(spentCents, budgetCents) {
  if (budgetCents <= 0) return 'ok'
  const share = spentCents / budgetCents
  if (share > 1) return 'over'
  if (share >= WARN_AT) return 'warn'
  return 'ok'
}

/** What is left of a budget in cents; negative once it is overspent. */
export function remaining(spentCents, budgetCents) {
  return budgetCents - spentCents
}
