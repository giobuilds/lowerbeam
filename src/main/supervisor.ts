import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { DEFAULT_LOCAL_API, type BinaryInfo, type LaunchConfig, type LocalApiSettings, type ServerPhase, type ServerStatus } from '@shared/types.js'
import { authHeaders } from '@shared/chatClient.js'
import { serverHandoffSchema, type ServerHandoff } from '@shared/schema.js'
import { LogBuffer, LineSplitter } from './logBuffer.js'

/** stdin is 'ignore', so the child has no writable stdin. */
type LlamaChild = ChildProcessByStdio<null, Readable, Readable>

const HEALTH_INTERVAL_MS = 1000
const HEALTH_TIMEOUT_MS = 2000
/** Consecutive failed health checks after 'ready' before we call it degraded. */
const DEGRADED_AFTER = 3
/** How long we wait for a polite SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 5000

/**
 * Log substrings that mark a lifecycle transition. Verified against the strings
 * embedded in llama-server b6153 rather than assumed:
 *   srv    load_model: loading model '%s'
 *   main: model loaded
 *   main: server is listening on %s - starting the main loop
 *   main: failed to load model '%s'
 */
const STAGE_MARKERS: Array<{ match: RegExp; stage: string }> = [
  { match: /loading model/i, stage: 'Loading model' },
  { match: /model loaded/i, stage: 'Model loaded, warming up' },
  // The classic server says "HTTP server is listening"; the unified CLI says
  // "listening on http://…". Both shapes are matched.
  { match: /HTTP server is listening|listening on http/i, stage: 'Starting HTTP server' }
]
const FAILURE_MARKER =
  /failed to load (model|models on startup|draft model|multimodal model)|error loading model/i

export interface SupervisorEvents {
  status: [ServerStatus]
  log: [] // a hint that new lines exist; renderer pulls the delta by seq
}

/**
 * Owns exactly one llama-server child process.
 *
 * Readiness is decided by polling GET /health, not by log scraping: the log
 * only tells us what stage we are in for display purposes, while /health is
 * the authoritative signal (it returns 503 "Loading model" until the model is
 * actually resident).
 */
export class ServerSupervisor extends EventEmitter<SupervisorEvents> {
  readonly logs = new LogBuffer()

  private child: LlamaChild | null = null
  private phase: ServerPhase = 'stopped'
  private port: number | null = null
  private pid: number | null = null
  private config: LaunchConfig | null = null
  private loadStage: string | null = null
  private error: string | null = null
  private exitCode: number | null = null
  private readyAt: number | null = null
  private startedAt: number | null = null
  private adopted = false
  private modalities: ServerStatus['modalities'] = null
  private supportsTools = false
  private contextPerSlot: number | null = null
  /** The key and binding the running server was launched with. */
  private apiKey: string | null = null
  private lan = false

  private healthTimer: NodeJS.Timeout | null = null
  private healthFailures = 0
  /** Set while stop() is in flight so the exit handler knows it was intentional. */
  private stopping: Promise<void> | null = null

  constructor(
    private binary: BinaryInfo,
    private readonly handoffPath: string
  ) {
    super()
  }

  /** Swapping the binary is only legal while nothing is running. */
  setBinary(binary: BinaryInfo): void {
    if (this.child) throw new Error('Stop the running server before changing the binary.')
    this.binary = binary
  }

  get binaryInfo(): BinaryInfo {
    return this.binary
  }

  get status(): ServerStatus {
    return {
      phase: this.phase,
      pid: this.pid,
      port: this.port,
      config: this.config,
      loadStage: this.loadStage,
      startedAt: this.startedAt,
      error: this.error,
      exitCode: this.exitCode,
      readyAt: this.readyAt,
      adopted: this.adopted,
      modalities: this.modalities,
      supportsTools: this.supportsTools,
      contextPerSlot: this.contextPerSlot,
      apiKey: this.apiKey,
      lan: this.lan
    }
  }

  get baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  private setPhase(phase: ServerPhase, patch?: Partial<{ error: string | null; stage: string | null }>): void {
    this.phase = phase
    if (patch && 'error' in patch) this.error = patch.error ?? null
    if (patch && 'stage' in patch) this.loadStage = patch.stage ?? null
    this.emit('status', this.status)
  }

  private appendLog(stream: 'stdout' | 'stderr' | 'app', text: string): void {
    this.logs.append(stream, text)
    this.emit('log')
  }

