import { useMemo, useRef, useState } from 'react'
import { useAutoSize } from './useAutoSize.js'
import type { ChatMessageView } from '@shared/types.js'
import { renderMarkdown } from '../api/markdown.js'
import { ToolCalls } from './ToolCalls.js'
import { useServerStore } from '../state/serverStore.js'
import { servedModel } from '@shared/served.js'

/**
 * One turn. Assistant content is markdown-rendered (and sanitised in
 * renderMarkdown); user content is shown as plain text, since a user typing
 * asterisks means asterisks.
 */
/**
 * Why a reply stops mid-sentence, said in full.
 *
 * The window a chat gets is the server's context divided by the number of
 * concurrent chats, which is the part nobody guesses — and a thinking model
 * spends that budget on reasoning before it writes a word, so the reply can
 * end with nothing visible at all.
 */
function RanOutOfContext({
  usage
}: {
  usage: ChatMessageView['usage']
}): React.JSX.Element {
  const limit = useServerStore((s) => servedModel(s.status, s.activeModel)?.contextPerSlot ?? null)
  const slots = useServerStore((s) => s.status?.config?.parallel ?? null)
  const used = usage ? (usage.cacheTokens ?? 0) + usage.promptTokens + usage.predictedTokens : null

  return (
    <p className="mt-2 rounded border border-amber-800 bg-amber-950/40 p-2 text-xs leading-relaxed text-amber-100">
      This reply stopped because it filled the context window
      {used && limit ? ` — ${used.toLocaleString()} of ${limit.toLocaleString()} tokens` : ''}, not
      because the model had finished.{' '}
      {slots && slots > 1 && limit
        ? `This chat gets ${limit.toLocaleString()} tokens because the server's context is shared between ${slots} concurrent chats; running fewer slots, or a larger context, gives each chat more room. `
        : 'A larger context on the Server tab gives it more room. '}
      Reasoning counts towards the same budget, so a model that thinks at length
      can use it up before writing an answer.
    </p>
  )
}

export function Message({
  message,
  streaming,
  onEdit,
  onDelete,
  onRegenerate,
  canRegenerate
}: {
  message: ChatMessageView
  streaming: boolean
  onEdit: (content: string) => void
  onDelete: () => void
  onRegenerate: () => void
  canRegenerate: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [showReasoning, setShowReasoning] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  // An edit box may hold a long message, so it is allowed more room than the
  // composer before it starts scrolling.
  useAutoSize(editRef, draft, 420)
  const isUser = message.role === 'user'

  const html = useMemo(
    () => (isUser ? '' : renderMarkdown(message.content)),
    [isUser, message.content]
  )

  const onCopy = (): void => {
    void navigator.clipboard.writeText(message.content)
  }

  /**
   * Code blocks are rendered as HTML, so their copy buttons cannot carry React
   * handlers. One delegated listener on the container handles them all, and the
   * source text travels in a data attribute so the un-highlighted original is
   * what gets copied.
   */
  const onMarkdownClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const button = (e.target as HTMLElement).closest('.code-copy')
    if (!button) return
    const block = button.closest('.code-block')
    const encoded = block?.getAttribute('data-code')
    if (!encoded) return
    void navigator.clipboard.writeText(decodeURIComponent(encoded))
    const label = button as HTMLElement
    const previous = label.textContent
    label.textContent = 'Copied'
    setTimeout(() => {
      label.textContent = previous
    }, 1200)
  }

  if (editing) {
    return (
      <div className="group px-6 py-4">
        <textarea
          ref={editRef}
          autoFocus
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full resize-y rounded-md border border-accent bg-ink p-3 text-sm outline-none"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              if (draft.trim() && draft !== message.content) onEdit(draft.trim())
            }}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink hover:brightness-110"
          >
            Save &amp; resend
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(message.content)
              setEditing(false)
            }}
            className="rounded border border-edge px-3 py-1 text-xs hover:border-accent"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`group px-6 py-4 ${isUser ? '' : 'bg-panel/40'}`}>
      <div className="mx-auto flex max-w-3xl gap-3">
        <span
          className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            isUser ? 'bg-edge text-slate-300' : 'bg-accent/20 text-accent'
          }`}
        >
          {isUser ? 'You' : 'Model'}
        </span>

        <div className="min-w-0 flex-1">
          {message.reasoning && (
            <div className="mb-2">
              <button
                type="button"
                onClick={() => setShowReasoning((v) => !v)}
                className="text-[11px] text-muted hover:text-accent"
              >
                {showReasoning ? 'Hide' : 'Show'} reasoning
              </button>
              {showReasoning && (
                <pre className="mt-1 whitespace-pre-wrap rounded border border-edge bg-ink/60 p-2 text-[11px] text-muted">
                  {message.reasoning}
                </pre>
              )}
            </div>
          )}

          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCalls calls={message.toolCalls} />
          )}

          {message.images && message.images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`Attached image ${i + 1}`}
                  className="max-h-64 rounded border border-edge object-contain"
                />
              ))}
            </div>
          )}

          {isUser ? (
            <p className="whitespace-pre-wrap break-words text-sm text-slate-100">
              {message.content}
            </p>
          ) : (
            <div
              className="markdown text-sm text-slate-100"
              onClick={onMarkdownClick}
              // Sanitised in renderMarkdown; model output is never trusted raw.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {streaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent align-text-bottom" />}

          {message.error && (
            <p className="mt-2 rounded border border-rose-800 bg-rose-950/50 p-2 text-xs text-rose-200">
              {message.error}
            </p>
          )}

          {message.ranOutOfContext && <RanOutOfContext usage={message.usage} />}

          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
            <button type="button" onClick={onCopy} className="hover:text-accent">
              Copy
            </button>
            {isUser && (
              <button type="button" onClick={() => setEditing(true)} className="hover:text-accent">
                Edit
              </button>
            )}
            {!isUser && canRegenerate && (
              <button type="button" onClick={onRegenerate} className="hover:text-accent">
                Regenerate
              </button>
            )}
            <button type="button" onClick={onDelete} className="hover:text-rose-300">
              Delete
            </button>
            <span className="ml-auto opacity-70">
              {message.stopped && <span className="mr-2 text-amber-300">stopped</span>}
              {message.tokensPerSecond && `${message.tokensPerSecond.toFixed(1)} tok/s`}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
