import assert from 'node:assert/strict'
import { evictRecord, interfaceOnly, referenceCount } from '@context/evict.js'
import type { MechanicalRecord } from '@context/extract.js'
import type { SpeechRecord } from '@context/speech.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const emptyMechanical = (): MechanicalRecord => ({
  commands: [],
  paths: [],
  flags: [],
  interfaces: [],
  errors: []
})

const speech = (patch: Partial<SpeechRecord> = {}): SpeechRecord => ({
  constraints: [],
  decisions: [],
  rejected: [],
  artifacts: [],
  openQuestions: [],
  ...patch
})

console.log('a body is a derivation')
{
  const body = ['int main(void) {', '    printf("You wake in a small, dark room.");', '    if (*line == \' \') line++;', '}'].join('\n')
  assert.equal(interfaceOnly(body), 'int main(void)')
  ok('a function keeps its signature and loses the statements')
  assert.equal(interfaceOnly('#include <stdio.h>\nint main(void) { puts("hi"); }'), '#include <stdio.h>\nint main(void)')
  ok('an include on its own line stays beside the signature')
  assert.equal(interfaceOnly('We will not use SDL.'), 'We will not use SDL.')
  ok('a sentence with no body is unchanged')
}

console.log('\nwhat is never dropped')
{
  const source = 'Use Rust. We chose Rust because the binary is one file. SDL was rejected because it is another dependency.'
  const result = evictRecord({
    speech: speech({
      constraints: ['Use Rust.'],
      decisions: [{ chose: 'We chose Rust', because: 'the binary is one file' }],
      rejected: [{ option: 'SDL was rejected', because: 'it is another dependency' }],
      artifacts: ['engine.c']
    }),
    mechanical: emptyMechanical(),
    source,
    budgetChars: 40
  })
  assert.deepEqual(result.speech.constraints, ['Use Rust.'])
  assert.deepEqual(result.speech.decisions, [{ chose: 'We chose Rust', because: 'the binary is one file' }])
  assert.deepEqual(result.speech.rejected, [{ option: 'SDL was rejected', because: 'it is another dependency' }])
  ok('a constraint, a decision and a rejection stay past the budget')
  assert.deepEqual(result.speech.artifacts, [])
  ok('an artifact loses to them when the budget is already spent')
}

console.log('\nreference count, not age')
{
  const source = ['src/main/ipc.ts is the boundary.', 'Read src/main/ipc.ts again.', 'And src/main/ipc.ts once more.', 'engine.c was the sample.'].join('\n')
  assert.equal(referenceCount('src/main/ipc.ts', source), 3)
  assert.equal(referenceCount('engine.c', source), 1)
  ok('a path mentioned three times outranks one mentioned once')
  const wide = evictRecord({
    speech: speech(),
    mechanical: { ...emptyMechanical(), paths: ['notes-only.md', 'src/main/ipc.ts', 'engine.c'] },
    source,
    budgetChars: 10_000
  })
  assert.deepEqual(wide.mechanical.paths, ['src/main/ipc.ts', 'engine.c'])
  ok('a path that the turns never mention is dropped even when there is room')
  const tight = evictRecord({
    speech: speech(),
    mechanical: { ...emptyMechanical(), paths: ['engine.c', 'src/main/ipc.ts'] },
    source,
    budgetChars: 'src/main/ipc.ts'.length
  })
  assert.deepEqual(tight.mechanical.paths, ['src/main/ipc.ts'])
  ok('the budget keeps the path mentioned three times')
}

console.log('\na question stays until a decision answers it')
{
  const source = [
    'Should we use SDL for the window?',
    'We will use SDL.',
    'What pause belongs between the lines?'
  ].join('\n')
  const result = evictRecord({
    speech: speech({
      decisions: [{ chose: 'We will use SDL.', because: '' }],
      openQuestions: ['Should we use SDL for the window?', 'What pause belongs between the lines?']
    }),
    mechanical: emptyMechanical(),
    source,
    budgetChars: 20
  })
  assert.deepEqual(result.speech.openQuestions, ['What pause belongs between the lines?'])
  ok('the answered question goes and the open one stays past the budget')
  assert.ok(result.dropped.includes('Should we use SDL for the window?'))
  ok('the answered question is recorded as dropped')
}

console.log('\nthe signature replaces the body in the record')
{
  const body = 'int main(void) {\n    printf("You wake in a small, dark room.");\n}'
  const source = `${body}\nBuild engine.c next.`
  const result = evictRecord({
    speech: speech({ artifacts: [body, 'engine.c'] }),
    mechanical: emptyMechanical(),
    source,
    budgetChars: 10_000
  })
  assert.deepEqual(result.speech.artifacts, ['int main(void)', 'engine.c'])
  ok('the stored artifact is the signature, and the path stays')
  assert.equal(result.speech.artifacts.some((line) => line.includes('printf')), false)
  ok('the statement inside the body is not stored')
}

console.log(`\n${n} assertions passed`)
