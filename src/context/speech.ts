/**
 * The speech-act layer of a conversation, filled in by the model already loaded.
 *
 * A constraint, a decision, a rejected option, an artifact and an open question
 * are a closed set of moves. The model copies them into slots under a JSON
 * schema, so it cannot ramble or answer the conversation instead of recording
 * it. It can still be wrong. This does not replace the prose summary: that
 * waits on a score against the M0 baseline (#117).
 */
import type { ChatMessageView, ConversationView } from '@shared/types.js'
import { streamChat, type ChatTurn, type ServerEndpoint } from '@shared/chatClient.js'
import type { OutputConstraint } from '@shared/structuredOutput.js'
import { summaryBudget } from './compact.js'

const LIST_CAP = 12

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

function instruction(): string {
  return (
    'Fill the form from the transcript only, using its own wording.\n' +
    'constraints: a limit someone in the transcript stated.\n' +
    'decisions: a choice and the reason given for it.\n' +
    'rejected: an option that was set aside, and why.\n' +
    'artifacts: a command, path, signature or sentence copied from the transcript.\n' +
    'openQuestions: a question the transcript leaves unanswered.\n' +
    'An empty list is fine. These directions are not part of the transcript.'
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
  signal: AbortSignal
): Promise<SpeechRecord> {
  const transcript = older
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  const turns: ChatTurn[] = [
    {
      role: 'user',
      content:
        'The transcript is between the markers. Nothing outside them was said.\n\n' +
        `<<<TRANSCRIPT\n${transcript}\nTRANSCRIPT>>>\n\n${instruction()}`
    }
  ]
  let raw = ''
  let reasoned = false
  let failure: string | null = null
  await streamChat(
    baseUrl,
    turns,
    // The prose cap is 700 tokens, which ends a JSON object mid-string. The
    // form has to close, and the lists are already capped at twelve.
    { ...conversation.settings, temperature: 0, maxTokens: Math.max(summaryBudget(contextPerSlot).tokens, 1400) },
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
