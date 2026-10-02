import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerState, McpSnapshot } from '@shared/types.js'
import { useChatStore } from '../state/chatStore.js'
import { splitCommand, slug } from '@shared/command.js'
import { INHERITED_ENV, envLines, parseEnvLines } from '@shared/mcpEnv.js'
import { Field, inputClass } from './Field.js'

/**
 * Where tools come from: the search engine the built-in tools use, and any MCP
 * servers that supply more.
 *
 * Both are here rather than in chat settings because they are properties of the
 * app, not of a conversation — a conversation only chooses which of the
 * resulting tools to declare.
 */
export function ToolSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<McpSnapshot>({ configs: [], states: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loadTools = useChatStore((s) => s.loadTools)

  useEffect(() => {
    void window.llama.mcp.list().then(setSnapshot)
    return window.llama.mcp.onChanged((snap) => {
      setSnapshot(snap)
      // A server reaching ready adds its tools to the list chat picks from.
      void loadTools()
    })
  }, [loadTools])

  const save = async (configs: McpServerConfig[]): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setSnapshot(await window.llama.mcp.save(configs))
      await loadTools()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-edge px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">Tools</h2>
            <p className="text-[11px] text-muted">
              What the model can reach beyond the conversation
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-xs text-muted hover:text-slate-200"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <SearchBackend />
          <McpServers
            snapshot={snapshot}
            busy={busy}
            error={error}
            onSave={save}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The engine behind `web_search`.
 *
 * The default engine rate-limits hard enough that a couple of searches in a row
 * start coming back empty; a SearXNG instance you run yourself does not, which
 * is the only reason this field exists.
 */
function SearchBackend(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.llama.search.getBackend().then((u) => {
      setUrl(u)
      setSaved(u)
    })
  }, [])

  const commit = async (): Promise<void> => {
    if (url.trim() === saved) return
    setError('')
    try {
      const stored = await window.llama.search.setBackend(url)
      setUrl(stored)
      setSaved(stored)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="rounded border border-edge bg-ink/40 p-3">
      <h3 className="text-xs font-semibold text-slate-200">Web search</h3>
      <div className="mt-2">
        <Field
          label="SearXNG instance"
          hint="Leave empty to use the built-in engine, which rate-limits after a few searches in a row. Most public SearXNG instances turn off the JSON API this needs, so in practice this is for one you host yourself."
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void commit()}
            placeholder="http://127.0.0.1:8888"
            spellCheck={false}
            className={inputClass}
          />
        </Field>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
      {!error && saved && <p className="mt-1 text-[11px] text-emerald-300">Searching through {saved}.</p>}
    </section>
  )
}

function McpServers({
  snapshot,
  busy,
  error,
  onSave
}: {
  snapshot: McpSnapshot
  busy: boolean
  error: string
  onSave: (configs: McpServerConfig[]) => Promise<void>
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const { configs, states } = snapshot
  const stateFor = (id: string): McpServerState | undefined => states.find((s) => s.id === id)

  const toggle = (id: string): void => {
    void onSave(configs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)))
  }
  const remove = (id: string): void => {
    void onSave(configs.filter((c) => c.id !== id))
  }
  const setEnv = (id: string, env: Record<string, string>): Promise<void> =>
    onSave(configs.map((c) => (c.id === id ? { ...c, env } : c)))

  return (
    <section className="rounded border border-edge bg-ink/40 p-3">
      <div className="flex items-baseline">
        <h3 className="text-xs font-semibold text-slate-200">MCP servers</h3>
        <span className="ml-2 text-[11px] text-muted">
          Programs that supply extra tools over the Model Context Protocol
        </span>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-slate-200"
          >
            Add server
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}

      {configs.length > 0 && (
        <p className="mt-2 text-[11px] leading-snug text-muted">
          A server gets only {INHERITED_ENV.join(', ')} from Lowerbeam, and what its own environment names. Before
          0.9.20 it got everything Lowerbeam was started with; a server that relied on a token from your shell, such
          as GITHUB_TOKEN, needs it added under Environment.
        </p>
      )}

      {configs.length === 0 && !adding && (
        <p className="mt-2 text-[11px] text-muted">
          None configured. A server is any command that speaks MCP over stdin and stdout, such as{' '}
          <code className="text-slate-300">npx -y @modelcontextprotocol/server-filesystem ~/notes</code>.
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {configs.map((config) => (
          <ServerRow
            key={config.id}
            config={config}
            state={stateFor(config.id)}
            busy={busy}
            onToggle={() => toggle(config.id)}
            onRemove={() => remove(config.id)}
            onSaveEnv={(env) => setEnv(config.id, env)}
          />
        ))}
      </ul>

      {adding && (
        <AddServer
          existing={configs}
          onCancel={() => setAdding(false)}
          onAdd={async (config) => {
            await onSave([...configs, config])
            setAdding(false)
          }}
        />
      )}
    </section>
  )
}

