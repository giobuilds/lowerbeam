import { useEffect, useState } from 'react'
import type { DownloadChoice } from '@shared/llamaOffer.js'
import { downloadRecovery, LLAMA_UPDATE_LABEL, offerSentence, rollbackSentence } from '@shared/llamaOffer.js'
import type { BinarySelection, LlamaDownloadProgress, LlamaUpdateView } from '@shared/types.js'
import { useServerStore } from '../state/serverStore.js'

const RELEASES = 'https://github.com/ggml-org/llama.cpp/releases'

/**
 * Offer the official Vulkan or CPU build.
 * Shown in place of the "not found" notice, and again from the Server panel
 * when a binary is already selected. Nothing is requested until Download.
 */
export function OfficialBuild({
  prominent = false,
  disabled
}: {
  prominent?: boolean
  disabled: boolean
}): React.JSX.Element {
  const adopt = useServerStore((s) => s.adoptBinaries)
  const [open, setOpen] = useState(prominent)
  const [backend, setBackend] = useState<DownloadChoice['backend']>('vulkan')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<LlamaDownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<DownloadChoice>({ backend: 'vulkan', channel: 'pinned' })

  useEffect(() => window.llama.official.onProgress(setProgress), [])

  const run = async (next: DownloadChoice): Promise<void> => {
    setChoice(next)
    setBackend(next.backend)
    setError(null)
    setBusy(true)
    setProgress(null)
    try {
      adopt(await window.llama.official.install(next))
      if (!prominent) setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    setError(null)
    try {
      const selected = await window.llama.official.pick()
      if (selected) adopt(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!prominent && !open) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={disabled ? 'Stop the server before changing the binary.' : undefined}
        onClick={() => setOpen(true)}
        className="self-start text-[11px] text-accent hover:underline disabled:opacity-40"
      >
        Download official build
      </button>
    )
  }

  const recovery = error ? downloadRecovery(error, choice) : null
  const received = progress?.received ?? 0
  const total = progress?.total ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0

  return (
    <section className="rounded-md border border-edge bg-ink/60 p-3 text-xs text-slate-200">
      <p>
        {prominent
          ? 'Lowerbeam can download the official llama.cpp build (Vulkan, about 30 MB) from GitHub into its own folder.'
          : 'Download the official llama.cpp build into this app’s folder.'}
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-muted">
        Vulkan uses the graphics driver you already have, so one build covers AMD, Intel and NVIDIA.
        It needs no ROCm or CUDA toolkit. The CPU build is the fallback.
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-muted">
        Download contacts GitHub and fetches one archive. GitHub sees your IP address and a Lowerbeam
        user agent. Nothing else is sent.
      </p>

      <div className="mt-2 flex gap-3 text-[11px]">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="llama-backend"
            checked={backend === 'vulkan'}
            disabled={disabled || busy}
            onChange={() => setBackend('vulkan')}
          />
          Vulkan
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="llama-backend"
            checked={backend === 'cpu'}
            disabled={disabled || busy}
            onChange={() => setBackend('cpu')}
          />
          CPU
        </label>
      </div>

      {busy && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-ink">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-muted">
            {total > 0 && received >= total
              ? 'Checking the build…'
              : total > 0
                ? `${megabytes(received)} of ${megabytes(total)}`
                : 'Contacting GitHub…'}
          </p>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-rose-800 bg-rose-950/50 p-2 text-[11px] leading-snug text-rose-200">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void run({ backend, channel: 'pinned' })}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-ink hover:brightness-110 disabled:opacity-40"
        >
          Download
        </button>
        {recovery?.retry && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void run(choice)}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40"
          >
            Retry
          </button>
        )}
        {recovery?.newest && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void run({ backend: choice.backend, channel: 'newest' })}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40"
          >
            Download the newest build
          </button>
        )}
        {recovery?.cpu && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void run({ backend: 'cpu', channel: 'pinned' })}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40"
          >
            Download the CPU build
          </button>
        )}
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void pick()}
          className="rounded-md border border-edge px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40"
        >
          Use my own build…
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => void window.llama.official.cancel()}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-slate-200"
          >
            Cancel
          </button>
        )}
        {!prominent && !busy && (
          <button type="button" onClick={() => setOpen(false)} className="px-1 text-[11px] text-muted hover:text-slate-200">
            Close
          </button>
        )}
      </div>
      {disabled && <p className="mt-1.5 text-[11px] text-muted">Stop the server before changing the binary.</p>}
      <p className="mt-2 text-[11px] leading-snug text-muted">
        ROCm, CUDA, SYCL and OpenVINO are not offered.{' '}
        <a href={RELEASES} data-external="true" className="text-accent hover:underline">
          llama.cpp releases
        </a>
      </p>
    </section>
  )
}

