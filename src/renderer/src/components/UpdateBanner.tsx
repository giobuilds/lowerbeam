import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types.js'

/** Where an update stands, kept current by the main process. Null until the first answer. */
export function useUpdate(): [UpdateState | null, (s: UpdateState) => void] {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.llama.update.state().then(setState)
    return window.llama.update.onChanged(setState)
  }, [])
  return [state, setState]
}

/**
 * A line under the tabs when there is something to say about an update: one
 * that is downloaded and goes in on the next restart, or, for a copy that
 * cannot install it itself, one that exists. Dismissed for the session, per
 * version, so a newer release still gets its line.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state] = useUpdate()
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!state || !state.version || dismissed === state.version) return null
  if (state.phase !== 'ready' && state.phase !== 'available') return null

  return (
    <div className="flex items-center gap-3 border-b border-edge bg-accent/10 px-4 py-1.5 text-xs text-slate-200">
      {state.phase === 'ready' ? (
        <>
          <span>Lowerbeam {state.version} has been downloaded and will be installed when you restart.</span>
          <button
            type="button"
            onClick={() => void window.llama.update.restart()}
            className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-ink"
          >
            Restart now
          </button>
        </>
      ) : (
        <>
          <span>Lowerbeam {state.version} is available.</span>
          {state.url && (
            <a href={state.url} data-external="true" className="text-accent hover:underline">
              See the release
            </a>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => setDismissed(state.version)}
        className="ml-auto text-[11px] text-muted hover:text-slate-200"
      >
        Later
      </button>
    </div>
  )
}
