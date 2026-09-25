/**
 * The engine comparison: Pi and OpenCode, as shipped, on the same tasks, the
 * same model server and the same workspace copies as the reference loop.
 *
 * Each engine runs its own CLI with its own tools, prompt and compaction —
 * that is what is being compared — inside a box the harness owns, because
 * neither has a boundary the harness can rely on and the poisoned tasks ask
 * for a file outside the project:
 *
 * - bubblewrap with every namespace unshared, network included. The only way
 *   out is the model server, bridged by socat over a unix socket in the run's
 *   own directory, so a request to anywhere else fails the way it would on a
 *   machine with no network at all.
 * - /home is empty; the run's directory (the copy, the canary beside it, the
 *   engine's own state) is the only writable place.
 *
 * What each engine is told about the machine is the same as the reference:
 * the window the server has, and nothing to download. Pi's compaction
 * reserve is sized to that window (its default reserve is the whole of it).
 * OpenCode runs with LSP and formatters off, since both would download.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** `pi-tools` is Pi's loop with only Lowerbeam's tools, under the grant: see pi-tools.ts. */
export type Engine = 'reference' | 'pi' | 'opencode' | 'pi-tools'
export const ENGINES: Engine[] = ['reference', 'pi', 'opencode', 'pi-tools']

/** Pinned in tests/harness/engines/package.json, and ripgrep and fd beside them, installed by engines/setup.sh. */
const HERE = join(process.cwd(), 'tests/harness/engines')
const PI = join(HERE, 'node_modules/.bin/pi')
const OPENCODE = join(homedir(), '.opencode/bin/opencode')
const TOOLS = join(HERE, 'bin')

export interface ToolCall {
  name: string
  args: string
  ok: boolean
  /** The whole result the model was shown. */
  result: string
}

export interface EngineRun {
  answer: string
  outcome: 'answered' | 'timeout' | 'error' | 'no answer'
  error: string | null
  rounds: number
  ms: number
  promptTokens: number
  predictedTokens: number
  /** Tool calls the engine refused itself: a permission it denied, or a path it would not follow. */
  denials: number
  compactions: number
  calls: ToolCall[]
}

export interface EngineOptions {
  engine: Exclude<Engine, 'reference'>
  /** The directory the engine is started in: the copy the task runs against. */
  cwd: string
  /** The run's own directory, holding the copy and the canary; the one writable place. */
  base: string
  prompt: string
  mode: 'inspect' | 'edit'
  contextLimit: number
  timeoutMs: number
  port: number
  model: string
  /** Where the engine's raw output is kept, beside the harness's own journals. */
  transcript: string
}

export async function engineVersion(engine: Exclude<Engine, 'reference'>): Promise<string> {
  if (engine === 'pi' || engine === 'pi-tools') {
    const pkg = JSON.parse(await readFile(join(HERE, 'node_modules/@mariozechner/pi-coding-agent/package.json'), 'utf8')) as { version: string }
    return `pi-coding-agent ${pkg.version}${engine === 'pi-tools' ? ' on Lowerbeam\'s tools' : ''}`
  }
  return `opencode ${execFileSync(OPENCODE, ['--version']).toString().trim()}`
}

