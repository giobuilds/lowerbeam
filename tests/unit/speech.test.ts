import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { missingFacts } from '@context/answerability.js'
import { extractSpeech, parseSpeech, speechText } from '@context/speech.js'
import type { ChatMessageView, ConversationView } from '@shared/types.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const msg = (role: ChatMessageView['role'], content: string): ChatMessageView => ({
  id: `${role}-${n}`,
  role,
  content,
  createdAt: 1
})

const chat = (messages: ChatMessageView[]): ConversationView => ({
  id: 'c1',
  title: 't',
  createdAt: 1,
  updatedAt: 1,
  systemPrompt: '',
  messages,
  tools: [],
  compaction: null,
  autoCompact: true,
  settings: { temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }
})

console.log('reading a record')
{
  const record = parseSpeech(
    '```json\n{"constraints":[" Fedora "],"decisions":[{"chose":"plain C","because":"don\'t need SDL"}],"rejected":[{"option":"","because":""}],"artifacts":["gcc -o story engine.c","gcc -o story engine.c"],"openQuestions":[]}\n```'
  )
  assert.deepEqual(record.constraints, ['Fedora'])
  assert.deepEqual(record.decisions, [{ chose: 'plain C', because: "don't need SDL" }])
  assert.deepEqual(record.rejected, [])
  assert.deepEqual(record.artifacts, ['gcc -o story engine.c'])
  ok('a fenced form is kept, blanks dropped, and a repeated artifact kept once')

  const text = speechText(record)
  assert.equal(missingFacts(text, [{ id: 'sdl', anyOf: ["don't need SDL"] }]).length, 0)
  assert.equal(missingFacts(text, [{ id: 'cmd', anyOf: ['gcc -o story engine.c'] }]).length, 0)
  ok('the rendered record still contains the transcript spellings')

  assert.throws(() => parseSpeech('We decided to use plain C.'), /not JSON/)
  ok('prose is not a record')
}

console.log('\nfilling the form on a server')
{
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const fixture = new URL('../fixtures/fake-llama.mjs', import.meta.url).pathname
  const child: ChildProcess = spawn(process.execPath, [fixture, '--port', String(port), '--model', 'fake.gguf'], {
    env: { ...process.env, FAKE_LOAD_MS: '20' },
    stdio: 'ignore'
  })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const health = await fetch(`${base}/health`)
        if (health.ok) break
      } catch {
        /* still starting */
      }
      if (i === 49) throw new Error('fake llama never became ready')
      await new Promise((r) => setTimeout(r, 20))
    }
    const older = [msg('user', 'Skip the graphics library.'), msg('assistant', "We don't need SDL. Build with gcc -o story engine.c.")]
    const record = await extractSpeech(base, chat(older), older, 7424, AbortSignal.timeout(5000))
    assert.equal(speechText(record).includes("don't need SDL"), true)
    assert.equal(speechText(record).includes('gcc -o story engine.c'), true)
    ok('a schema request stores the form instead of a paragraph')
  } finally {
    child.kill('SIGKILL')
  }
}

console.log(`\n${n} assertions passed`)
