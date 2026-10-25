import assert from 'node:assert/strict'
import { formatSpread, spread } from '../harness/compaction/stats.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

console.log('a spread across draws')
{
  assert.deepEqual(spread([8, 6, 11]), { median: 8, low: 6, high: 11, draws: 3 })
  ok('an odd number of draws reports the middle, the lowest and the highest')

  assert.equal(spread([4, 8]).median, 6)
  ok('an even number of draws reports the mean of the two middle values')

  assert.equal(formatSpread([7, 7, 7]), '7')
  assert.equal(formatSpread([6, 8, 11]), '8 (6–11)')
  ok('a range is printed only when the draws disagree')

  assert.throws(() => spread([]), /at least one draw/)
  ok('no draws is not a result')
}

console.log(`\n${n} assertions passed`)
