import { activeConversation, useChatStore } from '../state/chatStore.js'
import { useServerStore } from '../state/serverStore.js'
import { COMPACT_AT, projectedPromptTokens } from '@context/compact.js'
import { servedModel } from '@shared/served.js'

/**
 * How much of this chat's window is spoken for.
 *
 * A conversation gets `--ctx-size` divided by `--parallel`, not the whole
 * thing, and when it runs out llama.cpp stops mid-sentence with no explanation.
 * The number is here so that ceiling is visible before it is reached.
 */
export function ContextMeter(): React.JSX.Element | null {
  const conversation = useChatStore(activeConversation)
  const compacting = useChatStore((s) => (conversation ? Boolean(s.compacting[conversation.id]) : false))
  const compact = useChatStore((s) => s.compact)
  const limit = useServerStore((s) => servedModel(s.status, s.activeModel)?.contextPerSlot ?? null)

  if (!conversation || !limit) return null

  const used = projectedPromptTokens(conversation, '')
  const share = Math.min(1, used / limit)
  const nearlyFull = share >= COMPACT_AT

  return (
    <div className="flex items-center gap-2" title={`${used.toLocaleString()} of ${limit.toLocaleString()} tokens in this conversation's context window`}>
      {compacting ? (
        <span className="text-[11px] text-amber-200">Compacting…</span>
      ) : (
        <>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ink">
            <div
              className={`h-full rounded-full ${nearlyFull ? 'bg-amber-400' : 'bg-accent'}`}
              style={{ width: `${Math.max(2, share * 100)}%` }}
            />
          </div>
          <span className={`text-[11px] ${nearlyFull ? 'text-amber-200' : 'text-muted'}`}>
            {formatTokens(used)}/{formatTokens(limit)}
          </span>
        </>
      )}
      {conversation.compaction && (
        <span
          className="text-[11px] text-muted"
          title={`${conversation.compaction.messageCount} earlier messages are represented by a summary`}
        >
          · compacted
        </span>
      )}
      {!compacting && conversation.messages.length > 4 && (
        <button
          type="button"
          onClick={() => void compact()}
          title="Summarise the earlier messages now, freeing room for more"
          className="text-[11px] text-muted hover:text-accent"
        >
          Compact
        </button>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