export async function runEngine(o: EngineOptions & { engine: 'pi' | 'opencode' }): Promise<EngineRun> {
  const state = join(o.base, 'engine')
  await mkdir(state, { recursive: true })
  // A project, the way a person's project is one: OpenCode takes the git
  // root as the project, and with none it takes "/" and its boundary
  // around the project never applies. The copy skips .git for the diff.
  execFileSync('git', ['init', '-q'], { cwd: o.cwd })

  const argv = o.engine === 'pi' ? await piArgs(o, state) : await opencodeArgs(o, state)
  const env = o.engine === 'pi' ? { PI_CODING_AGENT_DIR: join(state, 'pi'), PI_OFFLINE: '1', PI_TELEMETRY: '0' } : opencodeEnv(state)

  const sock = join(o.base, 'model.sock')
  const bridge = spawn('socat', [`UNIX-LISTEN:${sock},fork`, `TCP:127.0.0.1:${o.port}`], { stdio: 'ignore' })
  const started = Date.now()
  let outcome: EngineRun['outcome'] | null = null
  let stdout = ''
  let stderr = ''
  try {
    for (let i = 0; i < 50; i++) {
      if (await exists(sock)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const child = spawn('bwrap', [...box(o, state, env), '/usr/bin/bash', '-c', INSIDE, 'bash', String(o.port), sock, ...argv], {
      stdio: [o.engine === 'pi' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: true
    })
    child.stdout!.on('data', (c: Buffer) => (stdout += c))
    child.stderr!.on('data', (c: Buffer) => (stderr = (stderr + c).slice(-20_000)))
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)))
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), o.timeoutMs)))
    const done = o.engine === 'pi' ? piSettled(child, o.prompt, () => stdout) : exited
    const first = await Promise.race([done, exited, timeout])
    clearTimeout(timer)
    if (first === 'timeout') outcome = 'timeout'
    if (child.exitCode === null) {
      kill(child)
      await exited
    }
  } finally {
    bridge.kill('SIGKILL')
  }
  const ms = Date.now() - started
  await writeFile(o.transcript, stdout)
  if (stderr.trim()) await writeFile(o.transcript.replace(/\.jsonl$/, '.stderr.txt'), stderr)

  const parsed = o.engine === 'pi' ? parsePi(stdout) : await readOpencode(state)
  const final: EngineRun['outcome'] = outcome ?? (parsed.error ? 'error' : parsed.answer.trim() ? 'answered' : 'no answer')
  if (o.engine === 'opencode') await writeFile(o.transcript, JSON.stringify(parsed.calls.map((c) => ({ ...c, result: c.result.slice(0, 2000) })), null, 1))
  return { ...parsed, outcome: final, ms }
}

/**
 * Inside the box: the model server's port on the box's own loopback,
 * forwarded to the socket the harness bridges, then the engine.
 */
const INSIDE = 'socat TCP-LISTEN:"$1",bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$2" & i=0; while [ $i -lt 50 ] && ! (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; do sleep 0.1; i=$((i+1)); done; shift 2; exec "$@"'

function box(o: EngineOptions, state: string, env: Record<string, string>): string[] {
  const node = dirname(dirname(process.execPath))
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--ro-bind', node, node,
    '--ro-bind', HERE, HERE,
    '--bind', o.base, o.base,
    '--chdir', o.cwd,
    '--clearenv',
    '--setenv', 'HOME', join(state, 'home'),
    '--setenv', 'PATH', `${TOOLS}:${join(node, 'bin')}:/usr/bin`,
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'TERM', 'dumb'
  ]
  if (o.engine === 'opencode') args.push('--ro-bind', dirname(OPENCODE), dirname(OPENCODE))
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v)
  return args
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function kill(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

// ---- Pi -------------------------------------------------------------------

/**
 * Pi over its RPC mode, the way an application drives it. Print mode exits
 * at the end of the agent's turn, and Pi's compaction runs just after it:
 * on the first full matrix Pi began compacting on an overflow nine times and
 * exited before it finished or retried. Here the prompt is sent, and the run
 * is over only when Pi says it is idle, with no compaction in flight and no
 * retry owed, on two polls a second apart.
 */
async function piSettled(child: ChildProcess, prompt: string, out: () => string): Promise<'settled'> {
  // A write after the box is gone is an EPIPE, not a crash of the harness.
  child.stdin!.on('error', () => {})
  child.stdin!.write(JSON.stringify({ type: 'prompt', message: prompt }) + '\n')
  let seen = 0
  let ended = false
  // Pi reports a failed overflow recovery as a compaction_end with no start.
  let compacting = false
  let owed = false
  let idle = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null || child.signalCode !== null) return 'settled'
    const lines = out().split('\n')
    for (const line of lines.slice(seen, -1)) {
      let e: { type?: string; willRetry?: boolean; command?: string; data?: { isStreaming?: boolean; isCompacting?: boolean } }
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e.type === 'agent_start') owed = false
      else if (e.type === 'agent_end') ended = true
      else if (e.type === 'compaction_start') compacting = true
      else if (e.type === 'compaction_end') {
        compacting = false
        if (e.willRetry) owed = true
      } else if (e.type === 'response' && e.command === 'get_state') {
        idle = ended && !owed && !compacting && !e.data?.isStreaming && !e.data?.isCompacting ? idle + 1 : 0
      }
    }
    seen = lines.length - 1
    if (idle >= 2) return 'settled'
    child.stdin!.write(JSON.stringify({ type: 'get_state' }) + '\n')
  }
}

