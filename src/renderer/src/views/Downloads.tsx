import { useEffect } from 'react'
import {
  FIT_RANK,
  recommendedFile,
  useDownloadStore
} from '../state/downloadStore.js'
import { useServerStore } from '../state/serverStore.js'
import type { Comfort, DownloadJob, FitVerdict, HfFile, RemoteFit } from '@shared/types.js'

const mb = (b: number): string =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`

const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

/**
 * Model downloads.
 *
 * Search and quant choice come from the Hugging Face API; the transfer itself is
 * handed to `llama download`, which already knows how to resolve a repo, fetch a
 * matching mmproj and write the HF cache layout correctly.
 */
export function Downloads(): React.JSX.Element {
  const {
    query, results, searching, expanded, files, filesLoading,
    fits, fitsLoading, sortBy, onlyFitting, jobs, error
  } = useDownloadStore()
  const setQuery = useDownloadStore((s) => s.setQuery)
  const search = useDownloadStore((s) => s.search)
  const expand = useDownloadStore((s) => s.expand)
  const start = useDownloadStore((s) => s.start)
  const cancel = useDownloadStore((s) => s.cancel)
  const clearError = useDownloadStore((s) => s.clearError)
  const forget = useDownloadStore((s) => s.forget)
  const clearFinished = useDownloadStore((s) => s.clearFinished)
  const setSortBy = useDownloadStore((s) => s.setSortBy)
  const setOnlyFitting = useDownloadStore((s) => s.setOnlyFitting)
  const device = useServerStore((s) => s.devices[0] ?? null)

  useEffect(() => {
    if (results.length === 0) void search()
    // Intentionally once on mount: the popular list is a starting point, not
    // something to refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued')
  const recent = jobs.filter((j) => j.state !== 'running' && j.state !== 'queued').slice(0, 6)

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Search Hugging Face for GGUF models…"
            className="flex-1 rounded-md border border-edge bg-ink px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={searching}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-ink hover:brightness-110 disabled:opacity-40"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </header>

        {error && (
          <p
            onClick={clearError}
            className="cursor-pointer border-b border-rose-900 bg-rose-950/40 px-4 py-2 text-xs text-rose-200"
          >
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!query && results.length > 0 && (
            <p className="border-b border-edge/60 px-4 py-1.5 text-[11px] text-muted">
              Popular chat models. Search for a name to look through every GGUF, including vision and embeddings.
            </p>
          )}
          {results.length === 0 && !searching && (
            <p className="p-6 text-center text-xs text-muted">No results.</p>
          )}
          <ul>
            {results.map((m) => (
              <li key={m.id} className="border-b border-edge/60">
                <button
                  type="button"
                  onClick={() => void expand(m.id)}
                  className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left hover:bg-panel/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{m.id}</span>
                  {m.gated && (
                    <span
                      title="Gated repo — needs an accepted licence and an HF token"
                      className="shrink-0 rounded bg-amber-900/50 px-1.5 text-[10px] text-amber-200"
                    >
                      gated
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-muted">
                    ↓{compact(m.downloads)} · ♥{compact(m.likes)}
                  </span>
                </button>

                {expanded === m.id && (
                  <div className="border-t border-edge/60 bg-ink/40 px-4 py-2">
                    {filesLoading ? (
                      <p className="text-[11px] text-muted">Loading files…</p>
                    ) : files.length === 0 ? (
                      <p className="text-[11px] text-muted">No GGUF files in this repo.</p>
                    ) : (
                      <>
                        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                          <span>
                            {fitsLoading
                              ? 'Checking what fits your GPU…'
                              : device
                                ? `Against ${device.freeMiB.toLocaleString()} MiB free on ${device.name}`
                                : 'No GPU detected — everything runs on CPU'}
                          </span>
                          <label className="ml-auto flex items-center gap-1.5">
                            Sort
                            <select
                              value={sortBy}
                              onChange={(e) => setSortBy(e.target.value as 'size' | 'fit' | 'speed')}
                              className="rounded border border-edge bg-ink px-1 py-0.5 text-[11px] outline-none focus:border-accent"
                            >
                              <option value="fit">best fit</option>
                              <option value="speed">fastest</option>
                              <option value="size">size</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={onlyFitting}
                              onChange={(e) => setOnlyFitting(e.target.checked)}
                            />
                            Only what fits
                          </label>
                        </div>
                        {files.some((f) => f.isProjector) && (
                          <p className="mb-1.5 text-[11px] text-violet-300">
                            Vision model — the projector it needs is downloaded with it.
                          </p>
                        )}
                        <ul className="space-y-1">
                          {orderFiles(files, fits, sortBy, onlyFitting).map((f) => (
                            <FileRow
                              key={f.path}
                              file={f}
                              fit={fits[f.path] ?? null}
                              recommended={f.path === recommendedFile(files, fits)}
                              onStart={() => void start(m.id, f)}
                            />
                          ))}
                          {orderFiles(files, fits, sortBy, onlyFitting).length === 0 && (
                            <li className="text-[11px] text-muted">
                              None of these quantisations fit in VRAM. Uncheck the filter to
                              download one anyway — it will run partly on CPU.
                            </li>
                          )}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-panel">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <h2 className="text-xs font-semibold text-muted">Downloads</h2>
          {recent.length > 0 && (
            <button
              type="button"
              onClick={() => void clearFinished()}
              title="Remove finished entries from this list. Downloaded files are not deleted."
              className="ml-auto text-[11px] text-muted hover:text-accent"
            >
              Clear
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {active.length === 0 && recent.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-muted">
              Nothing downloaded through this app yet.
            </p>
          )}
          {active.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => void cancel(j.id)} onForget={() => void forget(j.id)} />
          ))}
          {recent.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => void cancel(j.id)} onForget={() => void forget(j.id)} />
          ))}
        </div>
      </aside>
    </div>
  )
}

/** Ordering and filtering by how well each quantisation suits this machine. */
function orderFiles(
  files: HfFile[],
  fits: Record<string, RemoteFit>,
  sortBy: 'size' | 'fit' | 'speed',
  onlyFitting: boolean
): HfFile[] {
  // Projectors are downloaded with their model, never chosen on their own.
  const choosable = files.filter((f) => !f.isProjector)
  const visible = onlyFitting
    ? choosable.filter((f) => {
        const v = fits[f.path]?.verdict
        // While estimates are still loading, hiding everything would look
        // broken, so unknowns stay visible.
        return v === 'full' || v === undefined || v === 'unknown'
      })
    : choosable
  if (sortBy === 'size') return [...visible].sort((a, b) => a.size - b.size)
  if (sortBy === 'speed') {
    return [...visible].sort(
      (a, b) => (fits[b.path]?.tokensPerSecond ?? -1) - (fits[a.path]?.tokensPerSecond ?? -1)
    )
  }
  return [...visible].sort((a, b) => {
    const va = fits[a.path]?.verdict ?? 'unknown'
    const vb = fits[b.path]?.verdict ?? 'unknown'
    const ra = FIT_RANK[va]
    const rb = FIT_RANK[vb]
    if (ra !== rb) return ra - rb
    // Among models that fit, bigger is better: more bits at the same speed.
    // Among those that do not, bigger is strictly worse — every extra gigabyte
    // is more of the model spilling onto the CPU.
    return va === 'full' ? b.size - a.size : a.size - b.size
  })
}

/**
 * How a speed feels in conversation. Reading pace is roughly 5-10 tokens a
 * second, so above that the model keeps up with a person and below it waiting
 * becomes the experience.
 */
const COMFORT_STYLE: Record<Comfort, { className: string; title: string }> = {
  fast: { className: 'text-emerald-300', title: 'Faster than you can read' },
  comfortable: { className: 'text-emerald-200', title: 'Keeps up with reading' },
  slow: { className: 'text-amber-300', title: 'Noticeably slower than reading' },
  painful: { className: 'text-rose-300', title: 'Slow enough to be frustrating' },
  unknown: { className: 'text-muted', title: 'Not enough measurements yet to predict' }
}

const FIT_STYLE: Record<FitVerdict, { label: string; className: string; title: string }> = {
  full: {
    label: 'fits GPU',
    className: 'bg-emerald-900/50 text-emerald-200',
    title: 'Every layer is expected to fit in VRAM'
  },
  partial: {
    label: 'partial',
    className: 'bg-amber-900/50 text-amber-200',
    title: 'Only some layers fit; the rest run on CPU, which is much slower'
  },
  cpu: {
    label: 'CPU only',
    className: 'bg-rose-900/50 text-rose-200',
    title: 'Too large for VRAM — it would run on CPU'
  },
  unknown: {
    label: '—',
    className: 'bg-edge text-muted',
    title: 'Could not read this model’s header, so no estimate is offered'
  }
}

function FileRow({
  file,
  fit,
  recommended,
  onStart
}: {
  file: HfFile
  fit: RemoteFit | null
  recommended: boolean
  onStart: () => void
}): React.JSX.Element {
  // The quant is the part of the name people actually choose by.
  const quant = file.path.match(/(?:^|[.\-_])((?:IQ|Q)\d[A-Z0-9_]*|F16|BF16|F32)/i)?.[1] ?? null
  const style = FIT_STYLE[fit?.verdict ?? 'unknown']

  return (
    <li
      className={`flex items-center gap-2 rounded px-1 py-0.5 ${
        recommended ? 'bg-emerald-950/30 ring-1 ring-emerald-800/60' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300" title={file.path}>
        {quant && (
          <span className="mr-1.5 rounded bg-edge px-1 text-[10px] text-slate-200">{quant}</span>
        )}
        {file.path}
        {recommended && (
          <span
            className="ml-1.5 rounded bg-emerald-800/70 px-1 text-[10px] text-emerald-100"
            title="Largest quantisation that still fits entirely in VRAM"
          >
            best for your GPU
          </span>
        )}
      </span>

      {fit?.tokensPerSecond != null && (
        <span
          className={`shrink-0 text-[11px] tabular-nums ${COMFORT_STYLE[fit.comfort].className}`}
          title={
            `${COMFORT_STYLE[fit.comfort].title}. ` +
            fit.speedNotes.join(' ')
          }
        >
          ~{Math.round(fit.tokensPerSecond)} tok/s
        </span>
      )}
      {fit?.moe && (
        <span
          className="shrink-0 rounded bg-violet-900/50 px-1 text-[10px] text-violet-200"
          title="Mixture of experts — reads only a fraction of its weights per token, so it runs far faster than its size suggests"
        >
          MoE
        </span>
      )}
      <span
        className={`shrink-0 rounded px-1.5 text-[10px] ${style.className}`}
        title={
          fit?.totalMiB ? `${style.title} — about ${fit.totalMiB.toLocaleString()} MiB` : style.title
        }
      >
        {style.label}
      </span>
      <span className="shrink-0 text-[11px] text-muted">{mb(file.size)}</span>
      <button
        type="button"
        onClick={onStart}
        className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] hover:border-accent hover:text-accent"
      >
        Download
      </button>
    </li>
  )
}

