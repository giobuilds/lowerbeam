import { create } from 'zustand'
import type {
  ChatMessageView,
  ChatSettingsView,
  ConversationSummaryView,
  ConversationView
} from '@shared/types.js'
import { windowUsed, streamChat, type ChatTurn, type StreamedToolCall } from '@shared/chatClient.js'
import type { ServedModel, ToolCallView, ToolDefinition } from '@shared/types.js'
import { currentServed, useServerStore } from './serverStore.js'
import {
  compactableMessages,
  PREEMPT_AT,
  projectedPromptTokens,
  shouldCompact,
  summarise,
  verbatimUserMessages
} from '@context/compact.js'
import { DEFAULT_OUTPUT, outputConstraint, type OutputSetting } from '@shared/structuredOutput.js'
import { projectConversation } from '@context/project.js'

const DEFAULT_SETTINGS: ChatSettingsView = {
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: -1
}

interface ActiveStream {
  abort: AbortController
  /** The assistant message being written into. */
  messageId: string
}

/**
 * How many rounds of tool use one message may take.
 *
 * A model that searches, reads a page, then searches again is behaving
 * reasonably. One that does it twenty times is stuck, and every round costs both
 * context and time, so the loop stops and lets it answer with what it has.
 */
const MAX_TOOL_ROUNDS = 4


interface ChatState {
  conversations: ConversationSummaryView[]
  /**
   * Conversations held in memory: the visible one plus any still generating.
   * Generation must survive switching away, so a reply cannot live only in the
   * state of whichever chat happens to be on screen.
   */
  byId: Record<string, ConversationView>
  activeId: string | null
  /** Keyed by conversation id, so several chats can generate at once. */
  streams: Record<string, ActiveStream>
  /** Tools the model may call, and which of them are switched on. */
  availableTools: ToolDefinition[]
  /** Conversations currently being summarised, so the UI can say so. */
  compacting: Record<string, boolean>
  error: string | null

  load: () => Promise<void>
  loadTools: () => Promise<void>
  toggleTool: (name: string) => Promise<void>
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  send: (text: string, images?: string[]) => Promise<void>
  /** Summarise the oldest turns so the conversation keeps fitting. */
  compact: (conversationId?: string) => Promise<void>
  setAutoCompact: (enabled: boolean) => Promise<void>
  /** What replies in the active conversation must be: free text, a JSON schema, or a grammar. */
  setOutput: (patch: Partial<OutputSetting>) => Promise<void>
  /** Wait for a background compaction of this conversation, if one is running. */
  awaitCompaction: (conversationId: string) => Promise<void>
  stop: (conversationId?: string) => void
  stopAll: () => void
  flushInFlight: () => Promise<void>
  regenerate: () => Promise<void>
  editUserMessage: (id: string, content: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  setSystemPrompt: (text: string) => Promise<void>
  setSettings: (patch: Partial<ChatSettingsView>) => Promise<void>
  clearError: () => void
}

/** Title comes from the first user turn, mirroring how the built-in UI names chats. */
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New chat'
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  byId: {},
  activeId: null,
  streams: {},
  availableTools: [],
  compacting: {},
  error: null,

  async loadTools() {
    try {
      set({ availableTools: await window.llama.tools.list() })
    } catch {
      // Without tools the app simply cannot search; nothing else breaks.
    }
  },

