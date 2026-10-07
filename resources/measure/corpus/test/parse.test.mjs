import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { parseLine, parseLog, toCents } from '../src/parse.js'

test('amounts become whole cents', () => {
  assert.equal(toCents('12.50'), 1250)
  assert.equal(toCents('0.10'), 10)
  assert.equal(toCents('7'), 700)
  assert.equal(toCents('-3.05'), -305)
})

test('refuses what is not an amount', () => {
  assert.throws(() => toCents('12.505'))
  assert.throws(() => toCents('twelve'))
})

test('a line becomes an entry with a normalised category', () => {
  assert.deepEqual(parseLine('2026-01-03, Groceries , 12.50'), { date: '2026-01-03', category: 'groceries', cents: 1250 })
})

test('blank lines and comments are skipped', () => {
  assert.equal(parseLine('   '), null)
  assert.equal(parseLine('# January'), null)
  assert.equal(parseLog('# a\n2026-01-03, rent, 900\n\n2026-01-04, bus, 2.40\n').length, 2)
})

test('a date not in ISO form is refused', () => {
  assert.throws(() => parseLine('3/1/2026, rent, 900'))
})