function ServerRow({
  config,
  state,
  busy,
  onToggle,
  onRemove,
  onSaveEnv
}: {
  config: McpServerConfig
  state: McpServerState | undefined
  busy: boolean
  onToggle: () => void
  onRemove: () => void
  onSaveEnv: (env: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [showLog, setShowLog] = useState(false)
  const [editingEnv, setEditingEnv] = useState(false)
  const own = Object.keys(config.env ?? {})
  const status = state?.status ?? 'stopped'

  return (
    <li className="rounded border border-edge bg-panel p-2.5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="text-xs font-medium text-slate-200">{config.name}</span>
        {state?.serverName && state.serverName !== config.name && (
          <span className="text-[11px] text-muted">({state.serverName})</span>
        )}
        {status === 'ready' && (
          <span className="text-[11px] text-muted">
            {state?.tools.length ?? 0} tool{state?.tools.length === 1 ? '' : 's'}
          </span>
        )}

        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={config.enabled} disabled={busy} onChange={onToggle} />
          Enabled
        </label>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-rose-300 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      <code className="mt-1 block truncate text-[11px] text-muted" title={commandLine(config)}>
        {commandLine(config)}
      </code>

      <p className="mt-1 text-[11px] text-muted">
        Environment: the basics{own.length > 0 ? `, and ${own.join(', ')}` : ', nothing of its own'}.{' '}
        <button type="button" onClick={() => setEditingEnv(!editingEnv)} disabled={busy} className="hover:text-slate-200 disabled:opacity-50">
          {editingEnv ? 'Close' : 'Edit'}
        </button>
      </p>
      {editingEnv && (
        <EnvEditor
          initial={config.env}
          onSave={async (env) => {
            await onSaveEnv(env)
            setEditingEnv(false)
          }}
        />
      )}

      {state?.error && <p className="mt-1 text-[11px] text-rose-300">{state.error}</p>}

      {state && state.log.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowLog(!showLog)}
            className="mt-1 text-[11px] text-muted hover:text-slate-200"
          >
            {showLog ? 'Hide output' : 'Show output'}
          </button>
          {showLog && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-ink p-2 text-[11px] leading-snug text-muted">
              {state.log.join('\n')}
            </pre>
          )}
        </>
      )}

      {status === 'ready' && state && state.tools.length > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          {state.tools.map((t) => t.label).join(', ')}
        </p>
      )}
    </li>
  )
}

function AddServer({
  existing,
  onAdd,
  onCancel
}: {
  existing: McpServerConfig[]
  onAdd: (config: McpServerConfig) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [envText, setEnvText] = useState('')
  const [problem, setProblem] = useState('')

  const submit = (): void => {
    const [bin, ...args] = splitCommand(command)
    const id = slug(name || bin || '')
    if (!bin) return setProblem('Enter the command that starts the server.')
    if (!id) return setProblem('Give the server a name using letters or digits.')
    if (existing.some((c) => c.id === id)) return setProblem(`There is already a server called ${id}.`)
    const parsed = parseEnvLines(envText)
    if ('problem' in parsed) return setProblem(parsed.problem)
    const env = Object.keys(parsed.env).length ? { env: parsed.env } : {}
    void onAdd({ id, name: name.trim() || bin, command: bin, args, ...env, enabled: true })
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-edge bg-panel p-2.5">
      <Field label="Name" hint="Also used to prefix this server's tool names, so keep it short.">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="notes"
          className={inputClass}
        />
      </Field>
      <Field label="Command" hint="Run exactly as typed. Quote arguments containing spaces.">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="npx -y @modelcontextprotocol/server-filesystem /home/you/notes"
          spellCheck={false}
          className={`${inputClass} font-mono text-xs`}
        />
      </Field>
      <Field label="Environment" hint={`One NAME=value per line, for what the server needs beyond ${INHERITED_ENV.join(', ')}. Optional.`}>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder="GITHUB_TOKEN=…"
          rows={2}
          spellCheck={false}
          className={`${inputClass} block w-full font-mono text-xs`}
        />
      </Field>
      {problem && <p className="text-[11px] text-rose-300">{problem}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink"
        >
          Add and start
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-edge px-3 py-1 text-xs text-muted hover:text-slate-200"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** A server's own environment as NAME=value lines; saving restarts the server with it. */
function EnvEditor({ initial, onSave }: { initial: Record<string, string> | undefined; onSave: (env: Record<string, string>) => Promise<void> }): React.JSX.Element {
  const [text, setText] = useState(envLines(initial))
  const [problem, setProblem] = useState('')
  const save = (): void => {
    const parsed = parseEnvLines(text)
    if ('problem' in parsed) return setProblem(parsed.problem)
    void onSave(parsed.env)
  }
  return (
    <div className="mt-1 space-y-1">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="GITHUB_TOKEN=…"
        rows={3}
        spellCheck={false}
        className={`${inputClass} block w-full font-mono text-xs`}
      />
      {problem && <p className="text-[11px] text-rose-300">{problem}</p>}
      <div>
        <button type="button" onClick={save} className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink">
          Save and restart
        </button>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: McpServerState['status'] }): React.JSX.Element {
  const colour =
    status === 'ready'
      ? 'bg-emerald-400'
      : status === 'starting'
        ? 'bg-amber-300'
        : status === 'failed'
          ? 'bg-rose-400'
          : 'bg-slate-600'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${colour}`} title={status} />
}

function commandLine(config: McpServerConfig): string {
  return [config.command, ...config.args].join(' ')
}
