import { useEffect, useState } from 'react'
import { useServerStore } from '../state/serverStore.js'
import { authHeaders } from '@shared/chatClient.js'
import { useChatStore } from '../state/chatStore.js'
import { servedModel } from '@shared/served.js'

interface SlotInfo {
  total: number
  busy: number
  contextPerSlot: number | null
}

/**
 * How many of llama-server's slots are in use.
 *
 * Slots are what make concurrent conversations possible: the server decodes one
 * sequence per slot, and requests beyond that queue. Showing the number makes
 * the ceiling visible before a chat mysteriously stalls waiting for a free one.
 */
export function SlotMeter(): React.JSX.Element | null {
  const port = useServerStore((s) => (s.status?.phase === 'ready' ? s.status.port : null))
  const apiKey = useServerStore((s) => s.status?.apiKey ?? null)
  // A router has slots per model, and only a loaded one answers for them.
  const model = useServerStore((s) => {
    const m = s.status?.router ? servedModel(s.status, s.activeModel) : null
    return m && m.state === 'loaded' ? m.id : null
  })
  const routed = useServerStore((s) => Boolean(s.status?.router))
  const streamCount = useChatStore((s) => Object.keys(s.streams).length)
  const [slots, setSlots] = useState<SlotInfo | null>(null)

  useEffect(() => {
    if (!port || (routed && !model)) {
      setSlots(null)
      return
    }
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/slots${model ? `?model=${encodeURIComponent(model)}` : ''}`, {
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(2000)
        })
        if (!res.ok) return
        const data = (await res.json()) as Array<{ is_processing?: boolean; n_ctx?: number }>
        if (cancelled || !Array.isArray(data)) return
        setSlots({
          total: data.length,
          busy: data.filter((s) => s.is_processing).length,
          contextPerSlot: data[0]?.n_ctx ?? null
        })
      } catch {
        // /slots needs --slots enabled; its absence is not worth an error.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [port, apiKey, model, routed])

  if (!slots) return null

  // The server's own count lags a request by up to a poll interval, so the
  // number of live streams is a better floor for "busy" than /slots alone.
  const busy = Math.max(slots.busy, Math.min(streamCount, slots.total))
  const queued = Math.max(0, streamCount - slots.total)

  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-muted"
      title={
        `${slots.total} slot${slots.total === 1 ? '' : 's'}` +
        (slots.contextPerSlot ? ` · ${slots.contextPerSlot.toLocaleString()} tokens each` : '') +
        (queued > 0 ? ` · ${queued} request(s) queued` : '')
      }
    >
      <span className="flex gap-0.5">
        {Array.from({ length: slots.total }, (_, i) => (
          <span
            key={i}
            className={`h-2.5 w-1.5 rounded-sm ${i < busy ? 'bg-accent' : 'bg-edge'}`}
          />
        ))}
      </span>
      <span>
        {busy}/{slots.total}
        {queued > 0 && <span className="text-amber-300"> +{queued} queued</span>}
      </span>
    </span>
  )
}
