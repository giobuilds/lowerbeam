#!/usr/bin/env node
/**
 * The test runner: every suite in test/, or the one named.
 *
 *   node test/run.mjs          all suites
 *   node test/run.mjs money    test/money.test.mjs only
 *
 * Prints each test as it runs and ends with "N tests passed", or with the
 * failures and exit code 1.
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tests } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv[2]
const files = (await readdir(here)).filter((f) => f.endsWith('.test.mjs')).sort()
const chosen = only ? files.filter((f) => f === `${only}.test.mjs`) : files
if (chosen.length === 0) {
  console.error(`no suite named ${only}; there are: ${files.map((f) => f.replace('.test.mjs', '')).join(', ')}`)
  process.exit(1)
}

let passed = 0
let failed = 0
for (const file of chosen) {
  console.log(file.replace('.test.mjs', ''))
  tests.length = 0
  await import(pathToFileURL(join(here, file)).href)
  for (const t of tests) {
    try {
      await t.fn()
      passed += 1
      console.log(`  ok ${t.name}`)
    } catch (err) {
      failed += 1
      console.log(`  FAIL ${t.name}: ${err.message.split('\n')[0]}`)
    }
  }
}
if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\n${passed} tests passed`)
