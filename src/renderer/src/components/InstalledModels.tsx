import { useState } from 'react'
import { useServerStore } from '../state/serverStore.js'

const sizeOf = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`

const when = (at: number | null | undefined): string => {
  if (!at) return 'Not launched'
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Models already on disk.
 *
 * The download search finds new ones. This is the other half: what is taking
 * the space, when it was last launched, and which file name sits in more than
 * one folder. Deleting removes that file. A model the server is using has to
 * be stopped first, and the main process is what enforces that.
 */
export function InstalledModels(): React.JSX.Element {
  const models = useServerStore((s) => s.models)
  const loading = useServerStore((s) => s.modelsLoading)
  const loadModels = useServerStore((s) => s.loadModels)
  const removeModel = useServerStore((s) => s.removeModel)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freedNote, setFreedNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const sorted = [...models].sort((a, b) => b.fileSize - a.fileSize)
  const total = models.reduce((sum, model) => sum + model.fileSize, 0)

  const remove = async (path: string): Promise<void> => {
    setBusy(path)
    setError(null)
    setFreedNote(null)
    try {
      const freed = await removeModel(path)
      setPending(null)
      setFreedNote(`Freed ${sizeOf(freed)}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-r border-edge bg-panel">
      <header className="flex items-baseline justify-between gap-2 border-b border-edge px-3 py-2">
        <div>
          <h2 className="text-xs font-medium text-slate-100">On this machine</h2>
          <p className="text-[11px] text-muted">
            {models.length === 0 ? 'No models found' : `${models.length} files · ${sizeOf(total)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadModels(true)}
          className="text-[11px] text-muted hover:text-accent"
        >
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      {error && (
        <p className="border-b border-rose-900 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">{error}</p>
      )}
      {!error && freedNote && (
        <p className="border-b border-edge px-3 py-2 text-[11px] text-emerald-200">{freedNote}</p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {sorted.map((model) => {
          const folder = model.path.slice(0, model.path.length - model.fileName.length).replace(/\/$/, '')
          const confirming = pending === model.path
          return (
            <li key={model.path} className="border-b border-edge/60 px-3 py-2">
              <div className="truncate text-sm text-slate-100" title={model.path}>
                {model.name || model.fileName}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted" title={folder}>
                {[model.quant, sizeOf(model.fileSize), when(model.lastUsedAt)].filter(Boolean).join(' · ')}
              </div>
              {(model.copies ?? 1) > 1 && (
                <div className="mt-1 text-[10px] text-amber-200">
                  Duplicate · {(model.copies ?? 1) - 1} other {(model.copies ?? 1) === 2 ? 'copy' : 'copies'}
                </div>
              )}
              <div className="mt-1.5 flex justify-end">
                {confirming ? (
                  <span className="flex gap-2 text-[11px]">
                    <button
                      type="button"
                      disabled={busy === model.path}
                      onClick={() => void remove(model.path)}
                      className="text-rose-200 hover:text-rose-100 disabled:opacity-40"
                    >
                      {busy === model.path ? 'Deleting…' : model.projectorPath ? 'Delete model and projector' : 'Delete file'}
                    </button>
                    <button type="button" onClick={() => setPending(null)} className="text-muted hover:text-slate-200">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPending(model.path)}
                    className="text-[11px] text-muted hover:text-rose-200"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