  async start(config: LaunchConfig, api: LocalApiSettings = DEFAULT_LOCAL_API): Promise<void> {
    if (this.child) throw new Error('A server is already running. Stop it first.')

    if (!this.binary.path) throw new Error('No llama.cpp binary selected.')
    // The local network only with a key: an open llama-server on the LAN is
    // anyone's to use, and --slots and --props tell them what it holds.
    if (api.lan && !api.apiKey) throw new Error('Listening on the local network needs an API key. Set one in Local API, or turn the network off.')
    const host = api.lan ? '0.0.0.0' : '127.0.0.1'
    let port: number
    if (api.port) {
      if (!(await portFree(api.port, host))) {
        throw new Error(`Port ${api.port} is in use by another program. Choose another in Local API, or leave it empty for a free one each launch.`)
      }
      port = api.port
    } else {
      port = await pickFreePort()
    }
    const args = buildArgs(config, port, this.binary, { host, apiKey: api.apiKey || null })

    this.config = config
    this.apiKey = api.apiKey || null
    this.lan = api.lan
    this.port = port
    this.exitCode = null
    this.readyAt = null
    this.adopted = false
    this.healthFailures = 0
    this.startedAt = Date.now()
    this.setPhase('starting', { error: null, stage: 'Spawning process' })
    // The log is on screen; the key is not shown in it.
    this.appendLog('app', `$ ${this.binary.path} ${redactKey(args).join(' ')}`)

    const child = spawn(this.binary.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a SIGKILL escalation can take down anything it forked.
      detached: true
    })
    this.child = child
    this.pid = child.pid ?? null

    this.wireStream(child, 'stdout')
    this.wireStream(child, 'stderr')

    child.on('error', (err) => {
      this.appendLog('app', `spawn failed: ${err.message}`)
      this.child = null
      this.pid = null
      this.setPhase('crashed', { error: err.message, stage: null })
    })

    child.on('exit', (code, signal) => {
      this.exitCode = code
      this.stopHealthPolling()
      this.appendLog('app', `process exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
      const wasIntentional = this.stopping !== null
      this.child = null
      this.pid = null
      this.modalities = null
      this.supportsTools = false
      this.contextPerSlot = null
      void rm(this.handoffPath, { force: true })
      if (wasIntentional) {
        this.setPhase('stopped', { error: null, stage: null })
      } else {
        this.setPhase('crashed', {
          error: this.error ?? this.describeCrash(code, signal),
          stage: null
        })
      }
    })

    await this.writeHandoff({ pid: child.pid!, port, startedAt: this.startedAt, config, apiKey: this.apiKey, lan: this.lan })
    this.startHealthPolling()
  }

  /**
   * "exited unexpectedly (code null)" tells a user nothing actionable. A signal
   * is more informative than an absent exit code, and one failure mode is
   * common enough to name: the warmup pass segfaults on some ROCm builds, which
   * looks like a hard crash immediately after the warmup log line.
   */
  private describeCrash(code: number | null, signal: NodeJS.Signals | null): string {
    const recent = this.logs.since(Math.max(0, this.logs.latestSeq - 5))
    const diedInWarmup = recent.some((l) => /warming up the model/i.test(l.text))
    const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`

    if (signal === 'SIGSEGV' && diedInWarmup && !this.config?.noWarmup) {
      return (
        `llama-server ${how} during the model warmup run. This is a known ` +
        `failure on some ROCm builds rather than a problem with the model — ` +
        `enable "Skip warmup (--no-warmup)" and launch again.`
      )
    }
    return `llama-server ${how}.`
  }

  private wireStream(child: LlamaChild, name: 'stdout' | 'stderr'): void {
    const splitter = new LineSplitter()
    const stream = child[name]
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.handleLine(name, line)
    })
    stream.on('end', () => {
      for (const line of splitter.flush()) this.handleLine(name, line)
    })
  }

  private handleLine(stream: 'stdout' | 'stderr', line: string): void {
    this.appendLog(stream, line)

    if (FAILURE_MARKER.test(line)) {
      // Record it, but let the exit handler decide the terminal phase — the
      // process may still print more context before it goes.
      this.error = line.trim()
      this.emit('status', this.status)
      return
    }
    if (this.phase === 'starting' || this.phase === 'loading') {
      for (const { match, stage } of STAGE_MARKERS) {
        if (match.test(line)) {
          this.setPhase('loading', { stage })
          return
        }
      }
    }
  }

