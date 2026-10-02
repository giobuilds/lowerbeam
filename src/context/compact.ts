/**
 * Keeping a conversation inside the window it has.
 *
 * A chat gets one slot's worth of context — `--ctx-size` divided by
 * `--parallel` — and when it fills, llama.cpp stops mid-sentence rather than
 * forgetting anything. Compaction trades the oldest turns for a summary of
 * them, which is the only way to keep talking without either losing the thread
 * or restarting the chat.
 *
 * The messages are never deleted: the transcript still shows everything, and
 * only what is *sent* changes.
 */
import type { ChatMessageView, ConversationView } from '@shared/types.js'
import { streamChat, type ChatTurn, type ServerEndpoint } from '@shared/chatClient.js'

/**
 * Compact once the next request would use this much of the window.
 *
 * This is the late threshold, checked with the user waiting. Crossing
 * PREEMPT_AT starts the same work in the background instead, so in practice
 * this one only fires when a single turn jumps most of the way on its own.
 */
export const COMPACT_AT = 0.75

/**
 * Start summarising in the background once a reply leaves the chat this full.
 *
 * Summarising costs about as long as a short reply — measured at 22s for a 9B
 * over 1,800 tokens — and none of that is worth making anyone wait for. Done
 * here, it runs while the reply that triggered it is still being read.
 */
export const PREEMPT_AT = 0.6

/** Turns kept verbatim after a compaction, so recent context stays exact. */
export const KEEP_RECENT_TURNS = 4

/**
 * How much of the window those kept turns may occupy.
 *
 * Four turns is the right number in a roomy window and far too many in a small
 * one: a chat with 1,024 tokens and a model that writes 900-token replies can
 * keep exactly one. Keeping a fixed count there summarises almost nothing and
 * the next request fails anyway.
 */
const KEEP_RECENT_SHARE = 0.35

/**
 * A summary has to fit too, so its length follows the window rather than a constant.
 *
 * The word target is deliberately well under what the token cap allows: asked
 * for as many words as would just fit, a model writes to the cap and gets cut
 * off mid-sentence, which is how the first version of this ended.
 */
export function summaryBudget(contextPerSlot: number | null): { tokens: number; words: number } {
  const tokens = Math.max(120, Math.min(700, Math.round((contextPerSlot ?? 4096) * 0.15)))
  return { tokens, words: Math.round(tokens * 0.45) }
}

/**
 * What the user themselves said, kept word for word.
 *
 * Their turns are short and carry the requests the whole conversation is
 * about, so they are the worst thing to paraphrase and the cheapest to keep.
 * Only as many as fit the budget, newest first — an older request that no
 * longer fits is still represented in the summary.
 */
export function verbatimUserMessages(
  older: ChatMessageView[],
  contextPerSlot: number | null
): string[] {
  const budget = (contextPerSlot ?? 4096) * VERBATIM_SHARE
  const kept: string[] = []
  let used = 0
  for (const m of [...older].reverse()) {
    if (m.role !== 'user' || !m.content.trim()) continue
    const cost = roughTokens(m.content)
    if (used + cost > budget) break
    used += cost
    kept.unshift(m.content.trim())
  }
  return kept
}

/** How much of the window the user's own words may take. */
const VERBATIM_SHARE = 0.1

/**
 * Tokens the next request will need, from what the server counted last time.
 *
 * Grounded in the server's own numbers rather than a characters-over-four
 * guess: the last request's prompt plus what it generated is exactly what the
 * next prompt will contain, give or take the new message.
 */
export function projectedPromptTokens(conversation: ConversationView, pending: string): number {
  const withUsage = [...conversation.messages].reverse().find((m) => m.usage)
  // Cached prefix plus what was processed plus what was written: the whole
  // window, not the part the server happened to work on this time.
  const measured = withUsage?.usage
    ? (withUsage.usage.cacheTokens ?? 0) + withUsage.usage.promptTokens + withUsage.usage.predictedTokens
    : null
  if (measured === null) return estimateTokens(conversation)
  // Anything after the measured turn has not been through the server yet.
  const index = conversation.messages.indexOf(withUsage!)
  const since = conversation.messages
    .slice(index + 1)
    .reduce((n, m) => n + roughTokens(m.content), 0)
  return measured + since + roughTokens(pending)
}

