import { useEffect, useState } from 'react'
import type { ConversationSearchHitView, ConversationSummaryView } from '@shared/types.js'
import { useChatStore } from '../state/chatStore.js'

const when = (ts: number): string => {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ChatSidebar(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  // Conversations generating in the background get a live indicator, so work
  // continuing off-screen is visible rather than silent.
  const streamingIds = useChatStore((s) => Object.keys(s.streams).join(','))
  const streaming = new Set(streamingIds ? streamingIds.split(',') : [])
  const open = useChatStore((s) => s.open)
  const create = useChatStore((s) => s.create)
  const remove = useChatStore((s) => s.remove)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ConversationSearchHitView[] | null>(null)

  // Searched once typing pauses: it reads every conversation on disk.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    const timer = setTimeout(() => {
      void window.llama.chat.search(query).then(setHits, () => setHits([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const shown: Array<ConversationSummaryView & Partial<Pick<ConversationSearchHitView, 'where' | 'snippet'>>> = hits ?? conversations

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-panel">
      <div className="p-2">
        <button
          type="button"
          onClick={() => void create()}
          className="w-full rounded-md border border-edge px-3 py-1.5 text-xs hover:border-accent hover:text-accent"
        >
          + New chat
        </button>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder="Search chats"
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-edge bg-ink px-2.5 py-1 text-xs outline-none focus:border-accent"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {conversations.length === 0 && !hits && (
          <li className="px-3 py-2 text-[11px] text-muted">No conversations yet.</li>
        )}
        {hits && hits.length === 0 && (
          <li className="px-3 py-2 text-[11px] text-muted">No chat contains that.</li>
        )}
        {shown.map((c) => (
          <li key={c.id} className="group relative">
            <button
              type="button"
              onClick={() => void open(c.id)}
              className={`w-full px-3 py-2 text-left hover:bg-ink/60 ${
                c.id === activeId ? 'bg-ink/80' : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                {streaming.has(c.id) && (
                  <span
                    title="Generating"
                    className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-slate-100">{c.title}</span>
                <span className="shrink-0 text-[10px] text-muted">{when(c.updatedAt)}</span>
              </div>
              {c.where === 'message' && c.snippet ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-300">{c.snippet}</p>
              ) : (
                c.preview && <p className="mt-0.5 truncate text-[11px] text-muted">{c.preview}</p>
              )}
            </button>
            <button
              type="button"
              title="Delete conversation"
              onClick={() => void remove(c.id)}
              className="absolute right-1 top-1 hidden rounded px-1.5 text-[11px] text-muted
                         hover:text-rose-300 group-hover:block"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
