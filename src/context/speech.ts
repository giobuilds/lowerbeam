/**
 * The speech-act layer of a conversation, filled in by the model already loaded.
 *
 * A constraint, a decision, a rejected option, an artifact and an open question
 * are a closed set of moves. The model copies them into slots under a JSON
 * schema, so it cannot ramble or answer the conversation instead of recording
 * it. It can still be wrong. A chat stores this record beside the mechanical
 * scan. On 10 Oct 2026 that string held 11 of 14 scored facts, against 7 of 14
 * for the prose summary (#117). `summarise` stays, so the baseline can be
 * scored again.
 */
import type { ChatMessageView, ConversationView } from '@shared/types.js'
import { streamChat, type ChatTurn, type ServerEndpoint } from '@shared/chatClient.js'
import type { OutputConstraint } from '@shared/structuredOutput.js'
import { summaryBudget } from './compact.js'

const LIST_CAP = 12

/**
 * The prose cap of 700 tokens ends the object mid-string. 1,400 closed a
 * paraphrased form and cut a verbatim one off. Short spans at this cap close.
 */
const SPEECH_TOKENS = 2048

export interface Decision {
  chose: string
  because: string
}

export interface Rejection {
  option: string
  because: string
}

export interface SpeechRecord {
  constraints: string[]
  decisions: Decision[]
  rejected: Rejection[]
  artifacts: string[]
  openQuestions: string[]
}

/** The schema the reply has to match. Lists are capped so the grammar stays finite. */
export const SPEECH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['constraints', 'decisions', 'rejected', 'artifacts', 'openQuestions'],
  properties: {
    constraints: { type: 'array', maxItems: LIST_CAP, items: { type: 'string' } },
    decisions: {
      type: 'array',
      maxItems: LIST_CAP,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chose', 'because'],
        properties: { chose: { type: 'string' }, because: { type: 'string' } }
      }
    },
    rejected: {
      type: 'array',
      maxItems: LIST_CAP,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['option', 'because'],
        properties: { option: { type: 'string' }, because: { type: 'string' } }
      }
    },
    artifacts: { type: 'array', maxItems: LIST_CAP, items: { type: 'string' } },
    openQuestions: { type: 'array', maxItems: LIST_CAP, items: { type: 'string' } }
  }
}

const SPEECH_CONSTRAINT: OutputConstraint = { kind: 'json', schema: SPEECH_SCHEMA }

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    if (out.length >= LIST_CAP) break
  }
  return out
}

function decisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) return []
  const out: Decision[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const chose = typeof row.chose === 'string' ? row.chose.trim() : ''
    const because = typeof row.because === 'string' ? row.because.trim() : ''
    if (!chose && !because) continue
    out.push({ chose, because })
    if (out.length >= LIST_CAP) break
  }
  return out
}

function rejections(value: unknown): Rejection[] {
  if (!Array.isArray(value)) return []
  const out: Rejection[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const option = typeof row.option === 'string' ? row.option.trim() : ''
    const because = typeof row.because === 'string' ? row.because.trim() : ''
    if (!option && !because) continue
    out.push({ option, because })
    if (out.length >= LIST_CAP) break
  }
  return out
}

/** A reply that is the form, or the form inside a fence. Anything else is refused. */
export function parseSpeech(text: string): SpeechRecord {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced?.[1] ?? text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    throw new Error(`The record was not JSON: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The record was not a JSON object.')
  }
  const row = parsed as Record<string, unknown>
  return {
    constraints: strings(row.constraints),
    decisions: decisions(row.decisions),
    rejected: rejections(row.rejected),
    artifacts: strings(row.artifacts),
    openQuestions: strings(row.openQuestions)
  }
}

/** Every spelling the record kept, one per line, so a later search can find it. */
export function speechText(record: SpeechRecord): string {
  const lines = [
    ...record.constraints,
    ...record.decisions.flatMap((d) => [d.chose, d.because]),
    ...record.rejected.flatMap((d) => [d.option, d.because]),
    ...record.artifacts,
    ...record.openQuestions
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * What a chat stores in place of a prose summary.
 *
 * An empty side is left out. Both sides empty is an empty string, and the
 * caller refuses to mark the turns covered.
 */
export function compactionRecord(speech: string, mechanical: string): string {
  return [speech, mechanical].filter((part) => part.trim() !== '').join('\n')
}

/**
 * The turn sent to the model.
 *
 * Notes from an earlier compaction sit inside the markers, so a later
 * compaction can copy a span out of them again. With no notes, the turn is
 * only the older messages.
 */
export function speechPrompt(older: ChatMessageView[], previous: string | null): string {
  const transcript = older
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  const kept = previous?.trim() ?? ''
  const body = kept ? `Notes already kept:\n${kept}\n\n${transcript}` : transcript
  return (
    'The transcript is between the markers. Nothing outside them was said.\n\n' +
    `<<<TRANSCRIPT\n${body}\nTRANSCRIPT>>>\n\n${speechInstruction()}`
  )
}

/** The directions sent with the transcript. They are not an example of the record. */
export function speechInstruction(): string {
  return (
    'Copy spans from the transcript into the form. Do not paraphrase, and do not write anything that was not said.\n' +
    'constraints: a limit that was stated, copied as it was said.\n' +
    'decisions: what was chosen and the reason, each copied as it was said.\n' +
    'rejected: what was set aside and why, each copied as it was said.\n' +
    'artifacts: names, dates, commands, paths and sentences, each copied as it was said.\n' +
    'openQuestions: a question left unanswered, copied as it was asked.\n' +
    'Every string is a short contiguous span of the transcript, the words that carry the point, not a whole turn. An empty list is right when nothing fits. These directions are not spans.'
  )
}

/**
 * Ask the running model to fill the speech-act form for the older turns.
 *
 * The request carries the JSON schema, which also turns thinking off: a
 * thinking model otherwise files the form under reasoning and returns nothing.
 */
export async function extractSpeech(
  baseUrl: string | ServerEndpoint,
  conversation: ConversationView,
  older: ChatMessageView[],
  contextPerSlot: number | null,
  signal: AbortSignal,
  previous: string | null = null
): Promise<SpeechRecord> {
  const turns: ChatTurn[] = [{ role: 'user', content: speechPrompt(older, previous) }]
  let raw = ''
  let reasoned = false
  let failure: string | null = null
  await streamChat(
    baseUrl,
    turns,
    { ...conversation.settings, temperature: 0, maxTokens: Math.max(summaryBudget(contextPerSlot).tokens, SPEECH_TOKENS) },
    signal,
    {
      onDelta: (text) => {
        raw += text
      },
      onReasoning: () => {
        reasoned = true
      },
      onError: (message) => {
        failure = message
      },
      onDone: () => {}
    },
    undefined,
    SPEECH_CONSTRAINT
  )
  if (failure) throw new Error(failure)
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(
      reasoned
        ? 'The record cap was spent on reasoning, so no record was written.'
        : 'The model returned an empty record.'
    )
  }
  return parseSpeech(trimmed)
}