  async toggleTool(name) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const on = conversation.tools ?? []
    const next = {
      ...conversation,
      tools: on.includes(name) ? on.filter((t) => t !== name) : [...on, name]
    }
    put(set, get, next)
    await persist(next, set, get)
  },

  async load() {
    const conversations = await window.llama.chat.list()
    set({ conversations })
    void get().loadTools()
    if (!get().activeId && conversations[0]) await get().open(conversations[0].id)
  },

  /** Switching chats never interrupts generation — the stream keeps running. */
  async open(id) {
    if (get().byId[id]) {
      set({ activeId: id, error: null })
      return
    }
    const loaded = await window.llama.chat.get(id)
    if (loaded) {
      set({ byId: { ...get().byId, [id]: loaded }, activeId: id, error: null })
    }
  },

  async create() {
    const created = await window.llama.chat.create('', activeConversation(get())?.tools ?? [])
    set({
      byId: { ...get().byId, [created.id]: created },
      activeId: created.id,
      error: null,
      conversations: await window.llama.chat.list()
    })
  },

  async remove(id) {
    get().stop(id)
    await window.llama.chat.remove(id)
    const { [id]: _removed, ...rest } = get().byId
    const conversations = await window.llama.chat.list()
    set({ byId: rest, conversations })
    if (get().activeId === id) {
      set({ activeId: null })
      const next = conversations[0]
      if (next) await get().open(next.id)
      else await get().create()
    }
  },

  async send(text, images) {
    const trimmed = text.trim()
    // An image on its own is a valid message; the model is being asked to
    // describe it.
    if (!trimmed && !images?.length) return
    let conversation = activeConversation(get())
    if (!conversation) {
      await get().create()
      conversation = activeConversation(get())
      if (!conversation) return
    }
    // One in-flight reply per conversation; a second send would race the first
    // into the same message list.
    if (get().streams[conversation.id]) return
    // A constraint that will not work is said before the message is sent, not
    // after the server has refused it.
    const output = outputConstraint(conversation.output)
    if (!output.ok) {
      set({ error: `The reply format is not usable: ${output.error}` })
      return
    }

    const userMessage: ChatMessageView = {
      id: newId(),
      role: 'user',
      content: trimmed,
      ...(images?.length ? { images } : {}),
      createdAt: Date.now()
    }
    const withUser: ConversationView = {
      ...conversation,
      title: conversation.messages.some((m) => m.role === 'user')
        ? conversation.title
        : deriveTitle(trimmed || 'Image'),
      messages: [...conversation.messages, userMessage]
    }
    put(set, get, withUser)
    await persist(withUser, set, get)

    // A background compaction may already be running from the last reply; its
    // result is exactly what this request needs, so wait for it rather than
    // sending an oversized prompt or starting a second one.
    await get().awaitCompaction(withUser.id)

    // Still too full — a single turn can jump most of the window on its own —
    // so make room now, with the user waiting.
    const limit = currentServed()?.contextPerSlot ?? null
    const latest = get().byId[withUser.id] ?? withUser
    if (shouldCompact(latest, trimmed, limit)) await get().compact(withUser.id)

    await runCompletion(withUser.id, set, get)
  },

  /**
   * Replace the oldest turns with a summary of them.
   *
   * The messages stay in the transcript — only what is sent to the model
   * changes — so nothing the user wrote is lost by this.
   */
  async compact(conversationId) {
    const id = conversationId ?? get().activeId
    if (!id) return
    // A background run may already be doing this; joining it is what stops two
    // summaries racing to set different anchors on the same conversation.
    const running = inFlight.get(id)
    if (running) return running
    const run = compactNow(id, set, get)
    inFlight.set(id, run)
    try {
      await run
    } finally {
      inFlight.delete(id)
    }
  },

  async setOutput(patch) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, output: { ...DEFAULT_OUTPUT, ...conversation.output, ...patch } }
    put(set, get, next)
    await persist(next, set, get)
  },

  async setAutoCompact(enabled) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, autoCompact: enabled }
    put(set, get, next)
    await persist(next, set, get)
  },

  async awaitCompaction(conversationId) {
    await inFlight.get(conversationId)
  },

  stop(conversationId) {
    const id = conversationId ?? get().activeId
    if (!id) return
    const stream = get().streams[id]
    if (!stream) return
    stream.abort.abort()
    // The stream's own finally-block clears the entry; doing it here too would
    // race with the completion writing its final state.
  },

  stopAll() {
    for (const stream of Object.values(get().streams)) stream.abort.abort()
  },

  /**
   * Replies are written to disk once they finish, so a quit mid-generation
   * would otherwise lose whatever had streamed so far. This flushes every
   * in-flight conversation as it stands.
   */
  async flushInFlight() {
    const { streams, byId } = get()
    await Promise.all(
      Object.keys(streams).map(async (id) => {
        const conversation = byId[id]
        if (!conversation) return
        try {
          await window.llama.chat.save(conversation)
        } catch {
          // Nothing useful to do while the window is closing.
        }
      })
    )
  },

  async regenerate() {
    const conversation = activeConversation(get())
    if (!conversation || get().streams[conversation.id]) return
    const messages = [...conversation.messages]
    while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages.pop()
    if (!messages.length) return
    const trimmed = { ...conversation, messages }
    put(set, get, trimmed)
    await persist(trimmed, set, get)
    await runCompletion(trimmed.id, set, get)
  },

  /**
   * Editing a user turn discards everything after it: the replies that followed
   * were answers to the old wording and would be misleading if kept.
   */
  async editUserMessage(id, content) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const idx = conversation.messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    get().stop(conversation.id)
    const messages = conversation.messages.slice(0, idx + 1)
    messages[idx] = { ...messages[idx]!, content }
    const next = { ...conversation, messages }
    put(set, get, next)
    await persist(next, set, get)
    await runCompletion(next.id, set, get)
  },

  async deleteMessage(id) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, messages: conversation.messages.filter((m) => m.id !== id) }
    put(set, get, next)
    await persist(next, set, get)
  },

  async setSystemPrompt(text) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, systemPrompt: text }
    put(set, get, next)
    await persist(next, set, get)
  },

  async setSettings(patch) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, settings: { ...conversation.settings, ...patch } }
    put(set, get, next)
    await persist(next, set, get)
  },

  clearError() {
    set({ error: null })
  }
}))

