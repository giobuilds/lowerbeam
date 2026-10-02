import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationMarkdown, exportFileName, matchConversation } from '@shared/chatExport.js'
import { ConversationStore } from '../../src/main/conversations.js'
import { SettingsStore } from '../../src/main/settings.js'
import type { ConversationView } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

const msg = (role: 'user' | 'assistant' | 'system', content: string, extra: object = {}) => ({ id: crypto.randomUUID(), role, content, createdAt: 0, ...extra })
const convo: ConversationView = {
  id: crypto.randomUUID(), title: 'Rivers and haiku', createdAt: Date.UTC(2026, 9, 2, 18, 5), updatedAt: 0,
  systemPrompt: 'Answer briefly.\nUse British spelling.', tools: [], settings: { temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 },
  compaction: null, autoCompact: true,
  messages: [
    msg('system', 'internal'),
    msg('user', 'Write a haiku about the river Thames.', { images: ['data:image/png;base64,AAAA'] }),
    msg('assistant', 'Grey water turning\nunder bridges, slow and old —\nLondon breathes the tide.', { model: 'ornith-9b', reasoning: 'Five, seven, five.', toolCalls: [{ id: 't', name: 'web_search', argumentsJson: '{}', summary: 'Searched "Thames" — 5 results' }] }),
    msg('assistant', 'And anoth', { stopped: true })
  ]
} as unknown as ConversationView

console.log('a conversation exports as Markdown a person can read')
{
  const md = conversationMarkdown(convo)
  assert.ok(md.startsWith('# Rivers and haiku\n')); assert.match(md, /2026-10-02 18:05 UTC/); ok('titled and dated')
  assert.ok(md.includes('> Answer briefly.\n> Use British spelling.')); ok('the system prompt quoted')
  assert.ok(md.includes('## You') && md.includes('## Model (ornith-9b)')); ok('who said what, and with which model')
  assert.ok(!md.includes('internal')); ok('system messages are not part of the transcript')
  assert.ok(md.includes('*[1 image attached]*') && !md.includes('base64')); ok('images are noted, not embedded')
  assert.ok(md.includes('<details><summary>Reasoning</summary>') && md.includes('- `web_search`: Searched "Thames" — 5 results')); ok('reasoning collapsed, tool calls one line each')
  assert.ok(md.includes('*[stopped before the end]*')); ok('a cut-off reply says so')
  assert.equal(exportFileName('A/B: "notes"?', 'md'), 'A B notes.md'); assert.equal(exportFileName('   ', 'json'), 'conversation.json'); ok('the file name is safe and never empty')
}

console.log('\nsearch matches every word, in titles and messages')
{
  assert.deepEqual(matchConversation(convo, 'HAIKU rivers'), { where: 'title', snippet: 'Rivers and haiku' }); ok('the title, in any case and order')
  const hit = matchConversation(convo, 'bridges tide')!
  assert.equal(hit.where, 'message'); assert.match(hit.snippet, /bridges/); ok('a message, with the stretch around the first word')
  assert.equal(matchConversation(convo, 'bridges volcano'), null); ok('every word has to be somewhere')
  assert.equal(matchConversation(convo, 'internal'), null); ok('system messages are not searched')
  assert.equal(matchConversation(convo, '   '), null); ok('an empty query matches nothing')
}

const dir = await mkdtemp(join(tmpdir(), 'chat-basics-'))
console.log('\nthe store searches every saved conversation')
{
  const store = new ConversationStore(join(dir, 'conversations'))
  await store.init()
  // Saving stamps updatedAt, so the one saved last is the newest.
  const b = await store.create()
  await store.save({ ...b, title: 'Cooking', messages: [msg('user', 'A recipe with river fish') as never] })
  await new Promise((r) => setTimeout(r, 5))
  const a = await store.create()
  await store.save({ ...a, title: 'Thames', messages: [msg('user', 'Tell me about the river') as never] })
  await writeFile(join(dir, 'conversations', `${crypto.randomUUID()}.json`), '{ not json')
  const hits = await store.search('river')
  assert.deepEqual(hits.map((h) => h.title), ['Thames', 'Cooking']); ok('both, newest first, and a corrupt file does not stop it')
  assert.equal(hits[1]!.where, 'message'); assert.match(hits[1]!.snippet, /river fish/); ok('each with where it matched')
  assert.deepEqual(await store.search('nothing like this'), []); ok('and nothing when nothing matches')
}

console.log('\npresets are kept in settings, validated')
{
  const settings = new SettingsStore(join(dir, 'settings.json'))
  await settings.load()
  assert.deepEqual(settings.current.promptPresets, []); ok('none to start with')
  await settings.patch({ promptPresets: [{ id: 'p1', name: 'Terse', text: 'Answer in one line.' }] })
  const reread = new SettingsStore(join(dir, 'settings.json'))
  assert.equal((await reread.load()).promptPresets[0]?.name, 'Terse'); ok('a saved preset survives a restart')
  await assert.rejects(() => settings.patch({ promptPresets: [{ id: 'p2', name: '', text: 'x' }] })); ok('a preset with no name is refused')
}

await rm(dir, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
