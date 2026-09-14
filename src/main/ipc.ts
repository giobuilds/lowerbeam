import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { ZodError } from 'zod'
import type {
  BenchResult,
  BenchRunView,
  MachineProfileView,
  BinaryInfo,
  ConversationSummaryView,
  ConversationView,
  DownloadJob,
  FitSuggestion,
  HfFile,
  HfModel,
  RemoteFit,
  GpuDevice,
  HealthCheckResult,
  LaunchProfileView,
  IpcResponse,
  LogLine,
  ModelEntryView,
  McpServerState,
  AboutView,
  McpSnapshot,
  ReaderState,
  ToolDefinition,
  ToolResult,
  ServerStatus,
  VramPlanView
} from '@shared/types.js'
import { IPC } from '@shared/ipc.js'
import { launchConfigSchema } from '@shared/schema.js'
import type { ServerSupervisor } from './supervisor.js'
import { probeBinary, readDevices } from './probe.js'
import { scanModels, defaultModelDirs, type ModelEntry } from './registry.js'
import { planVram } from './planner.js'
import { fitParams } from './fit.js'
import { runHealthCheck } from './health.js'
import { conversationSchema, type ConversationStore } from './conversations.js'
import { openExternally, readerFor } from './reader.js'
import type { CodingSupervisor } from './coding/supervisor.js'
import type { SandboxProbe } from './coding/sandbox.js'
import type { CapabilityStatus } from '@shared/capability.js'
import type { Evidence } from '@shared/evidence.js'
import type { ApplyResult, ChangeSet, CodingRunSummary, JournalEvent } from '@shared/coding.js'
import type { ProfileStore } from './profiles.js'
import {
  searchModels,
  listRepoFiles,
  projectorFor,
  isProjectorName,
  type DownloadManager
} from './downloads.js'
import { estimateRepoFit } from './remoteFit.js'
import { activeParameters, type MachineProfile } from './speed.js'
import { derive } from './calibration.js'
import { totalmem } from 'node:os'
import { BenchRunner } from './bench.js'
import { BUILT_IN_TOOLS, runTool, setSearxngUrl } from './tools.js'
import type { McpRegistry } from './mcpRegistry.js'
import { benchRequestSchema } from '@shared/schema.js'
import { downloadRequestSchema } from '@shared/schema.js'
import {
  planRequestSchema,
  healthCheckRequestSchema,
  toolRunSchema,
  mcpServersSchema,
  readerBoundsSchema,
  codingStartSchema
} from '@shared/schema.js'
import type { SettingsStore } from './settings.js'

/** Wrap a handler so a thrown error becomes a typed failure instead of an opaque IPC rejection. */
function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResponse<T>> => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })
}

/** Same, for handlers that act on the window that asked rather than on the app. */
function handleFrom<T>(channel: string, fn: (sender: WebContents, ...args: unknown[]) => T): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<T>> => {
    try {
      return { ok: true, value: await fn(event.sender, ...args) }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })
}

/**
 * A raw ZodError serialises to an unreadable JSON blob. The UI shows this string
 * verbatim, so it is flattened into "field: reason" here.
 */
