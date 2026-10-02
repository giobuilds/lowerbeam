import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import type { McpServerConfig, McpServerState, ToolDefinition, ToolResult } from '@shared/types.js'
import { serverEnv } from '@shared/mcpEnv.js'

/**
 * A client for Model Context Protocol servers.
 *
 * Servers are ordinary programs speaking JSON-RPC 2.0 over stdin and stdout,
 * one message per line. The protocol is small enough that a dependency would
 * cost more than it saved: initialise, ask what tools exist, call one.
 *
 * They are spawned by the main process because they are subprocesses with
 * access to whatever the user gave them — a filesystem path, an API key — and
 * because their tools become tools the model can invoke, which is not something
 * to hand to a renderer.
 */

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/** The version of the protocol this client speaks. */
/**
 * Reported to every server in the handshake, and only ever seen in its logs.
 * Read rather than written down so a release cannot leave it behind.
 */
const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 30_000
/** A server that has not initialised by now is not going to. */
const START_TIMEOUT_MS = 60_000

export interface McpEvents {
  state: [McpServerState]
}

export class McpServer extends EventEmitter<McpEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  private status: McpServerState['status'] = 'stopped'
  private error: string | null = null
  private tools: ToolDefinition[] = []
  private serverName: string | null = null
  /** Last lines of stderr, which is where these servers report their problems. */
  private readonly log: string[] = []

  constructor(readonly config: McpServerConfig) {
    super()
  }

  get state(): McpServerState {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      error: this.error,
      tools: this.tools,
      serverName: this.serverName,
      log: [...this.log]
    }
  }

  private setStatus(status: McpServerState['status'], error: string | null = null): void {
    this.status = status
    this.error = error
    this.emit('state', this.state)
  }

  async start(): Promise<void> {
    if (this.child) return
    this.setStatus('starting')

    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only what any program needs, then what this server's config names:
      // not every secret in the environment Lowerbeam was started from.
      env: serverEnv(process.env, this.config.env),
      detached: true
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        this.log.push(line.trim())
      }
      if (this.log.length > 40) this.log.splice(0, this.log.length - 40)
    })

    child.on('error', (err) => {
      this.child = null
      this.setStatus('failed', err.message)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      this.failPending(new Error('The server exited.'))
      if (this.status !== 'stopped') {
        const how = signal ? `killed by ${signal}` : `exit code ${code}`
        // The last stderr line is usually the actual reason.
        this.setStatus('failed', `${this.lastLogLine() || 'The server stopped'} (${how})`)
      }
    })

    try {
      const init = (await this.withTimeout(
        this.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Lowerbeam', version: VERSION }
        }),
        START_TIMEOUT_MS
      )) as { serverInfo?: { name?: string } }
      this.serverName = init?.serverInfo?.name ?? null

      // The protocol requires telling the server we are ready before using it.
      this.notify('notifications/initialized', {})

      const listed = (await this.request('tools/list', {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
      }
      this.tools = (listed.tools ?? []).map((t) => ({
        // Namespaced, so two servers offering "search" do not collide and the
        // model can tell whose tool it is calling.
        name: `${this.config.id}__${t.name}`,
        label: t.name,
        description: t.description ?? `${t.name} (from ${this.config.name})`,
        parameters: normaliseSchema(t.inputSchema)
      }))
      this.setStatus('ready')
    } catch (err) {
      this.stop()
      this.setStatus('failed', err instanceof Error ? err.message : String(err))
    }
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.status !== 'ready') {
      return { ok: false, summary: `${this.config.name} is not running`, content: 'The server is not available.' }
    }
    const bare = toolName.startsWith(`${this.config.id}__`)
      ? toolName.slice(this.config.id.length + 2)
      : toolName
    try {
      const result = (await this.request('tools/call', { name: bare, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>
        isError?: boolean
      }
      // Only text is usable in a chat transcript; other content types are
      // named rather than dropped silently.
      const text = (result.content ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type ?? 'content'}]`))
        .join('\n')
        .trim()
      return {
        ok: !result.isError,
        summary: `${bare} via ${this.config.name}`,
        content: text || '(the tool returned nothing)'
      }
    } catch (err) {
      return {
        ok: false,
        summary: `${bare} failed`,
        content: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** The process group the server runs in, while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  stop(): void {
    this.setStatus('stopped')
    this.failPending(new Error('The server was stopped.'))
    const pid = this.child?.pid
    this.child = null
    if (!pid) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    // Messages are newline-delimited, and a chunk can split one anywhere.
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue // servers sometimes print stray output on stdout
      }
      if (message.id === undefined) continue // a notification from the server
      const waiting = this.pending.get(message.id)
      if (!waiting) continue
      clearTimeout(waiting.timer)
      this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const child = this.child
    if (!child) return Promise.reject(new Error('The server is not running.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out.`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private failPending(error: Error): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.pending.clear()
  }

  private lastLogLine(): string {
    return this.log[this.log.length - 1] ?? ''
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('The server did not start in time.')), ms)
      )
    ])
  }
}

/**
 * MCP describes tools with JSON Schema, which is richer than the subset the
 * chat API accepts. Anything not expressible is dropped rather than passed on,
 * since an unusable schema makes the whole request fail.
 */
function normaliseSchema(schema: unknown): ToolDefinition['parameters'] {
  const s = schema as
    | { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    | undefined
  const properties: ToolDefinition['parameters']['properties'] = {}
  for (const [key, value] of Object.entries(s?.properties ?? {})) {
    properties[key] = {
      type: typeof value?.type === 'string' ? value.type : 'string',
      ...(value?.description ? { description: value.description } : {})
    }
  }
  return { type: 'object', properties, required: s?.required ?? [] }
}
