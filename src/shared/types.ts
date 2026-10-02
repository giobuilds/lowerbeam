import type { OutputSetting } from './structuredOutput.js'
/**
 * The contract between the main process and the renderer.
 * Everything crossing IPC is defined here and validated with the zod schemas
 * in ./schema.ts before it is trusted on either side.
 */

/** Lifecycle of the supervised llama-server process. */
export type ServerPhase =
  | 'stopped'
  | 'starting' // spawned, no output parsed yet
  | 'loading' // model is being read into memory / offloaded
  | 'ready' // GET /health returned 200
  | 'degraded' // was ready, health checks now failing
  | 'stopping'
  | 'crashed' // exited without us asking

/** Flags we hand to llama-server. Only the ones the UI actually exposes. */
export interface LaunchConfig {
  /** Absolute path to a .gguf file. */
  modelPath: string
  /**
   * Let llama.cpp size the launch itself.
   *
   * Modern builds default `--fit on`, which adjusts *unset* arguments to fit
   * device memory. Passing an explicit -ngl and -c suppresses that, so auto-fit
   * works by deliberately omitting them and letting llama.cpp decide — it knows
   * its own allocator better than any estimate can.
   */
  autoFit: boolean
  /** -ngl: layers to offload to VRAM. */
  gpuLayers: number
  /** -c: context size in tokens. */
  contextSize: number
  /** -fa: flash attention. */
  flashAttn: boolean
  /** -ctk / -ctv: KV cache quantisation. */
  cacheTypeK: KvCacheType
  cacheTypeV: KvCacheType
  /**
   * --no-warmup: skip the empty warmup run. Normally worth keeping, but the
   * warmup pass segfaults on some ROCm builds (reproduced on gfx1032 / RX 6600
   * with llama-cpp b6153), so it has to be switchable.
   */
  noWarmup: boolean
  /**
   * -np: how many conversations can generate at once. llama.cpp decodes one
   * sequence per slot and queues the rest. Note that `-c` is the *total*
   * context and is divided across slots, so more slots means less context each.
   */
  parallel: number
  /** -t: generation threads. -1 lets llama.cpp decide. */
  threads: number
  /**
   * Mixture-of-experts weights kept in system RAM while the rest is offloaded:
   * 0 none, -1 every layer's (--cpu-moe), N the first N layers' (--n-cpu-moe N).
   * On an 8 GB card this is what makes a 30B-A3B usable: attention stays on
   * the GPU and only the few active experts are read from RAM each token.
   */
  cpuMoeLayers: number
  /**
   * --mmproj: multimodal projector. Without it a vision model loads as
   * text-only, silently — it starts and answers, it just cannot see.
   */
  mmprojPath: string | null
  /** --alias: the model name reported over the API. */
  alias?: string
  /** Extra raw flags, split on whitespace. Escape hatch for anything unmodelled. */
  extraArgs: string
}

export const KV_CACHE_TYPES = [
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q5_1',
  'q5_0',
  'iq4_nl',
  'q4_1',
  'q4_0'
] as const
export type KvCacheType = (typeof KV_CACHE_TYPES)[number]

export const DEFAULT_LAUNCH_CONFIG: Omit<LaunchConfig, 'modelPath'> = {
  autoFit: true,
  gpuLayers: 999,
  contextSize: 4096,
  flashAttn: true,
  noWarmup: false,
  cacheTypeK: 'f16',
  mmprojPath: null,
  cacheTypeV: 'f16',
  // Matches llama.cpp's own default. Forcing 1 here would silently prevent
  // concurrent conversations, which is the point of having slots at all.
  parallel: 4,
  threads: -1,
  cpuMoeLayers: 0,
  extraArgs: ''
}

/** Everything the UI needs to render the server panel. */
export interface ServerStatus {
  phase: ServerPhase
  /** Present from 'starting' onwards. */
  pid: number | null
  port: number | null
  /** The config the running process was launched with, not the one being edited. */
  config: LaunchConfig | null
  /**
   * Human-readable stage while phase === 'loading', else null.
   * llama-server emits no load percentage (only per-slot prompt progress), so
   * this is a discrete stage from its stderr, never a fabricated 0..100 bar.
   */
  loadStage: string | null
  /** ms since epoch the current launch attempt began, for an elapsed-time display. */
  startedAt: number | null
  /** Populated on 'crashed' / failed start. */
  error: string | null
  /** Exit code of the last run, if it has exited. */
  exitCode: number | null
  /** ms since epoch the process reached 'ready'. */
  readyAt: number | null
  /** True when we adopted a server that was already running rather than spawning it. */
  adopted: boolean
  /**
   * Context each conversation gets, read from /props once ready.
   * `--ctx-size` is shared out between slots, so this is the total divided by
   * `--parallel` — and it is what a chat runs out of, not the total.
   */
  contextPerSlot: number | null
  /**
   * What the running model can accept, read from /props once it is ready.
   * Null until then, since it cannot be known before the model loads.
   */
  modalities: { vision: boolean; audio: boolean; video: boolean } | null
  /**
   * Whether the loaded model's chat template can express tool calls. Enabling
   * tools against a template that cannot is silently useless, so it is read
   * from the server rather than assumed.
   */
  supportsTools: boolean
  /** The API key the running server was launched with; null when it has none. Every client sends it. */
  apiKey: string | null
  /** Whether the running server listens on the local network as well as this computer. */
  lan: boolean
}

