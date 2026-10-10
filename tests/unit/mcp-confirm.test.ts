import assert from 'node:assert/strict'
import { declinedMcpCall, isMcpTool, unconfirmedMcpCall, createMcpDecisions } from '@shared/mcpConfirm.js'
import { toolRunSchema } from '@shared/schema.js'

let n = 0
const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('which calls wait')
{
  const tools = [
    { name: 'web_search', source: 'builtin' as const },
    { name: 'notes__list', source: 'mcp' as const }
  ]
  assert.equal(isMcpTool('web_search', tools), false); ok('web search runs as soon as the model names it')
  assert.equal(isMcpTool('fetch_page', [{ name: 'fetch_page', source: 'builtin' }]), false); ok('reading a page does too')
  assert.equal(isMcpTool('notes__list', tools), true); ok('a tool from an MCP server waits')
  assert.equal(isMcpTool('notes__list', []), true); ok('a server-prefixed name still waits when the list no longer has it')
  assert.equal(isMcpTool('web_search', []), false); ok('a built-in name with no list does not')
}

console.log('what a refusal says')
{
  const declined = declinedMcpCall('notes__list')
  assert.equal(declined.ok, false)
  assert.equal(declined.summary, 'Not run')
  assert.match(declined.content, /declined the call to notes__list/); ok('the model is told the person declined, and which call')
  const blocked = unconfirmedMcpCall('notes__list')
  assert.match(blocked.content, /not confirmed/); ok('a call that skips the prompt is refused in the main process')
}

console.log('the prompt')
{
  const decisions = createMcpDecisions()
  const allow = decisions.ask('a', new AbortController().signal)
  decisions.decide('a', true)
  assert.equal(await allow, true); ok('Allow lets the call run')

  const refuse = decisions.ask('b', new AbortController().signal)
  decisions.decide('b', false)
  decisions.decide('b', true)
  assert.equal(await refuse, false); ok('Don’t run settles it, and a second click does not reopen it')

  const stop = new AbortController()
  const waiting = decisions.ask('c', stop.signal)
  stop.abort()
  assert.equal(await waiting, false); ok('stopping the reply declines the call')

  const already = new AbortController()
  already.abort()
  assert.equal(await decisions.ask('d', already.signal), false); ok('a reply that has already stopped does not ask')
}

console.log('the run request')
{
  assert.equal(toolRunSchema.parse({ name: 'web_search', args: { query: 'x' } }).confirmed, undefined); ok('a built-in call need not say it was confirmed')
  assert.equal(toolRunSchema.parse({ name: 'notes__list', args: {}, confirmed: true }).confirmed, true); ok('an allowed MCP call records that')
}

console.log(`\n${n} assertions passed`)
