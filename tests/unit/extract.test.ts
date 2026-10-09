import assert from 'node:assert/strict'
import { missingFacts } from '@context/answerability.js'
import { compactableMessages } from '@context/compact.js'
import { extractMechanics, mechanicalText } from '@context/extract.js'
import { loadPairs, toConversation, type KeyFact } from '../harness/compaction/load.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

console.log('recognising the shapes')
{
  const record = extractMechanics(
    [
      'Build it with `gcc -o story engine.c && ./story`.',
      '```bash',
      'gcc -o story engine.c && ./story',
      '```',
      '```c',
      '#include <stdio.h>',
      '#define PAUSE 700000',
      'int main(void) {',
      '    printf("You wake in a small, dark room.");',
      '    if (*line == \' \') { putchar(\' \'); line++; }',
      '}',
      '```',
      '```',
      'Type a command (e.g. north, quit): north',
      'You look north.',
      '```',
      'The sites were Time.now and homegpt.com, and the flag was (-ngl).',
      'SDL has a `UpdateWindow`-style call.',
      'src/main/ipc.ts(477,4): error TS1128: Declaration or statement expected'
    ].join('\n')
  )
  assert.deepEqual(record.commands, ['gcc -o story engine.c && ./story'])
  ok('a command is kept once, from a fence or from backticks')
  assert.ok(record.paths.includes('engine.c') && record.paths.includes('src/main/ipc.ts'))
  assert.ok(record.paths.includes('Time.now') && record.paths.includes('homegpt.com'))
  ok('keeps file paths and host names')
  assert.ok(record.flags.includes('-o') && record.flags.includes('-ngl'))
  assert.equal(record.flags.includes('-style'), false)
  ok('keeps flags, and a hyphenated word after a name is not one')
  assert.ok(record.interfaces.includes('#include <stdio.h>'))
  assert.ok(record.interfaces.includes('#define PAUSE 700000'))
  assert.ok(record.interfaces.includes('int main(void)'))
  assert.ok(record.interfaces.includes('You wake in a small, dark room.'))
  ok('keeps includes, macros, signatures and the strings a program prints')
  assert.equal(mechanicalText(record).includes("if (*line == ' ')"), false)
  ok('a statement in the body is not an interface')
  assert.equal(mechanicalText(record).includes('You look north.'), false)
  ok('sample output in an untagged fence is left alone')
  assert.deepEqual(record.errors, ['src/main/ipc.ts(477,4): error TS1128: Declaration or statement expected'])
  ok('keeps a compiler error and not a sentence that merely says warning')
}

console.log('\nagainst the corpus')
{
  const pairs = await loadPairs()
  const mechanical: KeyFact[] = []
  const speech: KeyFact[] = []
  let hay = ''
  for (const { corpus, key } of pairs) {
    const older = compactableMessages(toConversation(corpus), key.contextPerSlot)
    const text = mechanicalText(extractMechanics(older.map((message) => message.content).join('\n\n')))
    hay += `\n${text}`
    for (const question of key.questions) {
      for (const fact of question.facts) {
        assert.ok(fact.layer === 'mechanical' || fact.layer === 'speech', fact.id)
        if (fact.layer === 'mechanical') {
          mechanical.push(fact)
          assert.deepEqual(
            missingFacts(text, [fact]).map((item) => item.id),
            [],
            `${corpus.id}/${fact.id} was not extracted from the summarised turns`
          )
          ok(`${corpus.id}/${fact.id} is in the mechanical record`)
        } else {
          speech.push(fact)
        }
      }
    }
  }
  assert.equal(mechanical.length, 4)
  ok('four facts are mechanical, and the record keeps all four')
  // Decisions and names. A host can contain a name (HomeGPT.com); these spellings are not inside any artifact.
  for (const spelling of ["don't need SDL", 'pointer never moves', 'Claude', 'Roblox', '8th September 2026']) {
    assert.equal(hay.toLowerCase().includes(spelling.toLowerCase()), false, spelling)
  }
  ok('speech spellings are not swept up with the artifacts')
  assert.ok(speech.length > mechanical.length)
  ok('most of the questions are still speech, which this layer does not answer')
}

console.log(`\n${n} assertions passed`)