/**
 * The server as an API for other programs — editors, agents, scripts: a port
 * that stays put, a key, and the local network only when asked for and only
 * with a key. Applies from the next launch.
 */
export interface LocalApiSettings {
  /** A fixed port, or null for a free one each launch. */
  port: number | null
  /** Sent as a Bearer token by every client; empty for none. */
  apiKey: string
  /** Listen on every interface, not only loopback. Refused without a key. */
  lan: boolean
}

export const DEFAULT_LOCAL_API: LocalApiSettings = { port: null, apiKey: '', lan: false }

export type LogStream = 'stdout' | 'stderr' | 'app'

export interface LogLine {
  /** Monotonic, assigned by the ring buffer. Renderer uses it to de-dup and to ask for deltas. */
  seq: number
  ts: number
  stream: LogStream
  text: string
}

/**
 * llama.cpp ships in two shapes, and they are not interchangeable:
 *  - 'llama-server': the long-standing standalone binary (what distro packages ship)
 *  - 'unified': the newer single `llama` CLI where `llama serve` replaces it
 * Searching only for a file named `llama-server` silently misses the second and
 * can land on a stale distro build the user does not actually use.
 */
export type BinaryKind = 'llama-server' | 'unified'

/** One documented option, exactly as the installed binary describes it. */
export interface FlagDocView {
  names: string
  argument: string
  description: string
  section: string
  env: string | null
}

/** Result of probing an installed llama.cpp. */
export interface BinaryInfo {
  /** Resolved absolute path to the executable. */
  path: string
  kind: BinaryKind
  /** Subcommand to prepend to argv — [] for llama-server, ['serve'] for the unified CLI. */
  argvPrefix: string[]
  /** Raw --version line, e.g. "0.3.0-dev (build 10679, commit 50f068fff)". */
  version: string
  /** Long flag names the binary advertises in --help, e.g. "--flash-attn". */
  flags: string[]
  /** Every option with its own description, for the in-app reference. */
  flagDocs: FlagDocView[]
  /**
   * Newer builds take `--flash-attn on|off|auto`; older ones treat it as a bare
   * boolean. Passing the wrong form makes the server exit before it starts.
   */
  flashAttnStyle: 'bare' | 'value'
  /** Devices from --list-devices. Empty on a CPU-only build. */
  devices: GpuDevice[]
  /** Human-readable label for the picker, e.g. "llama serve — 0.3.0-dev". */
  label: string
}

export interface GpuDevice {
  /** e.g. "ROCm0" */
  id: string
  name: string
  totalMiB: number
  freeMiB: number
}

/** Mirrors main/planner.ts VramPlan; duplicated here so the renderer can type it. */
export interface VramPlanView {
  offloadedLayers: number
  totalLayers: number
  weightsMiB: number
  kvCacheMiB: number
  computeMiB: number
  backendOverheadMiB: number
  totalMiB: number
  freeMiB: number | null
  fits: boolean | null
  maxGpuLayers: number | null
  contextPerSlot: number
  slots: number
  /** Blocks with experts on a mixture-of-experts model; null on a dense one. */
  moeBlocks: number | null
  /** Expert weights held in system RAM by --cpu-moe / --n-cpu-moe. */
  expertsOnCpuMiB: number
  notes: string[]
}

/** Mirrors main/registry.ts ModelEntry. */
export interface ModelEntryView {
  path: string
  fileName: string
  fileSize: number
  architecture: string
  name: string
  blockCount: number | null
  contextLength: number | null
  embeddingLength: number | null
  headCount: number | null
  headCountKv: number | null
  quant: string | null
  parameterCount: number | null
  hasChatTemplate: boolean
  vocabSize: number | null
  mtimeMs: number
  error?: string
  isProjector: boolean
  /** Projector sitting beside this model, if any — needed for vision. */
  projectorPath?: string
}

/** What `llama fit-params` recommends for a model on this machine. */
export interface FitSuggestion {
  contextSize: number | null
  /** -1 means "offload everything". */
  gpuLayers: number | null
  /** Raw argument string as printed, for display. */
  raw: string
}

export type HealthStep = 'spawn' | 'load' | 'ready' | 'inference' | 'stop'

