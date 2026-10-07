import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { categoriesOf, normalise } from '../src/categories.js'

test('trims and collapses spaces', () => {
  assert.equal(normalise('  eating   out '), 'eating out')
})

test('lower-cases, so one category totals together', () => {
  assert.equal(normalise('Groceries'), 'groceries')
  assert.equal(normalise('EATING OUT'), 'eating out')
})

test('distinct categories, sorted', () => {
  assert.deepEqual(categoriesOf([{ category: 'rent' }, { category: 'bus' }, { category: 'rent' }]), ['bus', 'rent'])
})