/**
 * What became of a download, judged from the disk rather than from the record.
 *
 * A stored entry says what happened at the time. The file may since have been
 * completed by another attempt, or deleted by hand, and saying "partial file
 * kept" when nothing is kept sends someone looking for a file that is not there.
 */
function outcomeOf(job: DownloadJob): string {
  if (job.state === 'done') {
    return job.onDisk === false
      ? 'Downloaded, but the file is no longer on disk'
      : 'Ready to use — it is in your model list'
  }
  if (job.state === 'cancelled') {
    if (job.onDisk) return 'Cancelled, but the file was downloaded later — it is in your model list'
    if (job.partialBytes) {
      return `Cancelled — ${mb(job.partialBytes)} kept on disk, downloading again resumes it`
    }
    return 'Cancelled — nothing was kept on disk'
  }
  return job.error ?? 'Failed'
}

function JobRow({
  job,
  onCancel,
  onForget
}: {
  job: DownloadJob
  onCancel: () => void
  onForget: () => void
}): React.JSX.Element {
  const pct =
    job.expectedBytes > 0 ? Math.min(100, (job.receivedBytes / job.expectedBytes) * 100) : 0
  const tone =
    job.state === 'done'
      ? 'text-emerald-300'
      : job.state === 'failed'
        ? 'text-rose-300'
        : job.state === 'cancelled'
          ? 'text-amber-300'
          : 'text-slate-200'

  return (
    <div className="group mb-2 rounded border border-edge bg-ink/60 p-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200" title={`${job.repo}/${job.file}`}>
          {job.file}
        </span>
        {job.state === 'running' || job.state === 'queued' ? (
          <button type="button" onClick={onCancel} className="text-[11px] text-muted hover:text-rose-300">
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onForget}
            title="Remove from this list. The downloaded file is not deleted."
            className="shrink-0 text-[11px] leading-none text-muted hover:text-rose-300"
          >
            ✕
          </button>
        )}
      </div>
      <p className="truncate text-[10px] text-muted">{job.repo}</p>

      {job.state === 'queued' && (
        <p className="mt-1 text-[10px] text-muted">
          Waiting — one download at a time per repository.
        </p>
      )}

      {job.state === 'running' && (
        <>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-edge">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-muted">
            {mb(job.receivedBytes)} of {mb(job.expectedBytes)} · {pct.toFixed(0)}%
          </p>
        </>
      )}

      {job.state !== 'running' && job.state !== 'queued' && (
        <p className={`mt-1 text-[10px] ${tone}`}>{outcomeOf(job)}</p>
      )}
    </div>
  )
}
