import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { formatCents, roundHalfEven, splitCents } from '../src/money.js'

test('formats cents as an amount', () => {
  assert.equal(formatCents(1250), '12.50')
  assert.equal(formatCents(7), '0.07')
  assert.equal(formatCents(-5), '-0.05')
})

test('halves go to the even neighbour', () => {
  assert.equal(roundHalfEven(2.5), 2)
  assert.equal(roundHalfEven(3.5), 4)
  assert.equal(roundHalfEven(-0.5), 0)
})

test('everything else rounds to the nearest', () => {
  assert.equal(roundHalfEven(2.4), 2)
  assert.equal(roundHalfEven(2.6), 3)
})

test('a split adds back up to the whole', () => {
  for (const [cents, ways] of [[1000, 3], [1, 2], [999, 4], [5, 2]]) {
    const shares = splitCents(cents, ways)
    assert.equal(shares.length, ways)
    assert.equal(shares.reduce((a, b) => a + b, 0), cents)
  }
})
