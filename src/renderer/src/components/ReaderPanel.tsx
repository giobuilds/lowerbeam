import { useCallback, useEffect, useRef } from 'react'
import { useReaderStore } from '../state/readerStore.js'
import { hostOf } from '@shared/url.js'

/**
 * The pane that shows a page a search result linked to.
 *
 * The page itself is not in this document — it is a separate web contents in
 * the main process with no bridge to the app, drawn over the window. So this
 * component renders the frame around a hole and keeps telling the main process
 * where that hole is.
 */
export function ReaderPanel(): React.JSX.Element | null {
  const { open, url, title, loading, canGoBack, error, held, hidden, width } = useReaderStore()
  const decideHeld = useReaderStore((s) => s.decideHeld)
  const close = useReaderStore((s) => s.close)
  const back = useReaderStore((s) => s.back)
  const openExternal = useReaderStore((s) => s.openExternal)
  const setWidth = useReaderStore((s) => s.setWidth)
  const hole = useRef<HTMLDivElement>(null)

  const report = useCallback((): void => {
    const el = hole.current
    if (!el || hidden) return void window.llama.reader.setBounds(null)
    const r = el.getBoundingClientRect()
    void window.llama.reader.setBounds({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    })
  }, [hidden])

  // The pane does not reflow with the page, so every layout change has to be
  // pushed: the element resizing, the window resizing, and the pane opening.
  useEffect(() => {
    if (!open) return
    report()
    const observer = new ResizeObserver(report)
    if (hole.current) observer.observe(hole.current)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
    // The hole comes and goes with a held page or an error: watch the new one, or report none.
  }, [open, report, held, error])

  useEffect(() => {
    // Closing is the main process's job; this only stops it drawing over a modal.
    if (open) report()
  }, [hidden, open, report])

  const startResize = (event: React.PointerEvent): void => {
    event.preventDefault()
    const move = (e: PointerEvent): void => setWidth(window.innerWidth - e.clientX)
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  if (!open) return null

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-edge bg-panel"
      style={{ width }}
    >
      <div
        onPointerDown={startResize}
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize"
        title="Drag to resize"
      />
      <header className="flex items-center gap-2 border-b border-edge px-2 py-1.5">
        <button
          type="button"
          onClick={() => void back()}
          disabled={!canGoBack}
          title="Back"
          className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-slate-200 disabled:opacity-30"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-slate-200" title={title}>
            {loading ? 'Loading…' : title || 'Untitled page'}
          </p>
          <p className="truncate text-[10px] text-muted" title={url}>
            {hostOf(url)}
          </p>
        </div>
        <button
          type="button"
          onClick={openExternal}
          title="Open in your browser"
          className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-slate-200"
        >
          Browser
        </button>
        <button
          type="button"
          onClick={() => void close()}
          title="Close the reader"
          className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-slate-200"
        >
          ✕
        </button>
      </header>

      {held ? (
        <div className="p-4 text-xs text-slate-300">
          <p>
            This link goes to <span className="font-mono text-amber-200">{hostOf(held.url)}</span>, which is {held.why}.
          </p>
          <p className="mt-2 text-muted">
            A page there is a router, a printer or a server on this computer, not the web. A link from a model or a page
            should not open one unasked.
          </p>
          <p className="mt-1 truncate font-mono text-[10px] text-muted" title={held.url}>
            {held.url}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void decideHeld(true)}
              className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:text-slate-200"
            >
              Open it here
            </button>
            <button
              type="button"
              onClick={openExternal}
              className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:text-slate-200"
            >
              Open in your browser
            </button>
            <button
              type="button"
              onClick={() => void decideHeld(false)}
              className="rounded px-2 py-1 text-[11px] text-muted hover:text-slate-200"
            >
              Don’t open
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="p-4 text-xs text-rose-300">
          <p>{error}</p>
          <button
            type="button"
            onClick={openExternal}
            className="mt-2 rounded border border-edge px-2 py-1 text-[11px] text-muted hover:text-slate-200"
          >
            Try it in your browser
          </button>
        </div>
      ) : (
        // The page is drawn over this element by the main process.
        <div ref={hole} className="min-h-0 flex-1 bg-white" />
      )}
    </aside>
  )
}
