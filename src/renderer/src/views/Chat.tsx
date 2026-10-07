import { useEffect, useRef, useState } from 'react'
import { activeConversation, isStreaming, useChatStore } from '../state/chatStore.js'
import { useServerStore } from '../state/serverStore.js'
import { Message } from '../components/Message.js'
import { ChatSidebar } from '../components/ChatSidebar.js'
import { ChatSettings } from '../components/ChatSettings.js'
import { ContextMeter } from '../components/ContextMeter.js'
import { CompactionMark } from '../components/CompactionMark.js'
import { Attachments } from '../components/Attachments.js'
import { useAutoSize } from '../components/useAutoSize.js'
import { SlotMeter } from '../components/SlotMeter.js'
import { servedModel } from '@shared/served.js'

export function Chat({ onConfigureTools }: { onConfigureTools: () => void }): React.JSX.Element {
  const active = useChatStore(activeConversation)
  const streaming = useChatStore((s) => (s.activeId ? isStreaming(s, s.activeId) : false))
  const streamingMessageId = useChatStore((s) =>
    s.activeId ? (s.streams[s.activeId]?.messageId ?? null) : null
  )
  const busyElsewhere = useChatStore(
    (s) => Object.keys(s.streams).filter((id) => id !== s.activeId).length
  )
  const error = useChatStore((s) => s.error)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const regenerate = useChatStore((s) => s.regenerate)
  const editUserMessage = useChatStore((s) => s.editUserMessage)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const clearError = useChatStore((s) => s.clearError)
  const load = useChatStore((s) => s.load)

  const serverPhase = useServerStore((s) => s.status?.phase ?? 'stopped')
  const ready = serverPhase === 'ready'
  // Vision comes from the running model's own /props, not from whether a
  // projector was passed — passing one is no guarantee it took effect.
  const canSeeImages = useServerStore((s) => servedModel(s.status, s.activeModel)?.modalities?.vision ?? false)

  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // Roughly ten lines; past that the composer stops growing and scrolls, so it
  // never crowds out the conversation.
  useAutoSize(composerRef, input, 220)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void load()
  }, [load])

  // Follow the stream, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.messages, streaming])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const submit = (): void => {
    if ((!input.trim() && images.length === 0) || streaming) return
    const text = input
    const attached = images
    setInput('')
    setImages([])
    stickToBottom.current = true
    void send(text, attached.length ? attached : undefined)
  }

  /**
   * Images travel inside the conversation as data URLs, so an oversized one
   * would bloat every future request that replays the history. Rejecting it
   * with a reason beats silently truncating the conversation later.
   */
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024

  const addFiles = async (files: File[]): Promise<void> => {
    const pictures = files.filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    if (!canSeeImages) {
      setAttachError('The running model cannot read images. Load a model with a projector.')
      return
    }
    const tooBig = pictures.find((f) => f.size > MAX_IMAGE_BYTES)
    if (tooBig) {
      setAttachError(`${tooBig.name} is larger than 8 MB.`)
      return
    }
    setAttachError(null)
    const encoded = await Promise.all(
      pictures.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
            reader.readAsDataURL(file)
          })
      )
    )
    setImages((current) => [...current, ...encoded])
  }

  const messages = active?.messages ?? []
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')

  return (
    <div className="flex h-full min-h-0">
      <ChatSidebar />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-edge px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {active?.title ?? 'New chat'}
          </h2>
          <ContextMeter />
          <SlotMeter />
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent"
          >
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
        </header>

        {showSettings && <ChatSettings onConfigureTools={onConfigureTools} />}

        {busyElsewhere > 0 && (
          <p className="border-b border-edge bg-ink/40 px-4 py-1.5 text-[11px] text-muted">
            {busyElsewhere} other conversation{busyElsewhere === 1 ? ' is' : 's are'} still
            generating in the background.
          </p>
        )}

        {!ready && (
          <p className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
            No model is running — start one on the <strong>Server</strong> tab to chat.
          </p>
        )}

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm text-muted">Nothing here yet.</p>
                <p className="mt-1 text-xs text-muted/70">
                  Ask something below. Shift+Enter for a new line.
                </p>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id}>
                {m.id === active?.compaction?.throughMessageId && (
                  <CompactionMark compaction={active.compaction} />
                )}
                <Message
                message={m}
                streaming={m.id === streamingMessageId}
                canRegenerate={m.id === lastAssistant?.id && !streaming}
                onEdit={(content) => void editUserMessage(m.id, content)}
                onDelete={() => void deleteMessage(m.id)}
                onRegenerate={() => void regenerate()}
                />
              </div>
            ))
          )}
        </div>

        {error && (
          <p
            onClick={clearError}
            className="cursor-pointer border-t border-rose-900 bg-rose-950/40 px-4 py-2 text-xs text-rose-200"
          >
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}

        <footer className="border-t border-edge p-3">
          <Attachments images={images} onRemove={(i) => setImages(images.filter((_, n) => n !== i))} />
          {attachError && (
            <p
              onClick={() => setAttachError(null)}
              className="mx-auto max-w-3xl cursor-pointer pb-2 text-[11px] text-amber-300"
            >
              {attachError} <span className="opacity-60">(click to dismiss)</span>
            </p>
          )}
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            {canSeeImages && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  title="Attach an image"
                  onClick={() => fileRef.current?.click()}
                  disabled={!ready || streaming}
                  className="rounded-md border border-edge px-3 py-2 text-sm text-muted
                             hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  Image
                </button>
              </>
            )}
            <textarea
              ref={composerRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files]
                if (files.length) {
                  e.preventDefault()
                  void addFiles(files)
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const files = [...e.dataTransfer.files]
                if (files.length) {
                  e.preventDefault()
                  void addFiles(files)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={
                ready
                  ? canSeeImages
                    ? 'Send a message, or paste an image…'
                    : 'Send a message…'
                  : 'Start a model to chat'
              }
              disabled={!ready}
              className="flex-1 resize-none rounded-md border border-edge bg-ink px-3 py-2
                         text-sm outline-none focus:border-accent disabled:opacity-50"
            />
            {streaming ? (
              <button
                type="button"
                onClick={() => stop()}
                className="rounded-md border border-edge px-4 py-2 text-sm hover:border-rose-500 hover:text-rose-200"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!ready || (!input.trim() && images.length === 0)}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink
                           hover:brightness-110 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}