/** Compactions currently running, keyed by conversation. */
const inFlight = new Map<string, Promise<void>>()

async function compactNow(id: string, set: Setter, get: Getter): Promise<void> {
  {
    const conversation = get().byId[id]
    const status = useServerStore.getState().status
    if (!conversation || !status || status.phase !== 'ready' || !status.port) return

    const served = currentServed()
    const limit = served?.contextPerSlot ?? null
    const older = compactableMessages(conversation, limit)
    if (older.length === 0) return

    set({ compacting: { ...get().compacting, [id]: true } })
    try {
      const summary = await summarise(
        { url: `http://127.0.0.1:${status.port}`, apiKey: status.apiKey, model: served?.id },
        conversation,
        older,
        conversation.compaction?.summary ?? null,
        limit,
        AbortSignal.timeout(120_000)
      )
      const current = get().byId[id]
      if (!current) return
      const next: ConversationView = {
        ...current,
        compaction: {
          summary,
          throughMessageId: older[older.length - 1]!.id,
          // Carried forward with the new ones, so a request from ten turns ago
          // survives as long as it fits.
          userMessages: verbatimUserMessages(
            [
              ...(current.compaction?.userMessages ?? []).map((content) => ({
                id: '',
                role: 'user' as const,
                content,
                createdAt: 0
              })),
              ...older
            ],
            limit
          ),
          messageCount: (current.compaction?.messageCount ?? 0) + older.length,
          at: Date.now()
        }
      }
      put(set, get, next)
      await persist(next, set, get)
    } catch (err) {
      // A failed summary is not a failed conversation: say so and carry on,
      // since the request that follows may still fit.
      set({ error: `Could not compact this chat: ${(err as Error).message}` })
    } finally {
      const { [id]: _done, ...rest } = get().compacting
      set({ compacting: rest })
    }
  }
}

/**
 * Turn a stored conversation into the messages sent to the model.
 *
 * Tool output older than the most recent turn is replaced by its one-line
 * summary. The model has already answered from the full text; re-sending it on
 * every later message would fill the context with pages nobody is reading.
 */

/**
 * The one failure compaction cannot fix: a window too small for a single
 * exchange. Naming the two settings that change it beats repeating the
 * server's own "try increasing it".
 */
function contextTooSmall(limit: number | null): string {
  const size = limit ? `${limit.toLocaleString()} tokens` : 'this window'
  return (
    `Even after summarising, this conversation does not fit in ${size}. ` +
    'Raise the context size on the Server tab, or lower the number of parallel ' +
    'slots — the context is shared out between them, so 4 slots give each chat ' +
    'a quarter of it.'
  )
}

/** Arguments come from model output, so a malformed object is handled, not thrown. */
async function runToolCall(
  call: StreamedToolCall
): Promise<{ ok: boolean; summary: string; content: string; sources?: ToolCallView['sources'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = call.argumentsJson ? (JSON.parse(call.argumentsJson) as Record<string, unknown>) : {}
  } catch {
    return {
      ok: false,
      summary: `${call.name}: arguments could not be read`,
      content: 'The arguments were not valid JSON. Try the call again with simpler arguments.'
    }
  }
  try {
    return await window.llama.tools.run(call.name, args)
  } catch (err) {
    return { ok: false, summary: `${call.name} failed`, content: (err as Error).message }
  }
}

type Setter = (partial: Partial<ChatState>) => void
type Getter = () => ChatState

/** The conversation currently on screen, if any. */
export function activeConversation(state: ChatState): ConversationView | null {
  return state.activeId ? (state.byId[state.activeId] ?? null) : null
}