/** Open the official build's folder, or remove it after one confirmation. */
export function ManagedBuildRow({
  path,
  disabled,
  onRemoved
}: {
  path: string
  disabled: boolean
  onRemoved: (selection: BinarySelection) => void
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    setError(null)
    try {
      onRemoved(await window.llama.official.remove())
      setConfirm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mt-1">
      <div className="truncate" title={path}>
        {path}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void window.llama.official.open().catch((err: Error) => setError(err.message))}
          className="text-accent hover:underline disabled:opacity-40"
        >
          Open folder
        </button>
        {confirm ? (
          <>
            <span className="text-rose-200">Remove this build?</span>
            <button type="button" disabled={disabled} onClick={() => void remove()} className="text-rose-300 hover:underline disabled:opacity-40">
              Remove
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="text-muted hover:text-slate-200">
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirm(true)}
            className="text-muted hover:text-rose-300 disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-rose-300">{error}</p>}
    </div>
  )
}

/**
 * The daily check sits with the managed build. It is hidden when the selected
 * binary is one the person chose. Nothing is installed until Install.
 */
export function OfficialUpdate({ disabled }: { disabled: boolean }): React.JSX.Element | null {
  const managed = useServerStore((s) => s.managed)
  const binary = useServerStore((s) => s.binary)
  const adopt = useServerStore((s) => s.adoptBinaries)
  const [view, setView] = useState<LlamaUpdateView | null>(null)
  const [busy, setBusy] = useState(false)
  const [which, setWhich] = useState<'install' | 'back' | null>(null)
  const [progress, setProgress] = useState<LlamaDownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let epoch = 0
    let live = true
    const stop = window.llama.official.onUpdate((next) => {
      epoch += 1
      setView(next)
    })
    const seen = epoch
    void window.llama.official.update().then((next) => {
      if (live && epoch === seen) setView(next)
    })
    return () => {
      live = false
      stop()
    }
  }, [binary?.path, managed?.path])

  useEffect(() => window.llama.official.onProgress(setProgress), [])

  if (!managed || !binary || binary.path !== managed.path || !view) return null

  const run = async (action: 'install' | 'back'): Promise<void> => {
    setError(null)
    setBusy(true)
    setWhich(action)
    setProgress(null)
    try {
      adopt(action === 'install' ? await window.llama.official.installUpdate() : await window.llama.official.restoreUpdate())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      try {
        setView(await window.llama.official.update())
      } catch {
        // The action's error is the one to show.
      }
      setBusy(false)
    }
  }

  const received = progress?.received ?? 0
  const total = progress?.total ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0

  return (
    <div className="mt-2">
      <label className="flex items-center gap-1.5 text-slate-200">
        <input
          type="checkbox"
          checked={view.enabled}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.target.checked
            setView((prev) => (prev ? { ...prev, enabled, offerTag: enabled ? prev.offerTag : null } : prev))
            const choice = enabled ? 'on' : 'off'
            void window.llama.official
              .setUpdate(choice)
              .then(setView)
              .catch((err: Error) => setError(err.message))
          }}
        />
        {LLAMA_UPDATE_LABEL}
      </label>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        When this is on, Lowerbeam asks GitHub once a day about the build it installed. Nothing is
        installed until you click Install. GitHub sees your IP address and a Lowerbeam user agent.
      </p>
      {view.offerTag && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-slate-200">{offerSentence(view.offerTag)}</span>
          <button
            type="button"
            disabled={disabled || busy}
            title={disabled ? 'Stop the server before changing the binary.' : undefined}
            onClick={() => void run('install')}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-ink hover:brightness-110 disabled:opacity-40"
          >
            Install
          </button>
        </div>
      )}
      {view.rollbackTag && (
        <button
          type="button"
          disabled={disabled || busy}
          title={disabled ? 'Stop the server before changing the binary.' : undefined}
          onClick={() => void run('back')}
          className="mt-1 block text-accent hover:underline disabled:opacity-40"
        >
          {rollbackSentence(view.rollbackTag)}
        </button>
      )}
      {busy && (
        <p className="mt-1 text-[11px] text-muted">
          {which === 'back' || (total > 0 && received >= total)
            ? 'Checking the build…'
            : total > 0
              ? `${megabytes(received)} of ${megabytes(total)}`
              : 'Contacting GitHub…'}
        </p>
      )}
      {busy && total > 0 && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
      {error && <p className="mt-1 text-rose-300">{error}</p>}
      {disabled && (view.offerTag || view.rollbackTag) && (
        <p className="mt-1 text-[11px] text-muted">Stop the server before changing the binary.</p>
      )}
    </div>
  )
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