async function piArgs(o: EngineOptions, state: string): Promise<string[]> {
  const dir = join(state, 'pi')
  await mkdir(join(state, 'home'), { recursive: true })
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        lowerbeam: {
          baseUrl: `http://127.0.0.1:${o.port}/v1`,
          api: 'openai-completions',
          apiKey: 'none',
          // llama-server takes the system prompt as a system message and has
          // no reasoning_effort; the reasoning budget is the server's.
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: o.model, reasoning: true, contextWindow: o.contextLimit, maxTokens: 4096 }]
        }
      }
    })
  )
  // Pi compacts when the context passes the window less this reserve. Its
  // default reserve is 16,384 — the whole window here — so it overflowed the
  // server on the first smoke run instead of compacting.
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 6000 } }))
  const tools = o.mode === 'edit' ? 'read,grep,find,ls,edit,write' : 'read,grep,find,ls'
  return [
    PI,
    '--provider', 'lowerbeam', '--model', o.model,
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--tools', tools,
    '--mode', 'rpc'
  ]
}

interface PiEvent {
  type: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: { content?: Array<{ type: string; text?: string }> }
  isError?: boolean
  message?: PiMessage
  messages?: PiMessage[]
}
interface PiMessage {
  role: string
  content?: Array<{ type: string; text?: string }>
  stopReason?: string
  errorMessage?: string
  usage?: { input?: number; output?: number; cacheRead?: number }
}

export function parsePi(stdout: string): Omit<EngineRun, 'outcome' | 'ms'> {
  const calls: ToolCall[] = []
  const started = new Map<string, { name: string; args: string }>()
  let rounds = 0
  let promptTokens = 0
  let predictedTokens = 0
  let compactions = 0
  let last: PiMessage | null = null
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let e: PiEvent
    try {
      e = JSON.parse(line) as PiEvent
    } catch {
      continue
    }
    if (e.type === 'tool_execution_start') started.set(e.toolCallId!, { name: e.toolName!, args: JSON.stringify(e.args) })
    else if (e.type === 'tool_execution_end') {
      const s = started.get(e.toolCallId!) ?? { name: e.toolName!, args: '' }
      calls.push({ ...s, ok: !e.isError, result: (e.result?.content ?? []).map((c) => c.text ?? '').join('') })
    } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
      rounds += 1
      promptTokens += (e.message.usage?.input ?? 0) + (e.message.usage?.cacheRead ?? 0)
      predictedTokens += e.message.usage?.output ?? 0
      last = e.message
    } else if (e.type === 'compaction_end') compactions += 1
  }
  const answer = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim()
  const error = last?.stopReason === 'error' ? last.errorMessage ?? 'error' : null
  return { answer: error ? '' : answer, error, rounds, promptTokens, predictedTokens, denials: 0, compactions, calls }
}

// ---- OpenCode ---------------------------------------------------------------

function opencodeEnv(state: string): Record<string, string> {
  return {
    OPENCODE_CONFIG: join(state, 'opencode.json'),
    XDG_CONFIG_HOME: join(state, 'config'),
    XDG_DATA_HOME: join(state, 'data'),
    XDG_STATE_HOME: join(state, 'state'),
    XDG_CACHE_HOME: join(state, 'cache'),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1'
  }
}

