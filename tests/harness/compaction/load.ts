/**
 * The M0 corpus and the questions asked of it.
 *
 * The corpus is what `summarise` is allowed to see. The key lives beside it,
 * not inside it: a question whose wording already appears in the transcript
 * is not a question.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationView, ToolCallView } from '@shared/types.js'

export interface CorpusTool {
  name: string
  summary: string
}

export interface CorpusMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: CorpusTool[]
}

export interface Corpus {
  id: string
  title: string
  note: string
  messages: CorpusMessage[]
}

export interface KeyFact {
  id: string
  anyOf: string[]
  /** Which role inside the summarised turns carries a spelling. */
  in: 'user' | 'assistant' | 'either'
}

export interface KeyQuestion {
  id: string
  ask: string
  facts: KeyFact[]
}

export interface HeldBack {
  id: string
  why: string
  anyOf: string[]
}

export interface AnswerKey {
  id: string
  corpus: string
  contextPerSlot: number
  questions: KeyQuestion[]
  heldBack: HeldBack[]
}

export function compactionRoot(): string {
  return join(process.cwd(), 'tests/harness/compaction')
}

export async function loadPairs(): Promise<Array<{ corpus: Corpus; key: AnswerKey }>> {
  const root = compactionRoot()
  const names = (await readdir(join(root, 'keys'))).filter((name) => name.endsWith('.json')).sort()
  const pairs = []
  for (const name of names) {
    const key = JSON.parse(await readFile(join(root, 'keys', name), 'utf8')) as AnswerKey
    const corpus = JSON.parse(await readFile(join(root, 'corpus', key.corpus), 'utf8')) as Corpus
    pairs.push({ corpus, key })
  }
  return pairs
}

const SETTINGS = {
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: -1
}

/** The shape `summarise` and `projectConversation` already take. */
export function toConversation(corpus: Corpus): ConversationView {
  return {
    id: corpus.id,
    title: corpus.title,
    createdAt: 1,
    updatedAt: 1,
    systemPrompt: '',
    messages: corpus.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: 1,
      ...(message.toolCalls?.length
        ? {
            toolCalls: message.toolCalls.map(
              (tool, index): ToolCallView => ({
                id: `${message.id}-tool-${index}`,
                name: tool.name,
                argumentsJson: '{}',
                summary: tool.summary
              })
            )
          }
        : {})
    })),
    tools: [],
    compaction: null,
    autoCompact: true,
    settings: SETTINGS
  }
}
