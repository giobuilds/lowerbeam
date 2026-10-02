import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkGrammar, checkSchema, constraintFields, outputConstraint } from '@shared/structuredOutput.js'
import { streamChat } from '@shared/chatClient.js'
import { conversationSchema } from '../../src/main/conversations.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('a JSON schema is checked before it is used')
{
  assert.ok(checkSchema('{"type":"object","properties":{"answer":{"type":"string"}}}').ok); ok('a schema with a type and properties')
  assert.ok(checkSchema('{"enum":["red","green"]}').ok); ok('an enum alone')
  const broken = checkSchema('{"type": "object",}')
  assert.ok(!broken.ok && /Not valid JSON/.test(broken.error)); ok('broken JSON says so')
  assert.ok(!checkSchema('[1,2]').ok && !checkSchema('"x"').ok); ok('an array or a string is not a schema')
  const empty = checkSchema('{"title":"nothing"}')
  assert.ok(!empty.ok && /does not describe anything/.test(empty.error)); ok('an object that constrains nothing is refused')
  const bad = checkSchema('{"type":"text"}')
  assert.ok(!bad.ok && /"text" is not a JSON Schema type/.test(bad.error)); ok('an unknown type is named')
  assert.ok(!checkSchema('  ').ok); ok('an empty schema is refused')
}

console.log('\na GBNF grammar is checked for what is easy to get wrong')
{
  assert.ok(checkGrammar('root ::= "yes" | "no"').ok); ok('a one-rule grammar')
  assert.ok(checkGrammar('root ::= item+\nitem ::= [a-z]+ ("," | "\\n")\n# a comment with a " quote').ok); ok('rules, classes, groups, escapes and comments')
  const noRoot = checkGrammar('answer ::= "yes"')
  assert.ok(!noRoot.ok && /rule called root/.test(noRoot.error)); ok('without a root rule it says so')
  assert.ok(!checkGrammar('root ::= "yes').ok); ok('an unclosed string')
  assert.ok(!checkGrammar('root ::= ("a" | "b"').ok); ok('an unclosed group')
  assert.ok(!checkGrammar('root ::= [a-z').ok); ok('an unclosed class')
  assert.ok(checkGrammar('root ::= "say \\"hi\\""').ok); ok('an escaped quote inside a string is not the end of it')
}

console.log('\na setting becomes request fields, or nothing')
{
  assert.deepEqual(outputConstraint({ mode: 'text', schema: 'junk', grammar: 'junk' }), { ok: true, constraint: null }); ok('free text ignores whatever text is kept')
  assert.ok(!outputConstraint({ mode: 'json', schema: '{', grammar: '' }).ok); ok('an invalid chosen constraint is an error')
  const json = outputConstraint({ mode: 'json', schema: '{"type":"string"}', grammar: '' })
  assert.ok(json.ok && json.constraint)
  const off = { chat_template_kwargs: { enable_thinking: false } }
  assert.deepEqual(constraintFields(json.constraint), { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: { type: 'string' } } }, ...off }); ok('a schema goes as OpenAI\u2019s response_format')
  assert.deepEqual(constraintFields({ kind: 'grammar', grammar: 'root ::= "a"' }), { grammar: 'root ::= "a"', ...off }); ok('a grammar as llama-server\u2019s grammar field')
  ok('both with thinking off, or a thinking model files the reply under reasoning')
  assert.deepEqual(constraintFields(null), {}); ok('free text adds nothing')
  assert.equal(conversationSchema.parse({ id: 'x', title: 't', createdAt: 0, updatedAt: 0 }).output.mode, 'text'); ok('a conversation saved before this is free text')
}

console.log('\nthe request carries it')
{
  let body: Record<string, unknown> = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      body = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"yes"}' }, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let content = ''
  await streamChat(url, [{ role: 'user', content: 'q' }], { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }, AbortSignal.timeout(5000),
    { onDelta: (t) => (content += t), onReasoning: () => {}, onDone: () => {}, onError: (e) => assert.fail(e) }, undefined, { kind: 'grammar', grammar: 'root ::= "yes"' })
  assert.equal(body.grammar, 'root ::= "yes"'); assert.ok(!('tools' in body)); ok('the grammar is in the request body')
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false }); ok('with thinking turned off')
  assert.equal(content, '{"answer":"yes"}'); ok('and the reply streams as usual')
  server.close()
}

console.log(`\n${n} assertions passed`)
