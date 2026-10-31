import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_TOOLS, WRITE_TOOLS } from '../../src/agent/tools.js'
import { RUN_COMMAND_TOOL, runTask } from '../../src/agent/loop.js'
import { FIND_TOOL } from '../../src/agent/find.js'
import { REPO_MAP_TOOL } from '../../src/agent/repoMap.js'
import { buildToolGrammar, grammarFixture, parseTextToolCall, renderToolPrompt } from '../../src/agent/textTools.js'
import { Grant } from '../../src/agent/grant.js'
import { checkGrammar } from '@shared/structuredOutput.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}
const settings = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }
const tools = [...AGENT_TOOLS, ...WRITE_TOOLS, RUN_COMMAND_TOOL, REPO_MAP_TOOL, FIND_TOOL]

console.log('a grammar and a parser for every built-in tool')
{
  const grammar = buildToolGrammar(tools)
  assert.equal(checkGrammar(grammar).ok, true)
  ok('the grammar has a root rule and balanced quotes')
  assert.match(renderToolPrompt(tools), /```tool/)
  ok('the prompt shows one fenced call')
  for (const tool of tools) {
    const args: Record<string, unknown> = {}
    for (const key of tool.parameters.required ?? []) {
      const type = tool.parameters.properties[key]?.type
      args[key] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : 'src/a.ts'
    }
    const reply = '```tool\n' + JSON.stringify({ name: tool.name, arguments: args }) + '\n```'
    assert.equal(grammarFixture(grammar, reply, tools), 'call')
    const parsed = parseTextToolCall(reply, tools)
    assert.equal(parsed.kind, 'call')
    if (parsed.kind === 'call') assert.equal(parsed.call.name, tool.name)
  }
  ok('every built-in tool round-trips, and the grammar names it')
  assert.equal(grammarFixture(grammar, '```tool\n{"name":"nope","arguments":{}}\n```', tools), 'reject')
  ok('an unknown tool name is rejected')
  assert.equal(parseTextToolCall('```tool\n{"name":"read","arguments":{}}\n```', tools).kind, 'invalid')
  ok('a missing required argument is rejected')
  const answer = parseTextToolCall('The function is greet, in src/a.ts.', tools)
  assert.equal(answer.kind, 'answer')
  assert.equal(grammarFixture(grammar, 'The function is greet, in src/a.ts.', tools), 'final')
  ok('prose with no tool block is a final answer')
}

console.log('\na text-mode run reads a file and answers')
{
  const root = await mkdtemp(join(tmpdir(), 'text-tools-'))
  await writeFile(join(root, 'a.ts'), 'export const hi = 1\n')
  const bodies: Array<{ tools?: unknown; grammar?: string; messages: Array<{ role: string; content: string }> }> = []
  let step = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      step += 1
      const content = step === 1
        ? '```tool\n{"name":"read","arguments":{"path":"a.ts"}}\n```'
        : 'a.ts exports hi.'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 30, predicted_n: 12, cache_n: 0 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const result = await runTask({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'm',
    task: 'What does a.ts export?',
    grant: await Grant.open(root),
    settings,
    toolFormat: 'text',
    onEvent: () => undefined
  })
  assert.equal(bodies[0]?.tools, undefined)
  assert.equal(typeof bodies[0]?.grammar, 'string')
  ok('text mode sends a grammar and no tools field')
  assert.match(bodies[1]?.messages.at(-1)?.content ?? '', /Tool read returned/)
  ok('the tool result comes back as a plain message')
  assert.equal(result.outcome, 'answered')
  assert.match(result.answer, /hi/)
  ok('the run finishes the read-only task')
  server.close()
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
