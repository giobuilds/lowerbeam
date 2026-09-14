import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc.js'
import type { ApplyResult, ChangeSet, CodingRunSummary, CodingStartRequest, JournalEvent } from '@shared/coding.js'
import type { CapabilityStatus } from '@shared/capability.js'
import type { Evidence } from '@shared/evidence.js'
import type {
  BinaryInfo,
  ConversationSummaryView,
  ConversationView,
  FitSuggestion,
  GpuDevice,
  BenchRequest,
  BenchRunView,
  ContextMenuCommand,
  ContextMenuRequest,
  MachineProfileView,
  DownloadJob,
  HealthCheckResult,
  HfFile,
  HfModel,
  RemoteFit,
  LaunchProfileView,
  IpcResponse,
  LaunchConfig,
  LogLine,
  ModelEntryView,
  McpServerConfig,
  McpServerState,
  AboutView,
  McpSnapshot,
  ReaderState,
  ToolDefinition,
  ToolResult,
  ServerStatus,
  VramPlanView
} from '@shared/types.js'

/**
 * The entire privileged surface available to the renderer. Anything not listed
 * here is unreachable from the UI — no fs, no child_process, no ipcRenderer.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

/** Returns an unsubscribe function so React effects can clean up properly. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  server: {
    status: () => invoke<ServerStatus>(IPC.serverStatus),
    start: (config: LaunchConfig) => invoke<ServerStatus>(IPC.serverStart, config),
    stop: () => invoke<ServerStatus>(IPC.serverStop),
    onStatus: (cb: (status: ServerStatus) => void) => subscribe(IPC.serverStatusChanged, cb)
  },
  logs: {
    since: (afterSeq: number) => invoke<LogLine[]>(IPC.logsSince, afterSeq),
    onChanged: (cb: () => void) => subscribe<void>(IPC.logsChanged, cb)
  },
  binary: {
    info: () => invoke<BinaryInfo>(IPC.binaryInfo),
    /** Every llama.cpp install found, so the user can pick between them. */
    list: () => invoke<BinaryInfo[]>(IPC.binaryList),
    select: (path: string) => invoke<BinaryInfo>(IPC.binarySelect, path),
    /** Load a model and generate a token — the only check that catches a broken backend. */
    healthCheck: (modelPath: string, gpuLayers: number) =>
      invoke<HealthCheckResult>(IPC.binaryHealthCheck, { modelPath, gpuLayers }),
    devices: () => invoke<GpuDevice[]>(IPC.binaryDevices)
  },
  models: {
    list: () => invoke<ModelEntryView[]>(IPC.modelsList),
    rescan: () => invoke<ModelEntryView[]>(IPC.modelsRescan),
    fit: (modelPath: string) => invoke<FitSuggestion | null>(IPC.modelFit, modelPath),
    plan: (req: {
      modelPath: string
      gpuLayers: number
      contextSize: number
      cacheTypeK: string
      cacheTypeV: string
      parallel: number
    }) => invoke<VramPlanView>(IPC.modelPlan, req)
  },
  downloads: {
    search: (query: string) => invoke<HfModel[]>(IPC.hfSearch, query),
    files: (repo: string) => invoke<HfFile[]>(IPC.hfFiles, repo),
    /** Whether each quant in a repo will fit this machine's VRAM. */
    fit: (repo: string) => invoke<RemoteFit[]>(IPC.hfFit, repo),
    start: (repo: string, file: string, expectedBytes: number) =>
      invoke<DownloadJob>(IPC.downloadStart, { repo, file, expectedBytes }),
    cancel: (id: string) => invoke<null>(IPC.downloadCancel, id),
    /** Remove one finished entry from the list; the transfer is untouched. */
    forget: (id: string) => invoke<null>(IPC.downloadForget, id),
    clearFinished: () => invoke<null>(IPC.downloadClearFinished),
    list: () => invoke<DownloadJob[]>(IPC.downloadList),
    onChanged: (cb: (job: DownloadJob) => void) => subscribe(IPC.downloadChanged, cb)
  },
  contextMenu: {
    /** Right-click details from the main process, which owns the spell-checker. */
    onShow: (cb: (request: ContextMenuRequest) => void) =>
      subscribe<ContextMenuRequest>(IPC.contextMenuShow, cb),
    send: (command: ContextMenuCommand) => ipcRenderer.send(IPC.contextMenuCommand, command)
  },
  menu: {
    /** Menu items ask the renderer to do what the UI already does. */
    onAction: (cb: (action: string) => void) => subscribe<string>(IPC.menuAction, cb)
  },
  machine: {
    /** What has been measured about this machine, and what is still assumed. */
    profile: () => invoke<MachineProfileView>(IPC.machineProfile)
  },
  bench: {
    start: (request: BenchRequest) => invoke<BenchRunView>(IPC.benchStart, request),
    cancel: () => invoke<null>(IPC.benchCancel),
    state: () => invoke<BenchRunView | null>(IPC.benchState),
    onChanged: (cb: (run: BenchRunView) => void) => subscribe(IPC.benchChanged, cb)
  },
  profiles: {
    /** The known-good settings remembered for a model, if any. */
    get: (modelPath: string) => invoke<LaunchProfileView | null>(IPC.profileGet, modelPath),
    list: () => invoke<LaunchProfileView[]>(IPC.profileList),
    forget: (modelPath: string) => invoke<null>(IPC.profileForget, modelPath)
  },
  app: {
    /** Name, version and the runtimes underneath, for the About panel. */
    about: () => invoke<AboutView>(IPC.appAbout)
  },
  coding: {
    pickProject: () => invoke<string | null>(IPC.codingPickProject),
    pickReadRoot: () => invoke<string | null>(IPC.codingPickReadRoot),
    start: (req: CodingStartRequest) => invoke<CodingRunSummary>(IPC.codingStart, req),
    cancel: (runId: string) => invoke<null>(IPC.codingCancel, runId),
    list: () => invoke<{ runs: CodingRunSummary[]; lastProject: string | null }>(IPC.codingList),
    /** The journal so far, for reconnecting after a reload. */
    get: (runId: string) => invoke<JournalEvent[]>(IPC.codingGet, runId),
    /** An edit run's changes against its baseline; null for an inspect run. */
    changes: (runId: string) => invoke<ChangeSet | null>(IPC.codingChanges, runId),
    apply: (runId: string) => invoke<ApplyResult>(IPC.codingApply, runId),
    undo: (runId: string) => invoke<ApplyResult>(IPC.codingUndo, runId),
    discard: (runId: string) => invoke<null>(IPC.codingDiscard, runId),
    /** Whether commands can be run on this machine, with the reason when not. */
    sandbox: () => invoke<{ ok: boolean; reason: string | null }>(IPC.codingSandbox),
    capability: () => invoke<CapabilityStatus>(IPC.codingCapability),
    capabilityOf: (modelPath: string) => invoke<CapabilityStatus>(IPC.codingCapabilityOf, modelPath),
    evidence: (runId: string) => invoke<Evidence | null>(IPC.codingEvidence, runId),
    checkBaseline: (runId: string) => invoke<Evidence | null>(IPC.codingCheckBaseline, runId),
    onEvent: (cb: (event: JournalEvent) => void) => subscribe<JournalEvent>(IPC.codingEvent, cb),
    onRunsChanged: (cb: (runs: CodingRunSummary[]) => void) =>
      subscribe<CodingRunSummary[]>(IPC.codingRunsChanged, cb)
  },
  reader: {
    /** Open a page in the sandboxed pane. Never navigates this window. */
    open: (url: string) => invoke<ReaderState | null>(IPC.readerOpen, url),
    close: () => invoke<ReaderState | null>(IPC.readerClose),
    back: () => invoke<null>(IPC.readerBack),
    /** Where the pane should draw, or null while something covers it. */
    setBounds: (bounds: { x: number; y: number; width: number; height: number } | null) =>
      invoke<null>(IPC.readerBounds, bounds),
    openExternal: (url: string) => invoke<null>(IPC.readerExternal, url),
    onChanged: (cb: (state: ReaderState) => void) => subscribe<ReaderState>(IPC.readerChanged, cb)
  },
  mcp: {
    list: () => invoke<McpSnapshot>(IPC.mcpList),
    save: (servers: McpServerConfig[]) => invoke<McpSnapshot>(IPC.mcpSave, servers),
    onChanged: (cb: (snap: McpSnapshot) => void) => subscribe<McpSnapshot>(IPC.mcpChanged, cb)
  },
  search: {
    /** A SearXNG instance to use instead of the default engine. */
    getBackend: () => invoke<string>(IPC.searchBackendGet),
    setBackend: (url: string) => invoke<string>(IPC.searchBackendSet, url)
  },
  tools: {
    list: () => invoke<ToolDefinition[]>(IPC.toolsList),
    run: (name: string, args: Record<string, unknown>) =>
      invoke<ToolResult>(IPC.toolsRun, { name, args })
  },
  chat: {
    list: () => invoke<ConversationSummaryView[]>(IPC.chatList),
    get: (id: string) => invoke<ConversationView | null>(IPC.chatGet, id),
    create: (systemPrompt?: string, tools?: string[]) =>
      invoke<ConversationView>(IPC.chatCreate, systemPrompt ?? '', tools ?? []),
    save: (conversation: ConversationView) => invoke<ConversationView>(IPC.chatSave, conversation),
    remove: (id: string) => invoke<null>(IPC.chatDelete, id)
  },
  dialog: {
    pickModelFile: () => invoke<string | null>(IPC.pickModelFile),
    pickModelDir: () => invoke<string | null>(IPC.pickModelDir)
  }
}

export type LlamaGuiApi = typeof api

contextBridge.exposeInMainWorld('llama', api)