/** Is this conversation generating right now? */
export function isStreaming(state: ChatState, conversationId: string): boolean {
  return Boolean(state.streams[conversationId])
}

function put(set: Setter, get: Getter, conversation: ConversationView): void {
  set({ byId: { ...get().byId, [conversation.id]: conversation } })
}

async function persist(
  conversation: ConversationView,
  set: Setter,
  get: Getter
): Promise<void> {
  try {
    const saved = await window.llama.chat.save(conversation)
    put(set, get, saved)
    set({ conversations: await window.llama.chat.list() })
  } catch (err) {
    set({ error: `Could not save: ${(err as Error).message}` })
  }
}

/**
 * Streams one assistant reply into a conversation, addressed by id rather than
 * by "whatever is active" — the user may switch away mid-generation, and the
 * tokens still belong to the conversation that asked for them.
 *
 * Deltas are applied to memory as they arrive and written to disk once at the
 * end; persisting per token would be thousands of writes per reply.
 */
async function runCompletion(
  conversationId: string,
  set: Setter,
  get: Getter,
  /** Set on the retry that follows a compaction, so a failure cannot loop. */
  afterCompaction = false
): Promise<void> {
  const conversation = get().byId[conversationId]
  if (!conversation) return

  const status = useServerStore.getState().status
  if (!status || status.phase !== 'ready' || !status.port) {
    set({ error: 'Start a model on the Server tab before chatting.' })
    return
  }
  // The model this reply comes from. A router loads it first if it has to,
  // so its window and tools are known before anything is sent.
  let served: ServedModel
  try {
    set({ error: null })
    served = await window.llama.server.ensureModel(useServerStore.getState().activeModel)
  } catch (err) {
    set({ error: (err as Error).message })
    return
  }
  // Its place in the server: the slot that still holds it, or one its saved
  // state was put back into (src/main/slots.ts). One-model servers only.
  const placed = status.router ? null : await window.llama.slots.prepare(conversationId).catch(() => null)
  const baseUrl = { url: `http://127.0.0.1:${status.port}`, apiKey: status.apiKey, model: served.id, slot: placed?.slot ?? null }
  // Checked here too, since a regenerate reaches this without passing send().
  // llama.cpp does not decode under a grammar and offer tools in one request,
  // so a constrained reply is asked for without them.
  const checked = outputConstraint(conversation.output)
  if (!checked.ok) {
    set({ error: `The reply format is not usable: ${checked.error}` })
    return
  }
  const constraint = checked.constraint

  const turns = projectConversation(conversation)

  const reply: ChatMessageView = {
    id: newId(),
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  }
  const abort = new AbortController()

  put(set, get, { ...conversation, messages: [...conversation.messages, reply] })
  set({
    streams: { ...get().streams, [conversationId]: { abort, messageId: reply.id } },
    error: null
  })

  let content = ''
  let reasoning = ''
  // The prompt was already too long to send at all — a different failure from
  // a reply that runs out of room part way through, and a recoverable one.
  let promptTooLong = false
  const toolCalls: ToolCallView[] = []
  const apply = (patch: Partial<ChatMessageView>): void => {
    const current = get().byId[conversationId]
    if (!current) return
    put(set, get, {
      ...current,
      messages: current.messages.map((m) => (m.id === reply.id ? { ...m, ...patch } : m))
    })
  }

  // Only the tools the user switched on are declared, because every definition
  // is sent with every request whether or not it is used.
  const chosen = constraint ? [] : (activeConversation(get())?.tools ?? [])
  const enabled = get().availableTools.filter((t) => chosen.includes(t.name))
  const toolSpec = enabled.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let requested: StreamedToolCall[] = []
      let failed = false

      await streamChat(
        baseUrl,
        turns,
        conversation.settings ?? DEFAULT_SETTINGS,
        abort.signal,
        {
          onDelta: (text) => {
            content += text
            apply({ content })
          },
          onReasoning: (text) => {
            reasoning += text
            apply({ reasoning })
          },
          onDone: ({ tokensPerSecond, model, toolCalls: calls, usage, finishReason }) => {
            requested = calls.filter((c) => c.name)
            // The first reply after a restore says whether it helped.
            if (round === 0 && placed?.restored && usage) void window.llama.slots.report(conversationId, usage.cacheTokens).catch(() => {})
            // "length" with no max_tokens of our own means the window filled:
            // the reply is unfinished, and saying so is the difference between
            // a bug and a limit.
            const capped = (conversation.settings ?? DEFAULT_SETTINGS).maxTokens > 0
            apply({
              content,
              reasoning: reasoning || undefined,
              tokensPerSecond: tokensPerSecond ?? undefined,
              model: model ?? undefined,
              usage: usage ?? undefined,
              ranOutOfContext: (!capped && finishReason === 'length') || undefined,
              stopped: abort.signal.aborted || undefined
            })
          },
          onError: (message) => {
            failed = true
            promptTooLong = /exceed(s|_)?.{0,20}context size/i.test(message)
            if (promptTooLong && !afterCompaction) return
            apply({ content, error: message })
            set({ error: message })
          }
        },
        toolSpec.length > 0 ? toolSpec : undefined,
        constraint
      )

      if (failed || abort.signal.aborted || requested.length === 0) break

      if (round === MAX_TOOL_ROUNDS) {
        // Out of rounds: say so in the conversation rather than looping on.
        apply({ content: content || '', error: 'Stopped after too many tool calls.' })
        break
      }

      // Show the calls before running them, so a slow search is visible.
      for (const call of requested) {
        toolCalls.push({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })
      }
      apply({ toolCalls: [...toolCalls] })

      turns.push({ role: 'assistant', content, toolCalls: requested })

      for (const call of requested) {
        const result = await runToolCall(call)
        const entry = toolCalls.find((t) => t.id === call.id)
        if (entry) {
          entry.summary = result.summary
          entry.ok = result.ok
          entry.sources = result.sources
          entry.content = result.content
          entry.approxTokens = Math.ceil(result.content.length / 4)
        }
        apply({ toolCalls: [...toolCalls] })
        turns.push({ role: 'tool', toolCallId: call.id, content: result.content })
      }

      // The next round continues the same reply rather than starting a new one.
      content = ''
      reasoning = ''
    }
  } finally {
    const { [conversationId]: _done, ...remaining } = get().streams
    set({ streams: remaining })
  }

  if (promptTooLong && !afterCompaction) {
    // Drop the stub reply, summarise what will not fit, and ask again once.
    const before = get().byId[conversationId]
    if (before) {
      put(set, get, { ...before, messages: before.messages.filter((m) => m.id !== reply.id) })
    }
    await get().compact(conversationId)
    if (get().byId[conversationId]?.compaction) {
      return runCompletion(conversationId, set, get, true)
    }
    set({ error: contextTooSmall(currentServed()?.contextPerSlot ?? null) })
    return
  }

  const finished = get().byId[conversationId]
  if (!finished) return

  // Stopping before the first token leaves an empty assistant bubble, which
  // reads as the model having answered with nothing. Drop it instead.
  const produced = finished.messages.find((m) => m.id === reply.id)
  const isEmpty =
    produced && !produced.content.trim() && !produced.reasoning?.trim() && !produced.error
  const cleaned = isEmpty
    ? { ...finished, messages: finished.messages.filter((m) => m.id !== reply.id) }
    : finished

  await persist(cleaned, set, get)

  // The reply is on screen and nobody is waiting: this is the moment to make
  // room for the next one. Deliberately not awaited — the next send joins it.
  maybeCompactAhead(conversationId, get)
}

