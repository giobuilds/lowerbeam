/** Where suites register their tests; test/run.mjs runs them. */
export const tests = []

export function test(name, fn) {
  tests.push({ name, fn })
}
