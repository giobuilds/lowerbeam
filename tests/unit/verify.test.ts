import assert from 'node:assert/strict'
import { transcriptThrough, unsupportedLines } from '@context/verify.js'
import type { ChatMessageView } from '@shared/types.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const message = (id: string, content: string): ChatMessageView => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})

console.log('a line has to occur in the transcript')
{
  const source = 'Build it with gcc -o story engine.c.\nWe chose Rust because the binary is one file.'
  const record = ['gcc -o story engine.c', 'We chose Rust', 'the binary is one file', 'Use SDL for the window.'].join('\n')
  assert.deepEqual(unsupportedLines(record, source), ['Use SDL for the window.'])
  ok('a copied command and a copied decision pass, and a line that was never said does not')
  assert.deepEqual(unsupportedLines('\n\ngcc -o story engine.c\n', source), [])
  ok('a blank line is not a claim')
}

console.log('\nthe check stops at the message the record was built through')
{
  const messages = [
    message('a', 'Use Rust.'),
    message('b', 'We chose Rust.'),
    message('c', 'What about the pause?')
  ]
  assert.equal(transcriptThrough(messages, 'b'), 'Use Rust.\nWe chose Rust.')
  ok('turns kept verbatim after the record are not part of the check')
  assert.equal(transcriptThrough(messages, 'missing'), '')
  ok('a record whose message is gone has nothing to be checked against')
}

console.log(`\n${n} assertions passed`)
