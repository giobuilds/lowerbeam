import { useEffect, useState } from 'react'
import { useServerStore } from '../state/serverStore.js'
import { contextAdvice, type CapabilityStatus } from '@shared/capability.js'
import { KV_CACHE_TYPES, type LocalApiSettings, type ServerStatus } from '@shared/types.js'
import { Field, inputClass } from '../components/Field.js'
import { StatusBadge } from '../components/StatusBadge.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { VramBar } from '../components/VramBar.js'
import { HealthCheck } from '../components/HealthCheck.js'
import { ProfileBadge } from '../components/ProfileBadge.js'

/** Phases in which a new launch must not be attempted. */
const LIVE_PHASES = new Set(['starting', 'loading', 'ready', 'degraded', 'stopping'])

export function LaunchPanel(): React.JSX.Element {
  const { status, binary, binaries, devices, draft, busy, error, plan, fit, fitLoading } =
    useServerStore()
  const setDraft = useServerStore((s) => s.setDraft)
  const start = useServerStore((s) => s.start)
  const stop = useServerStore((s) => s.stop)
  const refreshDevices = useServerStore((s) => s.refreshDevices)
  const selectBinary = useServerStore((s) => s.selectBinary)
  const clearError = useServerStore((s) => s.clearError)

  const phase = status?.phase ?? 'stopped'
  const live = LIVE_PHASES.has(phase)
  const supports = (flag: string): boolean => !binary || binary.flags.includes(flag)

  return (
    <aside className="flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge bg-panel p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-wide">Server</h1>
        <StatusBadge phase={phase} />
      </header>

      {binary && binary.path === '' && (
        <p className="rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200">
          Could not find <code>llama-server</code> on this system. Set{' '}
          <code>LLAMA_SERVER_PATH</code> and restart.
        </p>
      )}

      {status?.adopted && phase === 'ready' && (
        <p className="rounded-md border border-sky-800 bg-sky-950/40 p-2.5 text-xs text-sky-200">
          Attached to a llama-server that was already running (pid {status.pid}).
        </p>
      )}

      {error && (
        <p
          className="cursor-pointer rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200"
          onClick={clearError}
        >
          {error} <span className="opacity-60">(click to dismiss)</span>
        </p>
      )}

      {status?.error && phase === 'crashed' && (
        <p className="rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200">
          {status.error}
        </p>
      )}

      <ModelPicker disabled={live} />

      <ProfileBadge disabled={live} />

      {draft.mmprojPath && (
        <div className="rounded-md border border-violet-900/70 bg-violet-950/20 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-violet-200">Vision projector found</span>
            <button
              type="button"
              onClick={() => setDraft({ mmprojPath: null })}
              disabled={live}
              className="shrink-0 text-[11px] text-muted hover:text-rose-300 disabled:opacity-40"
            >
              Don&apos;t use
            </button>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted" title={draft.mmprojPath}>
            {draft.mmprojPath.split('/').pop()}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted/80">
            Passed as --mmproj so the model can read images. Without it the model
            still loads, but silently text-only.
          </p>
        </div>
      )}

      {supports('--fit') && (
        <section className="rounded-md border border-edge bg-ink/60 p-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.autoFit}
              disabled={live}
              onChange={(e) => setDraft({ autoFit: e.target.checked })}
            />
            <span>
              <span className="text-xs font-medium text-slate-200">
                Let llama.cpp size this launch
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                Context and GPU layers are left unset so llama.cpp fits them to your
                device. It knows its own allocator better than any estimate — turn
                this off to set them yourself.
              </span>
            </span>
          </label>

          {draft.autoFit && (
            <p className="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {fitLoading ? (
                'Asking llama.cpp what fits…'
              ) : fit ? (
                <>
                  It suggests <code className="text-slate-200">{fit.raw}</code>
                  {fit.contextSize ? ` (${(fit.contextSize / 1024).toFixed(0)}k context` : ''}
                  {fit.gpuLayers === -1 ? ', all layers on GPU)' : fit.gpuLayers !== null ? `, ${fit.gpuLayers} layers)` : ')'}
                </>
              ) : !draft.modelPath ? (
                // Before a model is chosen there is nothing to suggest, which is
                // different from having asked and received no answer.
                'Choose a model to see what llama.cpp would pick.'
              ) : (
                'No suggestion available for this model.'
              )}
            </p>
          )}
        </section>
      )}

      {plan && !draft.autoFit && <VramBar plan={plan} />}

      <HealthCheck disabled={live} />

      {plan?.moeBlocks && supports('--n-cpu-moe') && (
        <ExpertOffload
          blocks={plan.moeBlocks}
          value={draft.cpuMoeLayers}
          onCpuMiB={plan.expertsOnCpuMiB}
          disabled={live}
          onChange={(cpuMoeLayers) => setDraft({ cpuMoeLayers })}
        />
      )}

      <div className={`grid grid-cols-2 gap-3 ${draft.autoFit ? 'opacity-50' : ''}`}>
        <Field label="GPU layers (-ngl)" hint="999 offloads everything that fits">
          <input
            type="number"
            min={0}
            className={inputClass}
            value={draft.gpuLayers}
            disabled={live || draft.autoFit}
            onChange={(e) => setDraft({ gpuLayers: Number(e.target.value) })}
          />
        </Field>
        <Field label="Context (-c)" hint="0 = the model's trained size">
          <input
            type="number"
            min={0}
            step={512}
            className={inputClass}
            value={draft.contextSize}
            disabled={live || draft.autoFit}
            onChange={(e) => setDraft({ contextSize: Number(e.target.value) })}
          />
          <ContextAdvice modelPath={draft.modelPath} current={draft.contextSize} disabled={live || draft.autoFit} onUse={(n) => setDraft({ contextSize: n })} />
        </Field>
        {supports('--cache-type-k') && (
          <Field label="KV cache K (-ctk)">
            <select
              className={inputClass}
              value={draft.cacheTypeK}
              disabled={live}
              onChange={(e) => setDraft({ cacheTypeK: e.target.value as typeof draft.cacheTypeK })}
            >
              {KV_CACHE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        {supports('--cache-type-v') && (
          <Field label="KV cache V (-ctv)">
            <select
              className={inputClass}
              value={draft.cacheTypeV}
              disabled={live}
              onChange={(e) => setDraft({ cacheTypeV: e.target.value as typeof draft.cacheTypeV })}
            >
              {KV_CACHE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Concurrent chats (-np)"
          hint={
            plan && plan.slots > 1
              ? `${plan.contextPerSlot.toLocaleString()} tokens each`
              : 'Context is split across these'
          }
        >
          <input
            type="number"
            min={1}
            max={64}
            className={inputClass}
            value={draft.parallel}
            disabled={live}
            onChange={(e) => setDraft({ parallel: Number(e.target.value) })}
          />
        </Field>
        <Field label="Threads (-t)" hint="-1 lets llama.cpp decide">
          <input
            type="number"
            min={-1}
            className={inputClass}
            value={draft.threads}
            disabled={live}
            onChange={(e) => setDraft({ threads: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        {supports('--flash-attn') && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={draft.flashAttn}
              disabled={live}
              onChange={(e) => setDraft({ flashAttn: e.target.checked })}
            />
            Flash attention (-fa)
          </label>
        )}
        {supports('--no-warmup') && (
          <label
            className="flex items-center gap-2 text-xs text-slate-300"
            title="Some ROCm builds segfault during the warmup run. Enable this if launching crashes immediately after loading."
          >
            <input
              type="checkbox"
              checked={draft.noWarmup}
              disabled={live}
              onChange={(e) => setDraft({ noWarmup: e.target.checked })}
            />
            Skip warmup (--no-warmup)
          </label>
        )}
      </div>

      <Field label="Extra flags" hint="Passed through verbatim">
        <input
          type="text"
          className={inputClass}
          placeholder="--mlock --no-mmap"
          value={draft.extraArgs}
          disabled={live}
          onChange={(e) => setDraft({ extraArgs: e.target.value })}
        />
      </Field>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={live || busy || !binary?.path}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink
                     hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Launch
        </button>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={!live || busy}
          className="flex-1 rounded-md border border-edge px-3 py-2 text-sm font-medium
                     hover:border-rose-500 hover:text-rose-200 disabled:opacity-40"
        >
          Stop
        </button>
      </div>

      <LocalApi status={status} />

      <section className="mt-2 border-t border-edge pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted">Devices</h2>
          <button
            type="button"
            onClick={() => void refreshDevices()}
            className="text-[11px] text-muted hover:text-accent"
          >
            Refresh
          </button>
        </div>
        {devices.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted">CPU only — no GPU devices reported.</p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className="mt-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-300">
                  {d.id} · {d.name}
                </span>
                <span className="text-muted">
                  {(d.totalMiB - d.freeMiB).toLocaleString()} / {d.totalMiB.toLocaleString()} MiB
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink">
                <div
                  className="h-full bg-accent"
                  style={{
                    width: `${Math.min(100, ((d.totalMiB - d.freeMiB) / d.totalMiB) * 100)}%`
                  }}
                />
              </div>
            </div>
          ))
        )}
      </section>

      {binary && binary.path !== '' && (
        <footer className="mt-auto pt-3 text-[11px] leading-relaxed text-muted/70">
          {binaries.length > 1 ? (
            <Field
              label="llama.cpp binary"
              hint="More than one install found — the newest is preferred, but you choose."
            >
              <select
                className={inputClass}
                value={binary.path}
                disabled={live}
                onChange={(e) => void selectBinary(e.target.value)}
              >
                {binaries.map((b) => (
                  <option key={b.path} value={b.path}>
                    {b.label} — {b.path}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="truncate" title={binary.path}>
              {binary.path}
            </div>
          )}
          <div className="mt-1">
            {binary.kind === 'unified' ? 'llama serve' : 'llama-server'} · build {binary.version}
          </div>
          {status?.port && (
            <a
              href={`http://127.0.0.1:${status.port}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              open built-in web UI :{status.port}
            </a>
          )}
        </footer>
      )}
    </aside>
  )
}

/**
 * What coding runs on this model have needed, from the capability record:
 * the cache is sized by the launch and nothing else, so this is the number
 * the launch has to cover, and the trained length is not it. Identifying
 * the file hashes it once; the line waits for that.
 */
function ContextAdvice({ modelPath, current, disabled, onUse }: { modelPath: string; current: number; disabled: boolean; onUse: (n: number) => void }): React.JSX.Element | null {
  const [status, setStatus] = useState<CapabilityStatus | null>(null)
  useEffect(() => {
    let stale = false
    setStatus(null)
    if (!modelPath) return
    void window.llama.coding.capabilityOf(modelPath).then((s) => {
      if (!stale) setStatus(s)
    }).catch(() => undefined)
    return () => {
      stale = true
    }
  }, [modelPath])
  if (!modelPath || !status || status.state !== 'measured') return null
  const advice = contextAdvice(status.record)
  // Nothing to say when the launch already matches; one short line otherwise,
  // with the measurement behind it in the tooltip.
  if (!advice || current === advice.measuredAt) return null
  const detail = `Coding runs on this model reached up to ${advice.max.toLocaleString()} tokens in a request, ${advice.needed.toLocaleString()} for nine in ten, over ${advice.runs} measured runs; the record was measured at ${advice.measuredAt.toLocaleString()}.`
  return (
    <p className="mt-1 text-[11px] leading-snug text-muted" title={detail}>
      {current === 0 ? <span className="text-amber-200">0 is the trained length. </span> : null}
      Coding runs need {advice.measuredAt.toLocaleString()}.{' '}
      <button type="button" disabled={disabled} onClick={() => onUse(advice.measuredAt)} className="text-accent hover:underline disabled:opacity-50">
        Use it
      </button>
    </p>
  )
}

/**
 * Where a mixture-of-experts model keeps its experts. Shown only for such a
 * model, and outside the manual-sizing grid because it applies under auto-fit
 * too: --fit sizes what is left unset around it.
 */
function ExpertOffload({
  blocks,
  value,
  onCpuMiB,
  disabled,
  onChange
}: {
  blocks: number
  value: number
  onCpuMiB: number
  disabled: boolean
  onChange: (cpuMoeLayers: number) => void
}): React.JSX.Element {
  const mode = value === -1 ? 'all' : value > 0 ? 'some' : 'off'
  const hint =
    mode === 'off'
      ? 'Experts stay with their layers. Move them to system RAM when the model is too large for VRAM.'
      : `${Math.round(onCpuMiB).toLocaleString()} MiB of experts in system RAM; attention stays on the GPU.`
  return (
    <Field label="MoE experts in system RAM (--cpu-moe)" hint={hint}>
      <div className="flex gap-2">
        <select
          className={inputClass}
          value={mode}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === 'all' ? -1 : e.target.value === 'some' ? Math.max(1, Math.floor(blocks / 2)) : 0)}
        >
          <option value="off">Off</option>
          <option value="all">All {blocks} layers</option>
          <option value="some">The first N layers</option>
        </select>
        {mode === 'some' && (
          <input
            type="number"
            min={1}
            max={blocks}
            className={inputClass}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(Math.max(1, Math.min(blocks, Number(e.target.value) || 1)))}
          />
        )}
      </div>
    </Field>
  )
}

/**
 * The server as an API for other programs: a port that stays the same across
 * launches, a key, and the local network only with that key. Settings apply
 * from the next launch; while a server runs, its URLs and key can be copied.
 */
function LocalApi({ status }: { status: ServerStatus | null }): React.JSX.Element | null {
  const [api, setApi] = useState<LocalApiSettings | null>(null)
  const [portText, setPortText] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [lanIps, setLanIps] = useState<string[]>([])
  const [problem, setProblem] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    void window.llama.localApi.get().then((a) => {
      setApi(a)
      setPortText(a.port ? String(a.port) : '')
    })
    void window.llama.localApi.lanAddresses().then(setLanIps)
  }, [])
  if (!api) return null

  const save = async (patch: Partial<LocalApiSettings>): Promise<void> => {
    try {
      setApi(await window.llama.localApi.set({ ...api, ...patch }))
      setProblem('')
    } catch (err) {
      setProblem((err as Error).message)
    }
  }
  const commitPort = (): void => {
    const text = portText.trim()
    if (!text) return void save({ port: null })
    const n = Number(text)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return setProblem('A port between 1024 and 65535, or empty for a free one each launch.')
    void save({ port: n })
  }
  const generate = (): void => {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    void save({ apiKey: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') })
  }
  const copy = (label: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const running = status?.phase === 'ready' && status.port ? status : null
  const urls = running ? [`http://127.0.0.1:${running.port}/v1`, ...(running.lan ? lanIps.map((ip) => `http://${ip}:${running.port}/v1`) : [])] : []
  const pending =
    running && ((api.port !== null && api.port !== running.port) || (api.apiKey || null) !== running.apiKey || api.lan !== running.lan)

  return (
    <section className="mt-2 space-y-2 border-t border-edge pt-3">
      <h2 className="text-xs font-semibold text-muted">Local API</h2>
      <p className="text-[11px] leading-snug text-muted">
        Lets other programs — an editor, an agent, a script — use the model this app runs, through its OpenAI-compatible
        API. Settings apply from the next launch.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Port" hint="Empty: a free port each launch">
          <input
            type="number"
            min={1024}
            max={65535}
            placeholder="automatic"
            className={inputClass}
            value={portText}
            onChange={(e) => setPortText(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === 'Enter' && commitPort()}
          />
        </Field>
        <Field label="API key" hint={api.apiKey ? 'Required by every client, this app included' : 'None: anyone on this computer can use it'}>
          <div className="flex gap-1">
            <input
              type={showKey ? 'text' : 'password'}
              className={`${inputClass} min-w-0 font-mono text-xs`}
              value={api.apiKey}
              placeholder="none"
              spellCheck={false}
              onChange={(e) => setApi({ ...api, apiKey: e.target.value })}
              onBlur={() => void save({ apiKey: api.apiKey.trim(), lan: api.apiKey.trim() ? api.lan : false })}
            />
          </div>
          <span className="mt-1 flex gap-2 text-[11px]">
            <button type="button" onClick={generate} className="text-accent hover:underline">Generate</button>
            {api.apiKey && (
              <>
                <button type="button" onClick={() => setShowKey(!showKey)} className="text-muted hover:text-slate-200">{showKey ? 'Hide' : 'Show'}</button>
                <button type="button" onClick={() => void save({ apiKey: '', lan: false })} className="text-muted hover:text-rose-300">Clear</button>
              </>
            )}
          </span>
        </Field>
      </div>
      <label className={`flex items-center gap-2 text-[11px] ${api.apiKey ? 'text-slate-200' : 'text-muted'}`}>
        <input type="checkbox" checked={api.lan} disabled={!api.apiKey} onChange={(e) => void save({ lan: e.target.checked })} />
        Also listen on the local network
        <span className="text-muted">{api.apiKey ? '(other machines need the key)' : '(needs an API key)'}</span>
      </label>
      {problem && <p className="text-[11px] text-rose-300">{problem}</p>}
      {running && (
        <div className="space-y-1 rounded border border-edge bg-ink/60 p-2 text-[11px]">
          {urls.map((u) => (
            <div key={u} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-slate-200">{u}</code>
              <button type="button" onClick={() => copy(u, u)} className="text-accent hover:underline">{copied === u ? 'Copied' : 'Copy'}</button>
            </div>
          ))}
          {running.apiKey && (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-muted">API key</span>
              <button type="button" onClick={() => copy('key', running.apiKey!)} className="text-accent hover:underline">{copied === 'key' ? 'Copied' : 'Copy key'}</button>
            </div>
          )}
          {pending && <p className="text-amber-200/80">The running server was launched with different settings; they apply from the next launch.</p>}
        </div>
      )}
    </section>
  )
}
