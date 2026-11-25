import type { ServerStatus } from '@shared/types.js'
import { authHeaders } from '@shared/chatClient.js'

/**
 * One short completion on the server that is already running.
 * It checks a shared starting point against this machine. It does not start
 * a second server, and it does not leave the loopback address.
 */
export async function confirmLocalSpeed(
  status: Pick<ServerStatus, 'phase' | 'port' | 'apiKey' | 'adopted'>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<number | null> {
  if (status.adopted || status.phase !== 'ready') return null
  const port = status.port
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(status.apiKey) },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        temperature: 0
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { timings?: { predicted_per_second?: number } }
    const speed = body.timings?.predicted_per_second
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return null
    return speed
  } catch {
    return null
  }
}
