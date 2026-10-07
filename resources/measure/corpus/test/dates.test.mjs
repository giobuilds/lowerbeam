import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { inRange, isIsoDate } from '../src/dates.js'

test('accepts zero-padded ISO dates that exist', () => {
  assert.ok(isIsoDate('2026-01-03'))
  assert.ok(isIsoDate('2024-02-29'))
})

test('refuses anything else', () => {
  assert.ok(!isIsoDate('2026-1-3'))
  assert.ok(!isIsoDate('2026-02-30'))
  assert.ok(!isIsoDate('03/01/2026'))
})

test('ranges include both ends', () => {
  assert.ok(inRange('2026-01-01', '2026-01-01', '2026-01-31'))
  assert.ok(inRange('2026-01-31', '2026-01-01', '2026-01-31'))
  assert.ok(!inRange('2026-02-01', '2026-01-01', '2026-01-31'))
})
