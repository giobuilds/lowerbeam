import assert from 'node:assert/strict'
import { OFFLINE_MESSAGE } from '@shared/network.js'
import { NetworkGate, OfflineError } from '../../src/main/network.js'
import { FETCH_PAGE, WEB_SEARCH, runTool } from '../../src/main/tools.js'

let n = 0
const ok = (message: string, fn?: () => void): void => {
  fn?.()
  n++
  console.log('  ok', message)
}

const gate = new NetworkGate()

ok('starts online, with nothing in flight', () => {
  assert.deepEqual(gate.view(), { offline: false, active: [] })
})

{
  let during: string[] = []
  const pending = gate.reach('models', async () => {
    await gate.reach('models', async () => {
      await gate.reach('search', async () => {
        during = gate.view().active
      })
    })
    return 'done'
  })
  assert.deepEqual(gate.view().active, ['Hugging Face', 'Web search'])
  ok('a call in flight is named once, and a second kind keeps its own place')
  assert.equal(await pending, 'done')
  assert.deepEqual(during, ['Hugging Face', 'Web search'])
  assert.deepEqual(gate.view().active, [])
  ok('the badge clears when the calls settle')
}

{
  const release = gate.hold('page')
  release()
  release()
  assert.deepEqual(gate.view().active, [])
  ok('releasing a hold twice does not unbalance a later call')
}

gate.setOffline(true)
{
  let ran = false
  await assert.rejects(
    () => gate.reach('update', async () => {
      ran = true
    }),
    (err: unknown) => err instanceof OfflineError && err.message === OFFLINE_MESSAGE
  )
  assert.equal(ran, false)
  assert.deepEqual(gate.view(), { offline: true, active: [] })
  ok('an offline switch refuses the call and does not start it')
}

{
  const again = new NetworkGate()
  let stopped = 0
  again.onStop(() => {
    stopped += 1
  })
  let entered = false
  const ran = again.reach('llama', () => new Promise((resolve) => {
    entered = true
    again.setOffline(true)
    resolve('late')
  }))
  assert.equal(await ran, 'late')
  assert.equal(entered, true)
  assert.equal(stopped, 1)
  assert.equal(again.view().offline, true)
  assert.deepEqual(again.view().active, [])
  again.setOffline(true)
  assert.equal(stopped, 1)
  ok('turning the switch off stops work already running, and a second off does not stop it again')
}

gate.setOffline(false)
assert.equal(await gate.reach('update', async () => 1), 1)
assert.deepEqual(gate.view().active, [])
ok('turning the switch back on allows the next request')

{
  const off = new NetworkGate(true)
  const search = await runTool(WEB_SEARCH, { query: 'lowerbeam' }, off)
  assert.equal(search.ok, false)
  assert.match(search.content, /Offline/)
  const page = await runTool(FETCH_PAGE, { url: 'https://example.com' }, off)
  assert.equal(page.ok, false)
  assert.match(page.content, /Offline/)
  assert.deepEqual(off.view().active, [])
  ok('web search and page fetch tell the model they were refused, and do not run')
}

console.log(`\n${n} assertions passed`)
