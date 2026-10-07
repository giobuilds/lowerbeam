import { useEffect, useState } from 'react'
import type { AboutView, DataUsage, UpdateState } from '@shared/types.js'
import { useServerStore } from '../state/serverStore.js'
import { useChatStore } from '../state/chatStore.js'
import { useUpdate } from './UpdateBanner.js'

const REPO = 'https://github.com/giobuilds/lowerbeam'

/**
 * About, in the app's own dress.
 *
 * This was a native message box, which on this desktop looked like a different
 * program entirely. It also says more than a message box could: which llama.cpp
 * is in use matters more than which Electron is, because it decides what the
 * app can do and how fast it runs.
 */
export function About({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [about, setAbout] = useState<AboutView | null>(null)
  const binary = useServerStore((s) => s.binary)
  const [update, setUpdate] = useUpdate()

  useEffect(() => {
    void window.llama.app.about().then(setAbout)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const device = binary?.devices?.[0]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-edge bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-100">{about?.name ?? 'Lowerbeam'}</h2>
          <p className="text-xs text-muted">
            {about ? `Version ${about.version}` : 'Loading…'}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            A desktop control panel for llama.cpp: it owns the server process, so
            picking a model, fitting it to your GPU and chatting with it all
            happen in one place.
          </p>
        </div>

        <dl className="divide-y divide-edge text-xs">
          <Row label="llama.cpp">
            {binary?.path ? (
              <>
                <span className="text-slate-200">{binary.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted" title={binary.path}>
                  {binary.path}
                </span>
              </>
            ) : (
              <span className="text-amber-300">Not found</span>
            )}
          </Row>

          <Row label="Device">
            {device ? (
              <span className="text-slate-200">
                {device.name}
                <span className="text-muted"> · {(device.totalMiB / 1024).toFixed(1)} GiB</span>
              </span>
            ) : (
              <span className="text-muted">CPU only</span>
            )}
          </Row>

          <Row label="Built on">
            <span className="text-muted">
              {about
                ? `Electron ${about.electron} · Chromium ${about.chrome.split('.')[0]} · Node ${about.node}`
                : '—'}
            </span>
          </Row>
          <Row label="Updates">
            <UpdateRow state={update} onChange={setUpdate} />
          </Row>
          <Row label="Data">
            <DataRow />
          </Row>
        </dl>

        <div className="flex items-center gap-3 border-t border-edge px-5 py-3">
          <a href={REPO} data-external="true" className="text-[11px] text-accent hover:underline">
            Source
          </a>
          <a href={`${REPO}/blob/main/PRIVACY.md`} data-external="true" className="text-[11px] text-accent hover:underline">
            Privacy
          </a>
          <a
            href={`${REPO}/issues/new`}
            data-external="true"
            className="text-[11px] text-accent hover:underline"
          >
            Report an issue
          </a>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="ml-auto rounded bg-ink px-3 py-1 text-xs text-slate-200 hover:text-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** The update setting, where things stand, and a way to check now. */
function UpdateRow({ state, onChange }: { state: UpdateState | null; onChange: (s: UpdateState) => void }): React.JSX.Element {
  if (!state) return <span className="text-muted">—</span>
  if (state.phase === 'unsupported') return <span className="text-muted">Not checked in a development build.</span>
  const status =
    state.phase === 'checking'
      ? 'Checking…'
      : state.phase === 'downloading'
        ? `Downloading ${state.version}${state.percent !== null ? ` · ${state.percent}%` : ''}`
        : state.phase === 'ready'
          ? `${state.version} is downloaded and goes in on the next restart.`
          : state.phase === 'available'
            ? `${state.version} is available.`
            : state.phase === 'error'
              ? `Could not check: ${state.error}`
              : 'Up to date, as of the last check.'
  return (
    <>
      <label className="flex items-center gap-1.5 text-slate-200">
        <input type="checkbox" checked={state.enabled !== false} onChange={(e) => void window.llama.update.setEnabled(e.target.checked).then(onChange)} />
        Check GitHub for new versions
      </label>
      {state.enabled !== false && (
        <span className="mt-0.5 block text-[11px] text-muted">
          {status}{' '}
          {(state.phase === 'idle' || state.phase === 'error') && (
            <button type="button" onClick={() => void window.llama.update.check().then(onChange)} className="text-accent hover:underline">
              Check now
            </button>
          )}
        </span>
      )}
      <span className="mt-0.5 block text-[11px] text-muted">
        {state.selfUpdating
          ? 'This AppImage downloads a new version in the background and installs it when you restart.'
          : 'Installed as a package, so a new version is announced here and installed by your package manager.'}
      </span>
    </>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex gap-4 px-5 py-2.5">
      <dt className="w-20 shrink-0 pt-0.5 text-[11px] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const size = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`

/**
 * What the app keeps, by kind, and getting rid of it: each kind in one
 * step, everything at once, and old runs' copies after a while. Every
 * deletion asks once more, saying what it will remove.
 */
function DataRow(): React.JSX.Element {
  const [usage, setUsage] = useState<DataUsage | null>(null)
  const [confirm, setConfirm] = useState<'runs' | 'conversations' | 'all' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.llama.data.usage().then(setUsage).catch((e: Error) => setError(e.message))
  }, [])
  if (!usage) return <span className="text-muted">{error ?? 'Measuring…'}</span>

  const act = async (what: 'runs' | 'conversations' | 'all'): Promise<void> => {
    setConfirm(null)
    setError(null)
    try {
      if (what === 'runs') setUsage(await window.llama.data.deleteRuns())
      else if (what === 'conversations') {
        // Replies still streaming would write their chats back; they stop first.
        for (const s of Object.values(useChatStore.getState().streams)) s.abort.abort()
        setUsage(await window.llama.data.deleteConversations())
        useChatStore.setState({ conversations: [], byId: {}, activeId: null, streams: {} })
      } else await window.llama.data.deleteAll()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const ask = (what: 'runs' | 'conversations' | 'all', label: string, question: string): React.JSX.Element =>
    confirm === what ? (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-rose-200">{question}</span>
        <button type="button" onClick={() => void act(what)} className="text-rose-300 hover:underline">
          Delete
        </button>
        <button type="button" onClick={() => setConfirm(null)} className="text-muted hover:text-slate-200">
          Keep
        </button>
      </span>
    ) : (
      <button type="button" onClick={() => setConfirm(what)} className="text-muted hover:text-rose-300">
        {label}
      </button>
    )

  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="grid grid-cols-[1fr_auto] gap-x-3 text-slate-200">
        <span>{usage.conversations.count} conversation{usage.conversations.count === 1 ? '' : 's'}</span>
        <span className="text-right text-muted">{size(usage.conversations.bytes)}</span>
        <span>{usage.runs.count} coding run{usage.runs.count === 1 ? '' : 's'}</span>
        <span className="text-right text-muted">{size(usage.runs.bytes)}</span>
        <span>{usage.workspaces.count} workspace cop{usage.workspaces.count === 1 ? 'y' : 'ies'} of projects</span>
        <span className="text-right text-muted">{size(usage.workspaces.bytes)}</span>
        <span className="text-muted">All of it, Electron’s storage included</span>
        <span className="text-right text-muted">{size(usage.total)}</span>
      </div>
      <p className="truncate text-muted" title={usage.path}>
        In {usage.path}. Models are your files and are never deleted here.
      </p>
      <label className="flex items-center gap-1.5 text-slate-200">
        Keep runs’ workspace copies and command output
        <select
          value={usage.retentionDays ?? ''}
          onChange={(e) => {
            setError(null)
            void window.llama.data
              .setRetention(e.target.value === '' ? null : Number(e.target.value))
              .then(setUsage)
              .catch((err: Error) => setError(err.message))
          }}
          className="rounded border border-edge bg-ink px-1 py-0.5 text-[11px]"
        >
          <option value="">always</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
      </label>
      {usage.retentionDays !== null && (
        <p className="text-muted">After that, a run keeps its journal; its changes can no longer be applied or undone.</p>
      )}
      <div className="flex flex-col items-start gap-1">
        {ask('runs', 'Delete all coding runs…', `Delete ${count(usage.runs.count, 'run')} and ${count(usage.workspaces.count, 'workspace copy', 'workspace copies')} (${size(usage.runs.bytes + usage.workspaces.bytes)})? Applied changes stay in your projects; undo goes.`)}
        {ask('conversations', 'Delete all conversations…', `Delete ${count(usage.conversations.count, 'conversation')} (${size(usage.conversations.bytes)})?`)}
        {ask('all', 'Delete all app data…', 'Stop the server, delete conversations, runs, settings and launch profiles, clear Electron’s storage, and restart?')}
      </div>
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  )
}