  private startHealthPolling(): void {
    this.stopHealthPolling()
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS)
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private async checkHealth(): Promise<void> {
    const url = this.baseUrl
    if (!url) return
    const healthy = await probeHealth(url)

    if (healthy) {
      this.healthFailures = 0
      if (this.phase !== 'ready') {
        this.readyAt = Date.now()
        this.setPhase('ready', { error: null, stage: null })
        // What the model can actually accept is only knowable once it is
        // loaded, and passing --mmproj is not proof it took effect.
        void this.readModalities()
      }
      return
    }

    // An adopted process has no 'exit' event to tell us it died, so its
    // disappearance is detected here rather than being reported as 'degraded'.
    if (this.adopted && this.pid !== null && !isAlive(this.pid)) {
      this.stopHealthPolling()
      this.appendLog('app', `adopted server pid ${this.pid} is gone`)
      this.pid = null
      this.adopted = false
      void rm(this.handoffPath, { force: true })
      this.setPhase('crashed', { error: 'The adopted llama-server exited.', stage: null })
      return
    }

    // A 503 during startup is expected — that is llama-server saying "Loading model".
    if (this.phase === 'ready') {
      this.healthFailures += 1
      if (this.healthFailures >= DEGRADED_AFTER) this.setPhase('degraded')
    } else if (this.phase === 'degraded') {
      this.healthFailures += 1
    }
  }

  private async readModalities(): Promise<void> {
    const url = this.baseUrl
    if (!url) return
    try {
      const res = await fetch(`${url}/props`, { headers: authHeaders(this.apiKey), signal: AbortSignal.timeout(5000) })
      if (!res.ok) return
      const props = (await res.json()) as {
        modalities?: { vision?: boolean; audio?: boolean; video?: boolean }
        chat_template_caps?: { supports_tools?: boolean; supports_tool_calls?: boolean }
        default_generation_settings?: { n_ctx?: number }
      }
      // What one conversation actually gets. `--ctx-size` is the total across
      // slots, so with --parallel 4 a chat has a quarter of it — the number
      // that decides when a reply stops mid-sentence.
      this.contextPerSlot = props.default_generation_settings?.n_ctx ?? null
      this.supportsTools = Boolean(
        props.chat_template_caps?.supports_tools && props.chat_template_caps?.supports_tool_calls
      )
      this.modalities = {
        vision: Boolean(props.modalities?.vision),
        audio: Boolean(props.modalities?.audio),
        video: Boolean(props.modalities?.video)
      }
      this.emit('status', this.status)
    } catch {
      // Telemetry only — a server that will not answer /props still works.
    }
  }

  /** Idempotent: concurrent callers await the same shutdown. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping

    const child = this.child
    const pid = this.pid
    if (!child && pid == null) {
      this.setPhase('stopped', { error: null, stage: null })
      return
    }

    this.setPhase('stopping', { stage: null })
    this.stopping = child
      ? this.stopSpawned(child)
      : // An adopted server is not our child: there is no 'exit' event to wait
        // on, so liveness has to be polled. Without this branch Stop would
        // report success while the process kept running and holding VRAM.
        this.stopAdopted(pid!)

    try {
      await this.stopping
    } finally {
      this.stopping = null
    }
  }

  private stopSpawned(child: LlamaChild): Promise<void> {
    return new Promise<void>((resolve) => {
      const pid = child.pid!
      const escalation = setTimeout(() => {
        this.appendLog('app', `did not exit after ${TERM_GRACE_MS}ms, sending SIGKILL`)
        killGroup(pid, 'SIGKILL')
      }, TERM_GRACE_MS)

      child.once('exit', () => {
        clearTimeout(escalation)
        resolve()
      })
      killGroup(pid, 'SIGTERM')
    })
  }

  private async stopAdopted(pid: number): Promise<void> {
    this.appendLog('app', `stopping adopted server pid ${pid}`)
    killGroup(pid, 'SIGTERM')

    const deadline = Date.now() + TERM_GRACE_MS
    while (Date.now() < deadline) {
      if (!isAlive(pid)) break
      await delay(150)
    }
    if (isAlive(pid)) {
      this.appendLog('app', `adopted pid ${pid} ignored SIGTERM, sending SIGKILL`)
      killGroup(pid, 'SIGKILL')
      await delay(300)
    }

    this.stopHealthPolling()
    this.pid = null
    this.adopted = false
    await rm(this.handoffPath, { force: true })
    this.setPhase(isAlive(pid) ? 'degraded' : 'stopped', {
      error: isAlive(pid) ? `could not terminate pid ${pid}` : null,
      stage: null
    })
  }

  /** Called on app quit. Best-effort and synchronous-ish; never throws. */
  async shutdown(): Promise<void> {
    try {
      await this.stop()
    } catch (err) {
      this.appendLog('app', `shutdown error: ${(err as Error).message}`)
    } finally {
      this.stopHealthPolling()
    }
  }