/**
 * Start summarising before the window is tight enough to matter.
 *
 * Compaction takes about as long as a short reply, and doing it here spends
 * that time while the reply that triggered it is still being read rather than
 * in front of the next question.
 */
function maybeCompactAhead(conversationId: string, get: Getter): void {
  const conversation = get().byId[conversationId]
  const limit = currentServed()?.contextPerSlot ?? null
  if (!conversation?.autoCompact || !limit) return
  if (compactableMessages(conversation, limit).length === 0) return
  if (projectedPromptTokens(conversation, '') <= limit * PREEMPT_AT) return
  void get().compact(conversationId)
}

/**
 * Leaving a long chat — opening another, starting a new one, deleting —
 * keeps its place in the server: its slot is saved, to be put back when it
 * is next used and its slot has gone to another chat. Not while it is still
 * replying: the slot is busy, and the reply is not finished.
 */
useChatStore.subscribe((state, previous) => {
  const leaving = previous.activeId
  if (!leaving || leaving === state.activeId || state.streams[leaving]) return
  const last = [...(state.byId[leaving]?.messages ?? [])].reverse().find((m) => m.usage)
  if (last?.usage) void window.llama.slots.leave(leaving, windowUsed({ ...last.usage, cacheTokens: last.usage.cacheTokens ?? 0 })).catch(() => {})
})
