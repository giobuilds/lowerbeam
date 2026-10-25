/**
 * The compaction a chat stores, in one place.
 *
 * Chat calls this. A later headless client will call the same function.
 * The transcript is not edited here: the caller keeps every message and
 * stores the record beside them. What the model is sent next is
 * `projectConversation`, which already knows how to stand the record in
 * for the turns it covers.
 */
import type { ChatMessageView, CompactionView, ConversationView } from '@shared/types.js'
import type { ServerEndpoint } from '@shared/chatClient.js'
import { compactableMessages, verbatimUserMessages } from './compact.js'
import { evictRecord, evictionBudgetChars } from './evict.js'
import { extractMechanics, mechanicalText } from './extract.js'
import { compactionRecord, extractSpeech, speechText, type SpeechRecord } from './speech.js'

/**
 * Build the record a conversation should store after one compaction.
 *
 * `speech` is whatever the loaded model copied out of the turns. The
 * mechanical scan does not ask a model. Eviction then drops what no longer
 * earns its place, and an empty result is refused so the caller does not
 * mark turns covered by nothing.
 */
export function recordFromSpeech(
  conversation: ConversationView,
  older: ChatMessageView[],
  speech: SpeechRecord,
  contextPerSlot: number | null
): CompactionView {
  const turns = older.map((m) => m.content).join('\n')
  const previous = conversation.compaction?.summary ?? null
  const kept = previous?.trim() ?? ''
  // Notes count as a source for extraction, so an old command can be seen
  // again, and not as a reference. A spelling the turns never repeat is
  // dropped, which is what keeps the record from growing without limit.
  const evicted = evictRecord({
    speech,
    mechanical: extractMechanics(kept ? `${kept}\n${turns}` : turns),
    source: turns,
    budgetChars: evictionBudgetChars(contextPerSlot)
  })
  const summary = compactionRecord(speechText(evicted.speech), mechanicalText(evicted.mechanical))
  if (!summary) throw new Error('The record was empty.')
  return {
    summary,
    throughMessageId: older[older.length - 1]!.id,
    // Carried forward with the new ones, so a request from ten turns ago
    // survives as long as it fits.
    userMessages: verbatimUserMessages(
      [
        ...(conversation.compaction?.userMessages ?? []).map((content) => ({
          id: '',
          role: 'user' as const,
          content,
          createdAt: 0
        })),
        ...older
      ],
      contextPerSlot
    ),
    messageCount: (conversation.compaction?.messageCount ?? 0) + older.length,
    at: Date.now()
  }
}

/**
 * Ask the loaded model for the speech record, then store it the way chat does.
 *
 * There is nothing to do when the recent turns already fill the share of the
 * window that compaction leaves alone. The caller decides whether that is
 * an error or a skipped turn.
 */
export async function compactConversation(
  conversation: ConversationView,
  endpoint: ServerEndpoint,
  contextPerSlot: number | null,
  signal: AbortSignal
): Promise<CompactionView | null> {
  const older = compactableMessages(conversation, contextPerSlot)
  if (older.length === 0) return null
  const speech = await extractSpeech(
    endpoint,
    conversation,
    older,
    contextPerSlot,
    signal,
    conversation.compaction?.summary ?? null
  )
  return recordFromSpeech(conversation, older, speech, contextPerSlot)
}
