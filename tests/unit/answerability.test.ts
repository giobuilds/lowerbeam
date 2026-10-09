import assert from 'node:assert/strict'
import { missingFacts, type Fact } from '@context/answerability.js'
import { compactableMessages, verbatimUserMessages } from '@context/compact.js'
import { loadPairs, toConversation } from '../harness/compaction/load.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const has = (text: string, spelling: string) => text.toLowerCase().includes(spelling.toLowerCase())

console.log('scoring spellings')
{
  const command: Fact = { id: 'cmd', anyOf: ['gcc -o story engine.c'] }
  const empty: Fact = { id: 'empty', anyOf: [] }
  assert.deepEqual(
    missingFacts('use GCC -o story engine.c && ./story', [command, empty]).map((fact) => fact.id),
    ['empty']
  )
  ok('hits ignoring case, and an empty spelling list is a miss')

  assert.deepEqual(missingFacts('compile it with gcc', [command]).map((fact) => fact.id), ['cmd'])
  ok('a paraphrase that drops the command is a miss')
}

console.log('\ngrounding the corpus')
const pairs = await loadPairs()
assert.ok(pairs.length >= 2)
ok('loads a key beside each conversation')

for (const { corpus, key } of pairs) {
  assert.equal(corpus.id, key.id)
  assert.equal(key.contextPerSlot, 7424)
  const conversation = toConversation(corpus)
  const older = compactableMessages(conversation, key.contextPerSlot)
  assert.ok(older.length > 0 && older.length < conversation.messages.length, corpus.id)
  const recent = conversation.messages.slice(older.length)
  const fileText = JSON.stringify(corpus).toLowerCase()
  const byRole = {
    user: older.filter((message) => message.role === 'user').map((message) => message.content).join('\n'),
    assistant: older
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n'),
    either: older.map((message) => message.content).join('\n')
  }
  const recentText = recent.map((message) => message.content).join('\n')
  const verbatim = verbatimUserMessages(older, key.contextPerSlot).join('\n')

  for (const question of key.questions) {
    assert.equal(fileText.includes(question.ask.toLowerCase()), false, question.ask)
    ok(`${corpus.id}/${question.id} is not a substring of the corpus`)
    for (const fact of question.facts) {
      assert.ok(fact.anyOf.length > 0 && fact.anyOf.every((spelling) => spelling.length > 0))
      for (const spelling of fact.anyOf) {
        assert.equal(fileText.includes(spelling.toLowerCase()), true, `${fact.id} ${spelling}`)
      }
      ok(`${corpus.id}/${fact.id} is spelled the way the transcript spells it`)
      assert.equal(
        fact.anyOf.some((spelling) => has(byRole[fact.in], spelling)),
        true,
        `${fact.id} is not in the ${fact.in} turns a summary replaces`
      )
      ok(`${corpus.id}/${fact.id} falls inside the summarised turns`)
      if (fact.in === 'user') {
        assert.equal(
          fact.anyOf.some((spelling) => has(verbatim, spelling)),
          true,
          `${fact.id} was dropped from the verbatim user lines`
        )
        ok(`${corpus.id}/${fact.id} is kept word for word with the summary`)
      }
    }
  }

  for (const held of key.heldBack) {
    assert.equal(held.anyOf.some((spelling) => has(recentText, spelling)), true, held.id)
    assert.equal(
      held.anyOf.every((spelling) => !has(byRole.either, spelling)),
      true,
      `${held.id} is inside the summarised turns`
    )
    ok(`${corpus.id}/${held.id} stays in the kept tail, so it is not scored`)
  }
}

console.log(`\n${n} assertions passed`)