/** Only used before the first reply, when the server has counted nothing yet. */
function estimateTokens(conversation: ConversationView): number {
  return (
    roughTokens(conversation.systemPrompt) +
    conversation.messages.reduce((n, m) => n + roughTokens(m.content), 0)
  )
}

/** Four characters to a token is wrong in detail and close enough in aggregate. */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Whether the next message should be preceded by a compaction. */
export function shouldCompact(
  conversation: ConversationView,
  pending: string,
  contextPerSlot: number | null
): boolean {
  if (!conversation.autoCompact || !contextPerSlot) return false
  if (compactableMessages(conversation, contextPerSlot).length === 0) return false
  return projectedPromptTokens(conversation, pending) > contextPerSlot * COMPACT_AT
}

/**
 * The messages a summary would replace: everything before the last few turns,
 * and nothing already covered by an earlier summary.
 */
export function compactableMessages(
  conversation: ConversationView,
  contextPerSlot: number | null = null
): ChatMessageView[] {
  const covered = conversation.compaction
    ? conversation.messages.findIndex((m) => m.id === conversation.compaction!.throughMessageId)
    : -1
  const candidates = conversation.messages.slice(covered + 1)

  // Walk back from the newest, keeping turns while they still fit the share of
  // the window reserved for them. At least one is always kept: the message
  // being answered cannot be summarised away.
  const budget = contextPerSlot ? contextPerSlot * KEEP_RECENT_SHARE : Number.POSITIVE_INFINITY
  let kept = 0
  let used = 0
  for (let i = candidates.length - 1; i >= 0 && kept < KEEP_RECENT_TURNS; i--) {
    used += roughTokens(candidates[i]!.content)
    if (used > budget && kept > 0) break
    kept += 1
  }
  return candidates.slice(0, candidates.length - kept)
}

function instruction(words: number, userKept: boolean): string {
  return (
    'Summarise the conversation so far for your own use as notes. Keep decisions, ' +
    'facts, names, code and conclusions; drop pleasantries and repetition. ' +
    (userKept
      ? "The user's own messages are being kept word for word alongside these " +
        'notes, so cover what was worked out in reply to them rather than ' +
        'restating the questions. '
      : '') +
    `Write it as compact prose in the third person. Aim for ${words} words and ` +
    'finish your last sentence. Reply with the summary only.'
  )
}

/**
 * A summary cut off by the token cap ends mid-sentence, which reads as damage
 * in the transcript and is worse than a shorter summary. Trim back to the last
 * complete sentence — unless that would throw away most of it, in which case
 * the truncated text is still the more useful of the two.
 */
export function trimToLastSentence(text: string): string {
  const end = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'), text.lastIndexOf('! '),
    text.lastIndexOf('? '), text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'))
  if (end < 0) return text
  const trimmed = text.slice(0, end + 1).trimEnd()
  return trimmed.length >= text.length * 0.7 ? trimmed : text
}

/**
 * Ask the running model to summarise its own older turns.
 *
 * Done with the same server and no tools: it is a plain generation, and using a
 * second model to summarise would need a second model loaded.
 */
export async function summarise(
  baseUrl: string | ServerEndpoint,
  conversation: ConversationView,
  older: ChatMessageView[],
  previous: string | null,
  contextPerSlot: number | null,
  signal: AbortSignal
): Promise<string> {
  const budget = summaryBudget(contextPerSlot)
  const userKept = verbatimUserMessages(older, contextPerSlot).length > 0
  const transcript = older
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const turns: ChatTurn[] = [
    {
      role: 'user',
      content:
        (previous ? `Notes from earlier still to be carried forward:\n\n${previous}\n\n---\n\n` : '') +
        `${transcript}\n\n---\n\n${instruction(budget.words, userKept)}`
    }
  ]

  let summary = ''
  let failure: string | null = null
  let cutOff = false
  await streamChat(
    baseUrl,
    turns,
    // Low temperature: this is a record, not a performance.
    { ...conversation.settings, temperature: 0.3, maxTokens: budget.tokens },
    signal,
    {
      onDelta: (text) => {
        summary += text
      },
      onDone: ({ finishReason }) => {
        cutOff = finishReason === 'length'
      },
      onError: (message) => {
        failure = message
      }
    }
  )
  if (failure) throw new Error(failure)
  const trimmed = summary.trim()
  if (!trimmed) throw new Error('The model returned an empty summary.')
  return cutOff ? trimToLastSentence(trimmed) : trimmed
}
