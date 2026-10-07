import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { categoryTotals, monthlyTotals } from '../src/report.js'

const entries = [
  { date: '2026-01-03', category: 'groceries', cents: 1250 },
  { date: '2026-01-20', category: 'rent', cents: 90000 },
  { date: '2026-02-02', category: 'groceries', cents: 830 },
  { date: '2025-12-31', category: 'bus', cents: 240 }
]

test('totals by calendar month, in order', () => {
  assert.deepEqual(monthlyTotals(entries), { '2025-12': 240, '2026-01': 91250, '2026-02': 830 })
})

test('totals by category within a range', () => {
  assert.deepEqual(categoryTotals(entries, '2026-01-01', '2026-01-31'), { groceries: 1250, rent: 90000 })
})