  private async writeHandoff(handoff: ServerHandoff): Promise<void> {
    try {
      await writeFile(this.handoffPath, JSON.stringify(handoff), 'utf8')
    } catch (err) {
      this.appendLog('app', `could not write handoff file: ${(err as Error).message}`)
    }
  }

  /**
   * On startup, a handoff file means a previous run left a server behind.
   * If it is still alive and healthy we adopt it; if it is alive but not ours
   * to trust, or dead, we clean up. This is what stops the app from leaking a
   * second llama-server every time it crashes.
   */
  async adoptOrReap(): Promise<void> {
    let handoff: ServerHandoff
    try {
      const raw = await readFile(this.handoffPath, 'utf8')
      handoff = serverHandoffSchema.parse(JSON.parse(raw))
    } catch {
      return // no handoff, or unreadable — nothing to do
    }

    if (!isAlive(handoff.pid)) {
      this.appendLog('app', `cleaning up stale handoff for dead pid ${handoff.pid}`)
      await rm(this.handoffPath, { force: true })
      return
    }

    const url = `http://127.0.0.1:${handoff.port}`
    if (await probeHealth(url)) {
      this.pid = handoff.pid
      this.port = handoff.port
      this.config = handoff.config
      this.apiKey = handoff.apiKey
      this.lan = handoff.lan
      this.startedAt = handoff.startedAt
      this.readyAt = Date.now()
      this.adopted = true
      this.appendLog('app', `adopted running llama-server pid ${handoff.pid} on port ${handoff.port}`)
      this.setPhase('ready', { error: null, stage: null })
      this.startHealthPolling()
    } else {
      this.appendLog('app', `pid ${handoff.pid} is alive but not healthy; leaving it alone`)
      await rm(this.handoffPath, { force: true })
    }
  }
}

/**
 * Translate the UI's config into argv for whichever llama.cpp shape is
 * installed: the unified CLI needs a `serve` subcommand, and its `--flash-attn`
 * takes an explicit on/off rather than being a bare boolean.
 */
export function buildArgs(
  config: LaunchConfig,
  port: number,
  binary: BinaryInfo,
  api: { host?: string; apiKey?: string | null } = {}
): string[] {
  const canFit = binary.flags.includes('--fit')
  const autoFit = config.autoFit && canFit

  const args: string[] = [
    ...binary.argvPrefix,
    '--model', config.modelPath,
    '--host', api.host ?? '127.0.0.1',
    '--port', String(port),
    '--parallel', String(config.parallel),
    '--cache-type-k', config.cacheTypeK,
    '--cache-type-v', config.cacheTypeV,
    // Telemetry endpoints the GUI depends on. Off by default in llama-server.
    '--slots',
    '--metrics',
    '--props',
    // Use the model's own chat template rather than a guessed one.
    '--jinja'
  ]

  if (autoFit) {
    // -ngl and -c are deliberately omitted: --fit only adjusts arguments that
    // were left unset, so setting them here would silently disable it.
    args.push('--fit', 'on')
  } else {
    args.push('--ctx-size', String(config.contextSize))
    args.push('--gpu-layers', String(config.gpuLayers))
  }
  // Under --fit too: it sizes what is left unset around the experts' placement.
  if (config.cpuMoeLayers === -1) args.push('--cpu-moe')
  else if (config.cpuMoeLayers > 0) args.push('--n-cpu-moe', String(config.cpuMoeLayers))
  if (config.mmprojPath) args.push('--mmproj', config.mmprojPath)
  if (binary.flashAttnStyle === 'value') {
    args.push('--flash-attn', config.flashAttn ? 'on' : 'off')
  } else if (config.flashAttn) {
    args.push('--flash-attn')
  }
  if (api.apiKey) args.push('--api-key', api.apiKey)
  if (config.noWarmup) args.push('--no-warmup')
  if (config.threads > 0) args.push('--threads', String(config.threads))
  if (config.alias) args.push('--alias', config.alias)
  // Deliberately not passing --no-webui: the stock UI stays reachable as an
  // escape hatch when something in this GUI misbehaves.
  const extra = config.extraArgs.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}

/** The argv with the value after --api-key masked, for anything a person might see or share. */
export function redactKey(args: string[]): string[] {
  return args.map((a, i) => (i > 0 && args[i - 1] === '--api-key' ? '••••' : a))
}

/** Whether a port can be bound on `host` right now: a fixed port someone else holds is refused before spawning. */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

/** Bind :0, note what the OS handed us, release it. Avoids hardcoding 8080. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not determine a free port')))
      }
    })
  })
}

export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    })
    return res.ok
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The child is spawned detached, so it leads its own process group and we can
 * signal the whole group. Falls back to the bare pid if the group is gone.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}
