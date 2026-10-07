import { constraintFields, type OutputConstraint } from './structuredOutput.js'
import type { ChatSettingsView } from '@shared/types.js'

/**
 * Streams a completion from llama-server.
 *
 * Shared rather than renderer-only because it has no renderer in it: an HTTP
 * request to loopback and a parser for the stream that comes back. The
 * renderer calls it directly — routing every token through IPC would serialise
 * each one across a process boundary for no benefit — and the agent worker
 * calls the same function from Node, so the two never drift apart in how they
 * assemble a tool call or count a token.
 */

/** A tool call assembled from the stream's fragments. */
export interface StreamedToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  /** Reasoning models emit thinking separately from the answer. */
  onReasoning?: (text: string) => void
  onDone: (info: {
    tokensPerSecond: number | null
    model: string | null
    toolCalls: StreamedToolCall[]
    /** The server's own token counts for this request, when it reported them. */
    usage: TokenUsage | null
    /**
     * Why generation ended. 'length' means it ran out of room — either the
     * caller's max_tokens or, with none set, the context window itself.
     */
    finishReason: string | null
  }) => void
  onError: (message: string) => void
}

/**
 * The server's own counts for one request.
 *
 * `promptTokens` is what the server had to process, not what the prompt
 * contained: the prefix it already had in cache is reported separately as
 * `cacheTokens`. What the window holds after the request is the sum of all
 * three, and anything that reads only the first is wrong on every follow-up
 * turn — which is how a context meter came to say 146 of 1,024 on a
 * conversation that had just filled its window.
 */
export interface TokenUsage {
  promptTokens: number
  predictedTokens: number
  cacheTokens: number
}

/** Tokens in the window once this request is done. */
export function windowUsed(u: TokenUsage): number {
  return u.cacheTokens + u.promptTokens + u.predictedTokens
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Data URLs; only meaningful on a user turn against a vision model. */
  images?: string[]
  /** Set on an assistant turn that called tools. */
  toolCalls?: StreamedToolCall[]
  /** Set on a tool turn, tying the result to the call that asked for it. */
  toolCallId?: string
}

/**
 * llama.cpp accepts the OpenAI content-part shape, so a turn with images
 * becomes an array of parts rather than a bare string. Text-only turns stay
 * strings, which keeps requests identical to before for non-vision models.
 */
function encodeTurn(turn: ChatTurn): Record<string, unknown> {
  if (turn.role === 'tool') {
    return { role: 'tool', tool_call_id: turn.toolCallId, content: turn.content }
  }
  if (turn.toolCalls?.length) {
    return {
      role: turn.role,
      content: turn.content,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.argumentsJson }
      }))
    }
  }
  if (!turn.images?.length) return { role: turn.role, content: turn.content }
  return {
    role: turn.role,
    content: [
      { type: 'text', text: turn.content },
      ...turn.images.map((url) => ({ type: 'image_url', image_url: { url } }))
    ]
  }
}

interface StreamChunk {
  model?: string
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      // Tool calls arrive in fragments like content does: an index identifies
      // which call a fragment belongs to, and the arguments accumulate as a
      // string that is only valid JSON once complete.
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  timings?: {
    predicted_per_second?: number
    /** Tokens the server read for this request, and produced in reply. */
    prompt_n?: number
    predicted_n?: number
    /** Tokens it already had from the previous request and did not re-read. */
    cache_n?: number
  }
  error?: { message?: string }
}

/** Where a llama-server is, and the key it wants. */
export interface ServerEndpoint {
  url: string
  apiKey?: string | null
  /** Which model answers, by the name the server gives it. A router needs it; a one-model server ignores it. */
  model?: string | null
  /** The server slot to use: the one that holds this conversation, or one its saved state was restored into. */
  slot?: number | null
}

