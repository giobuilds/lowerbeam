import assert from 'node:assert/strict'
import {
  HELD_THIS_STEP,
  SEARCH_CLOSED,
  SEARCHES_PER_REPLY,
  partitionSearches,
  searchOpen,
  zoneSkipUrl
} from '../../src/shared/searchBudget.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

console.log('one search per step, two per reply')
{
  const calls = [
    { name: 'web_search', id: 'a' },
    { name: 'fetch_page', id: 'b' },
    { name: 'web_search', id: 'c' }
  ]
  const open = partitionSearches(calls, true)
  assert.equal(open.send?.id, 'a')
  assert.deepEqual(open.held.map((c) => c.id), ['c'])
  ok('the first search in a step is sent and the rest are held')

  const shut = partitionSearches(calls, false)
  assert.equal(shut.send, null)
  assert.equal(shut.held.length, 2)
  ok('once the reply is closed, no search is sent')

  assert.equal(searchOpen({ used: 0, limited: false }), true)
  assert.equal(searchOpen({ used: SEARCHES_PER_REPLY, limited: false }), false)
  assert.equal(searchOpen({ used: 1, limited: true }), false)
  ok('two real searches, or one rate limit, closes the reply')

  assert.match(HELD_THIS_STEP.content, /One search already ran/)
  assert.match(SEARCH_CLOSED.content, /no longer available/)
  ok('a held search tells the model not to rephrase')
}

console.log('a named site is read instead of searched')
{
  assert.equal(zoneSkipUrl('What is Lowerbeam?', 'Lowerbeam music'), null)
  ok('a question that names no site is still a search')

  assert.equal(
    zoneSkipUrl('What is Lowerbeam on Github?', 'lowerbeam podcast'),
    'https://github.com/search?q=Lowerbeam&type=repositories'
  )
  ok('GitHub in the question becomes a repository search, using the question not the rephrase')

  assert.equal(
    zoneSkipUrl('What is Lowerbeam?', 'lowerbeam github repository'),
    'https://github.com/search?q=lowerbeam%20repository&type=repositories'
  )
  ok('GitHub in the one allowed query is the same kind of read')

  assert.equal(
    zoneSkipUrl('See https://github.com/giobuilds/lowerbeam please.', 'something else'),
    'https://github.com/giobuilds/lowerbeam'
  )
  ok('a pasted address is fetched as given')

  assert.equal(zoneSkipUrl('What is Lowerbeam?', 'https://example.com/headlights'), null)
  ok('a URL only the model added is not fetched')
}

console.log(`\n${n} assertions passed`)