function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
      .join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(
  supervisor: ServerSupervisor,
  settings: SettingsStore,
  conversations: ConversationStore,
  profiles: ProfileStore,
  mcp: McpRegistry,
  downloads: DownloadManager,
  coding: CodingSupervisor,
  /** Every llama.cpp install found at startup, best first. */
  discovered: BinaryInfo[]
): void {
  handle<ServerStatus>(IPC.serverStatus, () => supervisor.status)

  handle<ServerStatus>(IPC.serverStart, async (raw) => {
    // Renderer input reaches a process spawn, so it is validated, not trusted.
    const config = launchConfigSchema.parse(raw)
    await supervisor.start(config)
    return supervisor.status
  })

  handle<ServerStatus>(IPC.serverStop, async () => {
    await supervisor.stop()
    return supervisor.status
  })

  handle<LogLine[]>(IPC.logsSince, (afterSeq) => {
    const seq = typeof afterSeq === 'number' && Number.isFinite(afterSeq) ? afterSeq : 0
    return supervisor.logs.since(seq)
  })

  handle<BinaryInfo>(IPC.binaryInfo, () => supervisor.binaryInfo)

  /**
   * Both shapes of llama.cpp are reported, not just the chosen one: a machine
   * can have a current `llama serve` alongside a stale distro `llama-server`,
   * and the user is the one who should decide which to drive.
   */
  handle<BinaryInfo[]>(IPC.binaryList, () => discovered)

  handle<BinaryInfo>(IPC.binarySelect, async (rawPath) => {
    const path = String(rawPath ?? '')
    // Re-probe rather than trusting the cached entry: the binary may have been
    // replaced (an update) since startup.
    const known = discovered.find((b) => b.path === path)
    const info = await probeBinary({ path, kind: known?.kind ?? 'unified' })
    supervisor.setBinary(info)
    await settings.patch({ binaryPath: path })
    const idx = discovered.findIndex((b) => b.path === path)
    if (idx >= 0) discovered[idx] = info
    else discovered.push(info)
    return info
  })

  handle<GpuDevice[]>(IPC.binaryDevices, () => readDevices(supervisor.binaryInfo))

  // The scan touches only file headers, but it walks whole directory trees, so
  // the result is cached and refreshed on demand rather than on every render.
  let modelCache: ModelEntry[] | null = null
  const listModels = async (force: boolean): Promise<ModelEntry[]> => {
    if (!modelCache || force) {
      modelCache = await scanModels([...defaultModelDirs(), ...settings.current.modelDirs])
    }
    return modelCache
  }

  handle<ModelEntryView[]>(IPC.modelsList, () => listModels(false))
  handle<ModelEntryView[]>(IPC.modelsRescan, () => listModels(true))

  handle<VramPlanView>(IPC.modelPlan, async (raw) => {
    const req = planRequestSchema.parse(raw)
    const models = await listModels(false)
    const meta = models.find((m) => m.path === req.modelPath)
    if (!meta) throw new Error('Model not found. Try rescanning.')
    if (meta.error) throw new Error(`Cannot plan for this file: ${meta.error}`)

    // Free VRAM is re-read here rather than reused from the startup probe:
    // other processes take and release VRAM while the app is open.
    let freeMiB: number | null = null
    try {
      const devices = await readDevices(supervisor.binaryInfo)
      freeMiB = devices[0]?.freeMiB ?? null
    } catch {
      freeMiB = null
    }
    const binary = supervisor.binaryInfo
    return planVram(
      {
        meta,
        gpuLayers: req.gpuLayers,
        contextSize: req.contextSize,
        cacheTypeK: req.cacheTypeK,
        cacheTypeV: req.cacheTypeV,
        parallel: req.parallel,
        // The unified CLI is the newer line, which sizes its compute buffer very
        // differently from the classic standalone server.
        computeProfile: binary.kind === 'unified' ? 'modern' : 'classic',
        hasGpuBackend: binary.devices.length > 0
      },
      freeMiB
    )
  })

  /**
   * llama.cpp's own fitting tool. Cached per model+binary: it loads the model
   * to measure, so it is far too slow to call on every slider movement.
   */
  const fitCache = new Map<string, FitSuggestion | null>()
  handle<FitSuggestion | null>(IPC.modelFit, async (rawPath) => {
    const modelPath = String(rawPath ?? '')
    if (!modelPath) return null
    const binary = supervisor.binaryInfo
    const key = `${binary.path}::${modelPath}`
    if (!fitCache.has(key)) fitCache.set(key, await fitParams(binary, modelPath))
    return fitCache.get(key) ?? null
  })

  handle<HealthCheckResult>(IPC.binaryHealthCheck, async (raw) => {
    const req = healthCheckRequestSchema.parse(raw)
    if (supervisor.status.pid !== null) {
      throw new Error('Stop the running server before testing the binary.')
    }
    const result = await runHealthCheck(supervisor.binaryInfo, req.modelPath, req.gpuLayers)
    // The check already generated tokens against a model of known size, which
    // is exactly a bandwidth measurement — no separate calibration step needed.
    if (result.ok && result.tokensPerSecond) {
      const model = (await listModels(false)).find((m) => m.path === req.modelPath)
      const params = model ? activeParameters(model) : null
      if (model && params) {
        await settings.observe({
          activeBytes: model.fileSize * (params.active / params.total),
          secondsPerToken: 1 / result.tokensPerSecond,
          onGpu: req.gpuLayers > 0 && supervisor.binaryInfo.devices.length > 0
        })
        repoFitCache.clear()
      }
    }
    return result
  })

  handle<string | null>(IPC.pickModelDir, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Add a folder to scan for GGUF models',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    if (!settings.current.modelDirs.includes(dir)) {
      await settings.patch({ modelDirs: [...settings.current.modelDirs, dir] })
    }
    modelCache = null
    return dir
  })

  handle<HfModel[]>(IPC.hfSearch, (query) => searchModels(String(query ?? ''), 24))
  handle<HfFile[]>(IPC.hfFiles, (repo) => listRepoFiles(String(repo ?? '')))
  /**
   * Fit estimates cost a ranged HTTP fetch of each distinct model's header, so
   * they are cached per repo. The answer only changes if the binary does, which
   * the key accounts for.
   */
  /**
   * The machine's measured throughput, learned from health checks and
   * benchmarks. Without a GPU sample no speed is predicted, rather than one
   * being invented from a specification sheet.
   */
  const machineProfile = (): MachineProfile | undefined => {
    const derived = derive(settings.current.calibration)
    if (!derived.gpuBytesPerSecond && !derived.cpuBytesPerSecond) return undefined
    const devices = supervisor.binaryInfo.devices
    const freeVram = devices[0]?.freeMiB ?? 0
    return {
      gpuBytesPerSecond: derived.gpuBytesPerSecond,
      // Until a CPU-only run has been measured this is a stand-in, and it is the
      // figure that decides whether a large mixture of experts is usable, so the
      // UI says plainly when it has not been measured.
      cpuBytesPerSecond: derived.cpuBytesPerSecond ?? 20e9,
      vramBytes: freeVram * 1024 * 1024,
      ramBytes: totalmem() * 0.65,
      overheadCeilingTokensPerSecond: derived.ceilingTokensPerSecond ?? 600
    }
  }

  const repoFitCache = new Map<string, RemoteFit[]>()
  handle<RemoteFit[]>(IPC.hfFit, async (rawRepo) => {
    const repo = String(rawRepo ?? '')
    const binary = supervisor.binaryInfo
    const key = `${binary.path}::${repo}`
    const cached = repoFitCache.get(key)
    if (cached) return cached

    const files = await listRepoFiles(repo)
    // Free VRAM is read now rather than reused from startup: what fits depends
    // on what else is currently using the card.
    let freeMiB: number | null = null
    try {
      freeMiB = (await readDevices(binary))[0]?.freeMiB ?? null
    } catch {
      freeMiB = null
    }
    const fits = await estimateRepoFit(repo, files, freeMiB, binary, machineProfile())
    repoFitCache.set(key, fits)
    return fits
  })

  handle<DownloadJob[]>(IPC.downloadList, () => downloads.listWithDiskState())
  handle<null>(IPC.downloadForget, (id) => {
    downloads.forget(String(id ?? ''))
    return null
  })
  handle<null>(IPC.downloadClearFinished, () => {
    downloads.clearFinished()
    return null
  })
  handle<DownloadJob>(IPC.downloadStart, async (raw) => {
    const req = downloadRequestSchema.parse(raw)
    const job = await downloads.start(req.repo, req.file, req.expectedBytes)

    // A vision model without its projector loads as text-only and never says
    // so. `llama download` does not fetch it for a specific --hf-file, so the
    // pair is queued here rather than leaving the user a half-usable model.
    try {
      const files = await listRepoFiles(req.repo)
      const projector = projectorFor(req.file, files)
      if (projector && !isProjectorName(req.file)) {
        await downloads.start(req.repo, projector.path, projector.size)
      }
    } catch {
      // The model itself is already downloading; failing to pair a projector
      // should not undo that.
    }
    return job
  })
  handle<null>(IPC.downloadCancel, (id) => {
    downloads.cancel(String(id ?? ''))
    return null
  })

  /**
   * One benchmark at a time: two sweeps competing for the same GPU would
   * measure each other's contention rather than the settings under test.
   */
  const bench = new BenchRunner()
  let benchRun: BenchRunView | null = null
  const pushBench = (): void => {
    if (benchRun) broadcastBench({ ...benchRun })
  }
  bench.on('progress', (progress) => {
    if (!benchRun) return
    benchRun = { ...benchRun, progress }
    pushBench()
  })
  bench.on('done', (results) => {
    if (!benchRun) return
    const request = benchRun.request
    benchRun = { ...benchRun, results, state: 'done', progress: null, finishedAt: Date.now() }
    pushBench()
    // A benchmark is the most accurate measurement this app can take, and a
    // sweep that includes -ngl 0 measures the CPU side too. Throwing that away
    // and asking the user to calibrate separately would be perverse.
    void absorbBenchResults(request.modelPath, results).catch(() => {})
  })

  /**
   * Turn generation rows into calibration samples. Prompt-processing rows are
   * ignored: they are compute-bound rather than bandwidth-bound, so they say
   * nothing about how fast weights can be read.
   */
  const absorbBenchResults = async (
    modelPath: string,
    results: BenchResult[]
  ): Promise<void> => {
    const model = (await listModels(false)).find((m) => m.path === modelPath)
    const params = model ? activeParameters(model) : null
    if (!model || !params) return
    const activeBytes = model.fileSize * (params.active / params.total)
    const hasGpu = supervisor.binaryInfo.devices.length > 0

    for (const row of results) {
      if (row.kind !== 'generation' || row.tokensPerSecond <= 0) continue
      await settings.observe({
        activeBytes,
        secondsPerToken: 1 / row.tokensPerSecond,
        // llama-bench reports -1 for "every layer", 0 for none.
        onGpu: hasGpu && row.gpuLayers !== 0
      })
    }
    repoFitCache.clear()
  }
  bench.on('failed', (error) => {
    if (!benchRun) return
    benchRun = { ...benchRun, state: 'failed', error, progress: null, finishedAt: Date.now() }
    pushBench()
  })

  handle<MachineProfileView>(IPC.machineProfile, () => {
    const derived = derive(settings.current.calibration)
    return {
      gpuBytesPerSecond: derived.gpuBytesPerSecond,
      cpuBytesPerSecond: derived.cpuBytesPerSecond,
      ceilingTokensPerSecond: derived.ceilingTokensPerSecond,
      gpuSamples: derived.gpuSamples,
      cpuSamples: derived.cpuSamples,
      vramBytes: (supervisor.binaryInfo.devices[0]?.freeMiB ?? 0) * 1024 * 1024,
      ramBytes: totalmem(),
      cpuAssumed: derived.cpuBytesPerSecond === null
    }
  })

  handle<BenchRunView>(IPC.benchStart, (raw) => {
    const request = benchRequestSchema.parse(raw)
    if (supervisor.status.pid !== null) {
      // A loaded server holds VRAM and competes for the GPU, which would make
      // every number in the sweep wrong.
      throw new Error('Stop the running server before benchmarking — it would skew the results.')
    }
    benchRun = {
      id: `${Date.now()}`,
      request,
      results: [],
      progress: null,
      state: 'running',
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    bench.start(supervisor.binaryInfo, request)
    return benchRun
  })

  handle<null>(IPC.benchCancel, () => {
    bench.cancel()
    return null
  })

  handle<BenchRunView | null>(IPC.benchState, () => benchRun)

  handle<LaunchProfileView | null>(IPC.profileGet, (modelPath) =>
    profiles.get(String(modelPath ?? ''))
  )
  handle<LaunchProfileView[]>(IPC.profileList, () => profiles.list())
  handle<null>(IPC.profileForget, async (modelPath) => {
    await profiles.forget(String(modelPath ?? ''))
    return null
  })

  // Built-in and MCP tools are one list: the model cannot tell them apart, and
  // the only thing that differs for the user is where a tool came from.
  handle<ToolDefinition[]>(IPC.toolsList, () => [...BUILT_IN_TOOLS, ...mcp.tools()])

  // Coding runs. The supervisor owns the grant, the journal and cancellation;
  // these only translate requests, and the start request is validated like
  // every other payload that crosses from the renderer.
  handle<string | null>(IPC.codingPickProject, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose the project the model may read',
      properties: ['openDirectory']
    })
    const dir = r.canceled ? null : (r.filePaths[0] ?? null)
    if (dir) await settings.patch({ lastProject: dir })
    return dir
  })
  handle<CodingRunSummary>(IPC.codingStart, async (raw) => {
    const req = codingStartSchema.parse(raw)
    const run = await coding.start(req)
    await settings.patch({ lastProject: req.projectRoot })
    return run
  })
  handle<null>(IPC.codingCancel, (id) => {
    coding.cancel(String(id ?? ''))
    return null
  })
  handle<{ runs: CodingRunSummary[]; lastProject: string | null }>(IPC.codingList, () => ({
    runs: coding.list(),
    lastProject: settings.current.lastProject ?? null
  }))
  handle<JournalEvent[]>(IPC.codingGet, (id) => coding.events(String(id ?? '')))
  handle<ChangeSet | null>(IPC.codingChanges, (id) => coding.changes(String(id ?? '')))
  handle<SandboxProbe>(IPC.codingSandbox, () => coding.sandbox())
  handle<CapabilityStatus>(IPC.codingCapability, () => coding.capability())
  handle<Evidence | null>(IPC.codingEvidence, (id) => coding.evidence(String(id ?? '')))
  handle<Evidence | null>(IPC.codingCheckBaseline, (id) => coding.checkBaseline(String(id ?? '')))
  handle<ApplyResult>(IPC.codingApply, (id) => coding.apply(String(id ?? '')))
  handle<ApplyResult>(IPC.codingUndo, (id) => coding.undo(String(id ?? '')))
  handle<null>(IPC.codingDiscard, async (id) => {
    await coding.discard(String(id ?? ''))
    return null
  })

  handle<AboutView>(IPC.appAbout, () => {
    // Run unpackaged, Electron reports itself rather than the app, so the
    // manifest is the honest source in both cases — it ships inside the asar.
    const manifest = createRequire(import.meta.url)('../../package.json') as {
      productName?: string
      name: string
      version: string
    }
    return {
      name: manifest.productName ?? manifest.name,
      version: manifest.version,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  })

  // Pages open in a pane with no preload rather than in the app window, which
  // would hand a remote page the whole bridge below.
  handleFrom<ReaderState | null>(IPC.readerOpen, (sender, url) => {
    const reader = readerFor(sender)
    reader?.open(String(url ?? ''))
    return reader?.state ?? null
  })
  handleFrom<ReaderState | null>(IPC.readerClose, (sender) => {
    const reader = readerFor(sender)
    reader?.close()
    return reader?.state ?? null
  })
  handleFrom<null>(IPC.readerBack, (sender) => {
    readerFor(sender)?.goBack()
    return null
  })
  handleFrom<null>(IPC.readerBounds, (sender, raw) => {
    readerFor(sender)?.setBounds(raw === null ? null : readerBoundsSchema.parse(raw))
    return null
  })
  handle<null>(IPC.readerExternal, (url) => {
    openExternally(String(url ?? ''))
    return null
  })

  handle<McpSnapshot>(IPC.mcpList, () => snapshot())
  handle<McpSnapshot>(IPC.mcpSave, async (raw) => {
    await mcp.apply(mcpServersSchema.parse(raw))
    return snapshot()
  })
  const snapshot = (): McpSnapshot => ({ configs: mcp.configs(), states: mcp.states() })

  handle<string>(IPC.searchBackendGet, () => settings.current.searxngUrl)
  handle<string>(IPC.searchBackendSet, async (raw) => {
    const url = String(raw ?? '').trim()
    if (url && !/^https?:\/\//i.test(url)) throw new Error('Enter a full http or https address.')
    await settings.patch({ searxngUrl: url })
    setSearxngUrl(url)
    return url
  })
  handle<ToolResult>(IPC.toolsRun, async (raw) => {
    const req = toolRunSchema.parse(raw)
    // Tools reach the network and spawn subprocesses, neither of which the
    // renderer can do: its CSP allows loopback only, and a page that renders
    // model output is the wrong place for either.
    if (mcp.owns(req.name)) return mcp.call(req.name, req.args)
    return runTool(req.name, req.args)
  })

  handle<ConversationSummaryView[]>(IPC.chatList, () => conversations.list())
  handle<ConversationView | null>(IPC.chatGet, (id) => conversations.get(String(id ?? '')))
  handle<ConversationView>(IPC.chatCreate, (systemPrompt, tools) =>
    conversations.create(
      typeof systemPrompt === 'string' ? systemPrompt : '',
      Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : []
    )
  )
  handle<ConversationView>(IPC.chatSave, (raw) =>
    // Conversation content is model output written back through the renderer,
    // so it is validated before it is persisted.
    conversations.save(conversationSchema.parse(raw))
  )
  handle<null>(IPC.chatDelete, async (id) => {
    await conversations.remove(String(id ?? ''))
    return null
  })

  handle<string | null>(IPC.pickModelFile, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}

/** Set by wireEvents so handlers registered earlier can broadcast. */
let broadcastBench: (run: BenchRunView) => void = () => {}
let broadcastMcp: (snap: McpSnapshot) => void = () => {}

/** Push status and log-availability events to every open window. */
export function wireEvents(
  supervisor: ServerSupervisor,
  downloads: DownloadManager,
  mcp: McpRegistry,
  coding: CodingSupervisor
): void {
  const broadcast = (channel: string, payload?: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  supervisor.on('status', (status) => broadcast(IPC.serverStatusChanged, status))
  downloads.on('update', (job) => broadcast(IPC.downloadChanged, job))
  broadcastMcp = (snap) => broadcast(IPC.mcpChanged, snap)
  // A server that starts, fails or is stopped changes which tools exist.
  mcp.on('state', () => broadcastMcp({ configs: mcp.configs(), states: mcp.states() }))
  broadcastBench = (run) => broadcast(IPC.benchChanged, run)
  coding.on('event', (event) => broadcast(IPC.codingEvent, event))
  coding.on('runs', (runs) => broadcast(IPC.codingRunsChanged, runs))

  // llama-server can emit hundreds of lines per second; coalesce the "there is
  // new output" hint so the renderer polls at most ~10x/sec instead of per line.
  let pending = false
  supervisor.on('log', () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      broadcast(IPC.logsChanged)
    }, 100)
  })
}