async function opencodeArgs(o: EngineOptions, state: string): Promise<string[]> {
  await mkdir(join(state, 'home'), { recursive: true })
  await writeFile(
    join(state, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      lsp: false,
      formatter: false,
      provider: {
        lowerbeam: {
          npm: '@ai-sdk/openai-compatible',
          name: 'lowerbeam',
          options: { baseURL: `http://127.0.0.1:${o.port}/v1` },
          models: { [o.model]: { name: o.model, limit: { context: o.contextLimit, output: 4096 } } }
        }
      },
      model: `lowerbeam/${o.model}`,
      // The same grant the reference gets: read-only, or edits and nothing
      // to run. Everything else is OpenCode's own default.
      permission: o.mode === 'edit' ? { bash: 'deny', webfetch: 'deny' } : { edit: 'deny', bash: 'deny', webfetch: 'deny' }
    })
  )
  return [OPENCODE, 'run', '--pure', '--format', 'json', '-m', `lowerbeam/${o.model}`, o.prompt]
}

interface OcPart {
  type: string
  text?: string
  tool?: string
  state?: { status?: string; input?: unknown; output?: string; error?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
}

/**
 * OpenCode's JSON stream stops at a subagent and is not the record; its own
 * session database is. Every session the run made is read, the root's last
 * assistant text is the answer, and a subagent's tool calls count as the
 * run's — the model asked for them either way.
 */
export async function readOpencode(state: string): Promise<Omit<EngineRun, 'outcome' | 'ms'>> {
  const empty = { answer: '', error: 'no session database', rounds: 0, promptTokens: 0, predictedTokens: 0, denials: 0, compactions: 0, calls: [] }
  let db: import('node:sqlite').DatabaseSync
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(join(state, 'data/opencode/opencode.db'), { readOnly: true })
  } catch {
    return empty
  }
  try {
    const sessions = db.prepare('select id, parent_id from session').all() as Array<{ id: string; parent_id: string | null }>
    const root = sessions.find((s) => !s.parent_id)
    if (!root) return empty
    const parts = db.prepare('select session_id, message_id, data from part order by time_created, rowid').all() as Array<{ session_id: string; message_id: string; data: string }>
    const messages = db.prepare('select id, session_id, data from message order by time_created, rowid').all() as Array<{ id: string; session_id: string; data: string }>
    const calls: ToolCall[] = []
    let rounds = 0
    let promptTokens = 0
    let predictedTokens = 0
    let compactions = 0
    let denials = 0
    for (const row of parts) {
      const p = JSON.parse(row.data) as OcPart
      if (p.type === 'step-finish') {
        rounds += 1
        promptTokens += (p.tokens?.input ?? 0) + (p.tokens?.cache?.read ?? 0)
        predictedTokens += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0)
      } else if (p.type === 'compaction') compactions += 1
      else if (p.type === 'tool') {
        const ok = p.state?.status === 'completed'
        const result = ok ? p.state?.output ?? '' : p.state?.error ?? p.state?.status ?? ''
        if (!ok && /permission|rejected|denied|not allowed|outside/i.test(result)) denials += 1
        calls.push({ name: p.tool ?? '', args: JSON.stringify(p.state?.input ?? {}), ok, result })
      }
    }
    const lastAssistant = messages.filter((m) => m.session_id === root.id && (JSON.parse(m.data) as { role: string }).role === 'assistant').at(-1)
    const lastData = lastAssistant ? (JSON.parse(lastAssistant.data) as { error?: { name?: string; data?: { message?: string } } }) : null
    const answer = lastAssistant
      ? parts
          .filter((p) => p.message_id === lastAssistant.id)
          .map((p) => JSON.parse(p.data) as OcPart)
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('')
          .trim()
      : ''
    const error = lastData?.error ? `${lastData.error.name ?? 'error'}: ${lastData.error.data?.message ?? ''}` : null
    return { answer, error, rounds, promptTokens, predictedTokens, denials, compactions, calls }
  } finally {
    db.close()
  }
}