export interface HealthCheckResult {
  binaryPath: string
  ok: boolean
  /** Steps in the order they were attempted. */
  steps: Array<{ step: HealthStep; ok: boolean; detail: string; ms: number }>
  /** Populated when a step failed. */
  error: string | null
  /** Tokens per second from the probe request, when it got that far. */
  tokensPerSecond: number | null
  checkedAt: number
}

/** A GGUF-carrying repo on Hugging Face. */
export interface HfModel {
  id: string
  downloads: number
  likes: number
  /** Gated repos need an accepted licence and a token, and fail confusingly without one. */
  gated: boolean
  lastModified: string | null
}

export interface HfFile {
  path: string
  size: number
  /** Part of a multi-part model; only the first shard is offered. */
  shard: boolean
  /**
   * A multimodal projector rather than a model. Offering it as a download
   * choice hands the user a file that cannot be launched, so it is fetched
   * alongside its model instead.
   */
  isProjector: boolean
}

/** One row of `llama bench` output. */
export interface BenchResult {
  /** Prompt processing and generation are different workloads with different speeds. */
  kind: 'prompt' | 'generation'
  tokensPerSecond: number
  stddev: number
  gpuLayers: number
  threads: number
  cacheTypeK: string
  cacheTypeV: string
  flashAttn: 'on' | 'off' | 'auto'
  ubatch: number
  nPrompt: number
  nGen: number
  backend: string
  modelType: string
  buildCommit: string
}