/** The Authorization header for a server's key, or nothing when it has none. */
export function authHeaders(apiKey: string | null | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

export async function streamChat(
  endpoint: string | ServerEndpoint,
  messages: ChatTurn[],
  settings: ChatSettingsView,
  signal: AbortSignal,
  cb: StreamCallbacks,
  /** Sent only when tools are enabled; each definition costs tokens every time. */
  tools?: unknown[],
  /** A JSON schema or grammar the reply must match. llama.cpp does not combine one with tools. */
  constraint?: OutputConstraint | null
): Promise<void> {
  const { url: baseUrl, apiKey, model: requestModel, slot } = typeof endpoint === 'string' ? { url: endpoint, apiKey: null, model: null, slot: null } : endpoint
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      signal,
      body: JSON.stringify({
        ...(requestModel ? { model: requestModel } : {}),
        ...(typeof slot === 'number' ? { id_slot: slot } : {}),
        messages: messages.map(encodeTurn),
        stream: true,
        // llama.cpp reports timings in the final streamed chunk when asked.
        timings_per_token: true,
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        min_p: settings.minP,
        repeat_penalty: settings.repeatPenalty,
        ...(settings.maxTokens > 0 ? { max_tokens: settings.maxTokens } : {}),
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        ...constraintFields(constraint)
      })
    })
  } catch (err) {
    if (signal.aborted) return
    cb.onError(`Could not reach the server: ${(err as Error).message}`)
    return
  }

  if (!res.ok || !res.body) {
    cb.onError(await describeHttpError(res))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tokensPerSecond: number | null = null
  let model: string | null = null
  let usage: TokenUsage | null = null
  let finishReason: string | null = null
  const toolCalls = new Map<number, StreamedToolCall>()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by a blank line; a chunk boundary can fall
      // anywhere, so only complete events are consumed.
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let chunk: StreamChunk
          try {
            chunk = JSON.parse(payload) as StreamChunk
          } catch {
            continue // a malformed keep-alive should not end the stream
          }
          if (chunk.error?.message) {
            cb.onError(chunk.error.message)
            return
          }
          if (chunk.model) model = chunk.model
          if (chunk.timings?.predicted_per_second) {
            tokensPerSecond = chunk.timings.predicted_per_second
          }
          // Sent in the final chunk. Counting tokens here rather than guessing
          // at them is what makes the context meter trustworthy.
          if (typeof chunk.timings?.prompt_n === 'number') {
            usage = {
              promptTokens: chunk.timings.prompt_n,
              predictedTokens: chunk.timings.predicted_n ?? 0,
              cacheTokens: chunk.timings.cache_n ?? 0
            }
          }
          if (chunk.choices?.[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason
          }
          const delta = chunk.choices?.[0]?.delta
          if (delta?.reasoning_content) cb.onReasoning?.(delta.reasoning_content)
          if (delta?.content) cb.onDelta(delta.content)
          for (const fragment of delta?.tool_calls ?? []) {
            const index = fragment.index ?? 0
            const existing = toolCalls.get(index) ?? { id: '', name: '', argumentsJson: '' }
            toolCalls.set(index, {
              id: fragment.id ?? existing.id,
              name: fragment.function?.name ?? existing.name,
              argumentsJson: existing.argumentsJson + (fragment.function?.arguments ?? '')
            })
          }
        }
      }
    }
    cb.onDone({ tokensPerSecond, model, toolCalls: [...toolCalls.values()], usage, finishReason })
  } catch (err) {
    // An abort is a user action, not a failure: the partial reply is kept.
    if (signal.aborted) {
      cb.onDone({
        tokensPerSecond,
        model,
        toolCalls: [...toolCalls.values()],
        usage,
        finishReason: 'aborted'
      })
      return
    }
    cb.onError(`Stream interrupted: ${(err as Error).message}`)
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function describeHttpError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // fall through to the status line
  }
  if (res.status === 503) return 'The model is still loading. Try again in a moment.'
  return `Server returned HTTP ${res.status} ${res.statusText}`.trim()
}
