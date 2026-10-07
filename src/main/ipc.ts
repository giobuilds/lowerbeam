import { app, ipcMain, dialog, session, BrowserWindow, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { conversationMarkdown, exportFileName } from '@shared/chatExport.js'
import { ZodError } from 'zod'
import type {
  BenchResult,
  BenchRunView,
  MachineProfileView,
  BinaryInfo,
  ConversationSummaryView,
  ConversationSearchHitView,
  LocalApiSettings,
  PromptPreset,
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
  UpdateState,
  McpSnapshot,
  ReaderState,
  ToolDefinition,
  ToolResult,
  ServerStatus,
  VramPlanView,
  DataUsage,
  ServedModel,
  LaunchConfig,
  RouterPlanView
} from '@shared/types.js'
import { IPC } from '@shared/ipc.js'
import { applyOptionsSchema, launchConfigSchema, routerLaunchSchema } from '@shared/schema.js'
import { dataUsage, deleteOwnData } from './appData.js'
import type { SlotCache } from './slots.js'
import type { ServerSupervisor } from './supervisor.js'
import { probeBinary, readDevices } from './probe.js'
import { scanModels, defaultModelDirs, type ModelEntry } from './registry.js'
import { planVram, routerWorstCase } from './planner.js'
import { routerIds } from '@shared/served.js'
import { fitParams } from './fit.js'
import { runHealthCheck } from './health.js'
import { conversationSchema, type ConversationStore } from './conversations.js'
import { openExternally, readerFor } from './reader.js'
import type { CodingSupervisor } from './coding/supervisor.js'
import type { SandboxProbe } from './coding/sandbox.js'
import type { CapabilityStatus, MeasureProgress } from '@shared/capability.js'
import type { Evidence } from '@shared/evidence.js'
import type { ApplyResult, ChangeSet, CodingRunSummary, GitState, JournalEvent } from '@shared/coding.js'
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
import { isAppSender } from './sender.js'
import type { Updater } from './updater.js'

/** What a request from anywhere but the app's own page gets. Says nothing about the channel. */
const NOT_THE_APP = 'This request did not come from Lowerbeam\u2019s own window.'

/**
 * Wrap a handler so a thrown error becomes a typed failure instead of an
 * opaque IPC rejection — and so it serves only the app's own page, in its own
 * window, as the top frame (see sender.ts).
 */
function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<T>> => {
    if (!isAppSender(event)) return { ok: false, error: NOT_THE_APP }
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
    if (!isAppSender(event)) return { ok: false, error: NOT_THE_APP }
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
  discovered: BinaryInfo[],
  updater: Updater,
  slots: SlotCache
): void {
  handle<ServerStatus>(IPC.serverStatus, () => supervisor.status)

  handle<ServerStatus>(IPC.serverStart, async (raw) => {
    // Renderer input reaches a process spawn, so it is validated, not trusted.
    const config = launchConfigSchema.parse(raw)
    await supervisor.start(config, settings.current.localApi)
    return supervisor.status
  })

  // A router's model loaded before a request is sent, so its window and
  // tools are known first; with one model, the running one.
  handle<ServedModel>(IPC.serverEnsureModel, (id) => supervisor.ensureLoaded(typeof id === 'string' ? id : null))

  handle<ServerStatus>(IPC.serverStartRouter, async (raw) => {
    const launch = routerLaunchSchema.parse(raw)
    await supervisor.startRouter(launch, settings.current.localApi)
    return supervisor.status
  })

  handle<LocalApiSettings>(IPC.localApiGet, () => settings.current.localApi)
  handle<LocalApiSettings>(IPC.localApiSet, async (raw) => (await settings.patch({ localApi: raw as LocalApiSettings })).localApi)
  // Where another machine would reach this one: each non-internal IPv4 address.
  handle<string[]>(IPC.lanAddresses, () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((a): a is NonNullable<typeof a> => Boolean(a) && a!.family === 'IPv4' && !a!.internal)
      .map((a) => a.address)
  )

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

    return planOne(meta, req, await freeVram())
  })

  // Free VRAM is re-read on every plan rather than reused from the startup
  // probe: other processes take and release VRAM while the app is open.
  const freeVram = async (): Promise<number | null> => {
    try {
      const devices = await readDevices(supervisor.binaryInfo)
      return devices[0]?.freeMiB ?? null
    } catch {
      return null
    }
  }

  handle<RouterPlanView>(IPC.modelPlanRouter, async (raw) => {
    const launch = routerLaunchSchema.parse(raw)
    const models = await listModels(false)
    const freeMiB = await freeVram()
    const ids = routerIds(launch.models.map((m) => m.modelPath))
    const planned = launch.models.map((config, i) => {
      const meta = models.find((m) => m.path === config.modelPath)
      const error = !meta ? 'not found; try rescanning' : meta.error ? meta.error : null
      if (!meta || error) return { id: ids[i]!, modelPath: config.modelPath, totalMiB: 0, contextPerSlot: 0, error }
      const plan = planOne(meta, config, freeMiB)
      return { id: ids[i]!, modelPath: config.modelPath, totalMiB: plan.totalMiB, contextPerSlot: plan.contextPerSlot, error: null }
    })
    return { models: planned, freeMiB, ...routerWorstCase(planned, launch.modelsMax, freeMiB) }
  })

  const planOne = (
    meta: ModelEntry,
    req: { gpuLayers: number; contextSize: number; cacheTypeK: LaunchConfig['cacheTypeK']; cacheTypeV: LaunchConfig['cacheTypeV']; parallel: number; cpuMoeLayers?: number },
    freeMiB: number | null
  ): VramPlanView => {
    const binary = supervisor.binaryInfo
    return planVram(
      {
        meta,
        gpuLayers: req.gpuLayers,
        contextSize: req.contextSize,
        cacheTypeK: req.cacheTypeK,
        cacheTypeV: req.cacheTypeV,
        parallel: req.parallel,
        cpuMoeLayers: req.cpuMoeLayers,
        // The unified CLI is the newer line, which sizes its compute buffer very
        // differently from the classic standalone server.
        computeProfile: binary.kind === 'unified' ? 'modern' : 'classic',
        hasGpuBackend: binary.devices.length > 0
      },
      freeMiB
    )
  }

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
  handle<string | null>(IPC.codingPickReadRoot, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a folder the run may also read',
      properties: ['openDirectory']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
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
  handle<CapabilityStatus>(IPC.codingCapability, (model) => coding.capability(typeof model === 'string' ? model : null))
  handle<CapabilityStatus>(IPC.codingCapabilityOf, (path) => coding.capabilityOf(String(path ?? '')))
  handle<Evidence | null>(IPC.codingEvidence, (id) => coding.evidence(String(id ?? '')))
  handle<Evidence | null>(IPC.codingCheckBaseline, (id) => coding.checkBaseline(String(id ?? '')))
  handle<MeasureProgress>(IPC.codingMeasure, (model) => coding.measure(typeof model === 'string' ? model : null))
  handle<null>(IPC.codingMeasureCancel, () => {
    coding.cancelMeasure()
    return null
  })
  handle<MeasureProgress | null>(IPC.codingMeasureState, () => coding.measureState())
  handle<ApplyResult>(IPC.codingApply, (id, options) => coding.apply(String(id ?? ''), applyOptionsSchema.parse(options ?? {})))
  handle<GitState | null>(IPC.codingGit, (id) => coding.git(String(id ?? '')))
  handle<ApplyResult>(IPC.codingUndo, (id) => coding.undo(String(id ?? '')))
  handle<null>(IPC.codingDiscard, async (id) => {
    await coding.discard(String(id ?? ''))
    return null
  })

  const updateView = (): UpdateState => ({ ...updater.state, enabled: settings.current.updateChecks })
  handle<UpdateState>(IPC.updateState, () => updateView())
  handle<UpdateState>(IPC.updateCheck, async () => {
    await updater.check()
    return updateView()
  })
  handle<null>(IPC.updateRestart, () => {
    updater.restartToUpdate()
    return null
  })
  // What the app keeps, and getting rid of it (#133).
  const dataPaths = {
    userData: app.getPath('userData'),
    conversations: join(app.getPath('userData'), 'conversations'),
    coding: join(app.getPath('userData'), 'coding')
  }
  const usage = async (): Promise<DataUsage> => ({ ...(await dataUsage(dataPaths, settings.current.retentionDays)), slots: await slots.usage() })
  handle<DataUsage>(IPC.dataUsage, usage)
  handle<DataUsage>(IPC.dataDeleteRuns, async () => {
    await coding.deleteAllRuns()
    return usage()
  })
  handle<DataUsage>(IPC.dataDeleteConversations, async () => {
    await conversations.removeAll()
    await slots.clear()
    return usage()
  })
  handle<DataUsage>(IPC.dataSetRetention, async (raw) => {
    const days = raw === null ? null : Number(raw)
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Keep runs’ copies for 1 to 3650 days, or always.')
    await settings.patch({ retentionDays: days })
    if (days !== null) await coding.pruneOlderThan(days)
    return usage()
  })
  // Everything: the server stopped, runs ended, the app's files removed and
  // Electron's storage cleared, then a fresh start. Models are not touched.
  handle<null>(IPC.dataDeleteAll, async () => {
    coding.shutdown()
    await supervisor.stop()
    await deleteOwnData(dataPaths.userData)
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
    app.relaunch()
    app.exit(0)
    return null
  })

  handle<UpdateState>(IPC.updateSetEnabled, async (on) => {
    await settings.patch({ updateChecks: on === true })
    if (on === true) await updater.check()
    return updateView()
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
  handleFrom<ReaderState | null>(IPC.readerHeld, (sender, open) => {
    const reader = readerFor(sender)
    reader?.decideHeld(open === true)
    return reader?.state ?? null
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
    await slots.drop(String(id ?? '')).catch(() => undefined)
    return null
  })
  // A chat's place in the server (#110): the slot to send to, restored first
  // if need be; saving it on leaving; and what the reply after a restore reused.
  handle<{ slot: number; restored: number | null } | null>(IPC.slotsPrepare, (id) => slots.prepare(String(id ?? '')))
  handle<boolean>(IPC.slotsLeave, (id, tokens) => slots.leave(String(id ?? ''), Number(tokens) || 0))
  handle<null>(IPC.slotsReport, async (id, cacheTokens) => {
    await slots.report(String(id ?? ''), Number(cacheTokens) || 0)
    return null
  })
  handle<ConversationSearchHitView[]>(IPC.chatSearch, (query) => conversations.search(String(query ?? '').slice(0, 200)))
  // The user picks where it goes; nothing is written without that choice.
  handle<string | null>(IPC.chatExport, async (id, format) => {
    const conversation = await conversations.get(String(id ?? ''))
    if (!conversation) throw new Error('That conversation no longer exists.')
    const ext = format === 'json' ? 'json' : 'md'
    const r = await dialog.showSaveDialog({
      title: 'Export conversation',
      defaultPath: join(app.getPath('documents'), exportFileName(conversation.title, ext)),
      filters: ext === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, ext === 'json' ? JSON.stringify(conversation, null, 2) : conversationMarkdown(conversation))
    return r.filePath
  })
  handle<PromptPreset[]>(IPC.presetsList, () => settings.current.promptPresets)
  handle<PromptPreset[]>(IPC.presetsSave, async (raw) => (await settings.patch({ promptPresets: raw as PromptPreset[] })).promptPresets)

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
  coding: CodingSupervisor,
  updater: Updater,
  settings: SettingsStore
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
  coding.on('measure', (progress) => broadcast(IPC.codingMeasureChanged, progress))
  updater.on('state', (state: UpdateState) => broadcast(IPC.updateChanged, { ...state, enabled: settings.current.updateChecks }))

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
