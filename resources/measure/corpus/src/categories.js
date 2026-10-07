/**
 * Category names as people type them — "Groceries", " groceries ",
 * "GROCERIES" — in one form, so they total together: trimmed, lower-case,
 * runs of spaces collapsed to one.
 */
export function normalise(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** The distinct categories in a list of entries, sorted. */
export function categoriesOf(entries) {
  return [...new Set(entries.map((e) => e.category))].sort()
}
