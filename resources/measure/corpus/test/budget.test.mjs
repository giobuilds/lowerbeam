import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { budgetState, remaining } from '../src/budget.js'

test('under the threshold is ok', () => {
  assert.equal(budgetState(5000, 10000), 'ok')
})

test('warns at 80 percent', () => {
  assert.equal(budgetState(8000, 10000), 'warn')
  assert.equal(budgetState(9500, 10000), 'warn')
})

test('over once past the whole budget', () => {
  assert.equal(budgetState(10001, 10000), 'over')
})

test('no budget is always ok', () => {
  assert.equal(budgetState(5000, 0), 'ok')
})

test('remaining goes negative when overspent', () => {
  assert.equal(remaining(12000, 10000), -2000)
})