/** A Model Context Protocol server, as configured by the user. */
export interface McpServerConfig {
  /** Short identifier, also used to namespace this server's tool names. */
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export interface McpServerState {
  id: string
  name: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  error: string | null
  tools: ToolDefinition[]
  /** What the server calls itself, which may differ from the configured name. */
  serverName: string | null
  /** Recent stderr, where these servers report their problems. */
  log: string[]
}

/**
 * Where an update stands. `available` is a release this copy cannot install
 * itself (an RPM): it is only pointed at. `ready` is downloaded and goes in
 * on the next restart. `unsupported` is a build that never checks.
 */
export interface UpdateState {
  phase: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version: string | null
  percent: number | null
  /** The release's page. */
  url: string | null
  error: string | null
  /** Whether this copy replaces itself (an AppImage) or is only told. */
  selfUpdating: boolean
  /** Whether checks are on; the setting, carried here so one call answers both. */
  enabled?: boolean
}

/** What the app knows about itself, for the About panel. */
export interface AboutView {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

/** The reading pane, which lives in the main process because it is not part of the page. */
export interface ReaderState {
  open: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  error: string
}

/** Configuration and live state together, so the editor never shows one without the other. */
export interface McpSnapshot {
  configs: McpServerConfig[]
  states: McpServerState[]
}

/** A tool the model may call, as the UI lists it and the API declares it. */
export interface ToolDefinition {
  name: string
  /** Short name for the settings list. */
  label: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

export interface ToolSource {
  title: string
  url: string
}

export interface ToolResult {
  ok: boolean
  /**
   * One line describing what happened, kept in the conversation after the full
   * content has been dropped — otherwise every later turn re-sends every page
   * ever fetched and the context fills with history nobody is reading.
   */
  summary: string
  content: string
  sources?: ToolSource[]
}

/** A tool call as it appears in a conversation. */
export interface ToolCallView {
  id: string
  name: string
  argumentsJson: string
  summary?: string
  ok?: boolean
  sources?: ToolSource[]
  /** Full result text, dropped once the model has answered from it. */
  content?: string
  /** Roughly how many tokens the full result occupied. */
  approxTokens?: number
}

/**
 * A right-click, as the renderer needs to draw it.
 *
 * Spell-check results live only in the main process, so they are forwarded
 * rather than looked up: Chromium knows the misspelled word and its
 * suggestions, but nothing in the page can ask for them.
 */
export interface ContextMenuRequest {
  x: number
  y: number
  isEditable: boolean
  selectionText: string
  linkURL: string
  misspelledWord: string
  dictionarySuggestions: string[]
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
}

export type ContextMenuCommand =
  | { type: 'replace-misspelling'; word: string }
  | { type: 'add-to-dictionary'; word: string }
  | { type: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'select-all' }
  | { type: 'copy-text'; text: string }
  | { type: 'open-external'; url: string }

/** What has actually been measured about this machine. */
export interface MachineProfileView {
  gpuBytesPerSecond: number | null
  cpuBytesPerSecond: number | null
  ceilingTokensPerSecond: number | null
  gpuSamples: number
  cpuSamples: number
  vramBytes: number
  ramBytes: number
  /** True when the CPU figure is a stand-in rather than a measurement. */
  cpuAssumed: boolean
}

export interface BenchProgress {
  current: number
  total: number
  stage: string
}

/**
 * What to sweep. Empty arrays mean "leave llama.cpp's default alone"; several
 * values in one array expand into every combination.
 */
export interface BenchRequest {
  modelPath: string
  nPrompt: number
  nGen: number
  repetitions: number
  gpuLayers: number[]
  threads: number[]
  cacheTypes: string[]
  flashAttn: string[]
  ubatch: number[]
}

/** A benchmark run, as the renderer sees it. */
export interface BenchRunView {
  id: string
  request: BenchRequest
  results: BenchResult[]
  progress: BenchProgress | null
  state: 'running' | 'done' | 'failed'
  error: string | null
  startedAt: number
  finishedAt: number | null
  /**
   * Bytes of a half-finished transfer still on disk, checked when the list is
   * read rather than remembered — a later attempt may have completed the file,
   * or it may have been deleted by hand.
   */
  partialBytes?: number
  /** True when the finished file is present on disk. */
  onDisk?: boolean
}

/** How well a model is expected to run on this machine. */
export type FitVerdict =
  /** Every layer fits in VRAM. */
  | 'full'
  /** Some layers fit; the rest run on CPU, which is far slower. */
  | 'partial'
  /** Nothing meaningful fits in VRAM. */
  | 'cpu'
  /** The header could not be read, so no claim is made. */
  | 'unknown'

export type Comfort = 'fast' | 'comfortable' | 'slow' | 'painful' | 'unknown'

export interface RemoteFit {
  file: string
  verdict: FitVerdict
  /** Estimated VRAM for a full offload at a 4k context, in MiB. */
  totalMiB: number | null
  maxGpuLayers: number | null
  note: string | null
  /** Predicted generation speed on this machine, once calibrated. */
  tokensPerSecond: number | null
  comfort: Comfort
  /** Mixture of experts: reads far less per token than its size implies. */
  moe: boolean
  /** Where the weights would have to live: 'gpu', 'hybrid-moe', 'partial', 'cpu', 'wont-load'. */
  placement: string
  speedNotes: string[]
}

export type DownloadState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DownloadJob {
  id: string
  repo: string
  file: string
  expectedBytes: number
  receivedBytes: number
  state: DownloadState
  error: string | null
  /** Absolute path of the finished file, printed by `llama download`. */
  modelPath: string | null
  startedAt: number
  finishedAt: number | null
  /**
   * Bytes of a half-finished transfer still on disk, checked when the list is
   * read rather than remembered — a later attempt may have completed the file,
   * or it may have been deleted by hand.
   */
  partialBytes?: number
  /** True when the finished file is present on disk. */
  onDisk?: boolean
}

/** A remembered, known-good launch configuration for one model. */
export interface LaunchProfileView {
  key: string
  modelPath: string
  modelName: string
  config: Omit<LaunchConfig, 'modelPath'>
  lastUsedAt: number
  loadMs: number | null
  actualContext: number | null
}

export interface ChatSettingsView {
  temperature: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  maxTokens: number
}

export interface CompactionView {
  summary: string
  throughMessageId: string
  /** The user's own turns from the summarised range, kept word for word. */
  userMessages: string[]
  messageCount: number
  at: number
}

export interface ChatMessageView {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Data URLs for images attached to a user turn. */
  images?: string[]
  /** Tool calls the assistant made on this turn, with what came back. */
  toolCalls?: ToolCallView[]
  /** The server's own token counts for the request that produced this turn. */
  usage?: { promptTokens: number; predictedTokens: number; cacheTokens?: number }
  /** Generation ended because the window filled, not because the model was done. */
  ranOutOfContext?: boolean
  createdAt: number
  model?: string
  tokensPerSecond?: number
  reasoning?: string
  stopped?: boolean
  error?: string
}

export interface ConversationView {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  systemPrompt: string
  messages: ChatMessageView[]
  settings: ChatSettingsView
  /** Tool names enabled for this conversation. */
  tools: string[]
  /** Stands in for the oldest messages once they no longer fit; null until then. */
  compaction: CompactionView | null
  /** Whether to compact on its own when the window is nearly full. */
  autoCompact: boolean
  /** What replies must be: free text, JSON matching a schema, or text matching a grammar. */
  output?: OutputSetting
}

export interface ConversationSummaryView {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
}

/** A conversation a search found, with the line where it matched. */
export interface ConversationSearchHitView extends ConversationSummaryView {
  where: 'title' | 'message'
  snippet: string
}

/** A saved system prompt, to start a conversation from. */
export interface PromptPreset {
  id: string
  name: string
  text: string
}

export interface IpcResult<T> {
  ok: true
  value: T
}
export interface IpcFailure {
  ok: false
  error: string
}
export type IpcResponse<T> = IpcResult<T> | IpcFailure
