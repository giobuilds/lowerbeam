import { useEffect, useState } from 'react'
import type { NetworkView } from '@shared/network.js'

/**
 * Always visible, so “running locally” is something you can check.
 * The same control lives in Settings → Network.
 * The word waits for the main process, so a saved Offline does not flash as Local.
 */
export function NetworkBadge(): React.JSX.Element {
  const [view, setView] = useState<NetworkView | null>(null)

  useEffect(() => {
    let stop = (): void => {}
    void window.llama.network.get().then(setView).catch(() => {})
    stop = window.llama.network.onChanged(setView)
    return () => stop()
  }, [])

  if (!view) return <span className="inline-block w-12" aria-hidden="true" />

  const label = view.offline ? 'Offline' : view.active.length > 0 ? view.active.join(' · ') : 'Local'
  const title = view.offline
    ? 'Offline. Lowerbeam is not checking for updates, downloading, searching, fetching pages, or loading shared profiles. A link you open, and an MCP server you enable, still run. Click to allow the app’s own requests again.'
    : view.active.length > 0
      ? `Reaching the internet: ${view.active.join(', ')}. Click to stop.`
      : 'Nothing is leaving this machine. Click to turn Lowerbeam’s own network requests off.'
  const look = view.offline
    ? 'border-edge bg-ink text-slate-200'
    : view.active.length > 0
      ? 'border-amber-900/60 bg-amber-950/30 text-amber-300'
      : 'border-transparent text-muted hover:border-edge hover:text-slate-200'

  return (
    <button
      type="button"
      aria-pressed={view.offline}
      title={title}
      onClick={() => {
        void window.llama.network.setOffline(!view.offline).then(setView).catch(() => {})
      }}
      className={`max-w-64 truncate rounded border px-2 py-0.5 text-[11px] ${look}`}
    >
      {label}
    </button>
  )
}
