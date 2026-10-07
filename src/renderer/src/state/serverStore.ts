import { create } from 'zustand'
import type {
  BinaryInfo,
  FitSuggestion,
  GpuDevice,
  HealthCheckResult,
  LaunchProfileView,
  LaunchConfig,
  LogLine,
  ModelEntryView,
  RouterLaunch,
  RouterPlanView,
  ServedModel,
  ServerStatus,
  SpeculationMeasure,
  VramPlanView
} from '@shared/types.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import { servedModel } from '@shared/served.js'

const MAX_RENDERED_LOGS = 2000

interface ServerState {
  status: ServerStatus | null
  binary: BinaryInfo | null
  binaries: BinaryInfo[]
  devices: GpuDevice[]
  models: ModelEntryView[]
  modelsLoading: boolean
  plan: VramPlanView | null
  fit: FitSuggestion | null
  fitLoading: boolean
  health: HealthCheckResult | null
  healthRunning: boolean
  /** Remembered settings for the selected model, if it has been launched before. */
  profile: LaunchProfileView | null
  /** True while the draft still matches the profile that was applied. */
  profileApplied: boolean
  logs: LogLine[]
  lastSeq: number
  draft: LaunchConfig
  /** One model, or several behind a router. */
  launchMode: 'single' | 'router'
  /** The router's models, by file, and how many may be resident at once. */
  routerDraft: { models: string[]; modelsMax: number }
  routerPlan: RouterPlanView | null
  /** In router mode, the model chat and coding send their requests to; null picks a loaded one. */
  activeModel: string | null
  /** Speculative decoding measured with and without, for the draft being edited. */
  speculation: { running: boolean; step: string | null; result: SpeculationMeasure | null; error: string | null }
  busy: boolean
  error: string | null

  init: () => Promise<void>
  selectBinary: (path: string) => Promise<void>
  loadModels: (force?: boolean) => Promise<void>
  addModelDir: () => Promise<void>
  refreshPlan: () => Promise<void>
  refreshFit: () => Promise<void>
  runHealthCheck: () => Promise<void>
  selectModel: (modelPath: string) => Promise<void>
  forgetProfile: () => Promise<void>
  pullLogs: () => Promise<void>
  setDraft: (patch: Partial<LaunchConfig>) => void
  start: () => Promise<void>
  setLaunchMode: (mode: 'single' | 'router') => void
  toggleRouterModel: (path: string) => void
  setRouterMax: (n: number) => void
  refreshRouterPlan: () => Promise<void>
  setActiveModel: (id: string | null) => void
  measureSpeculation: () => Promise<void>
  stop: () => Promise<void>
  refreshDevices: () => Promise<void>
  clearError: () => void
}

export const useServerStore = create<ServerState>((set, get) => ({
  status: null,
  binary: null,
  binaries: [],
  devices: [],
  models: [],
  modelsLoading: false,
  plan: null,
  fit: null,
  fitLoading: false,
  health: null,
  healthRunning: false,
  profile: null,
  profileApplied: false,
  logs: [],
  lastSeq: 0,
  draft: { modelPath: '', ...DEFAULT_LAUNCH_CONFIG },
  launchMode: 'single',
  routerDraft: { models: [], modelsMax: 1 },
  routerPlan: null,
  activeModel: null,
  speculation: { running: false, step: null, result: null, error: null },
  busy: false,
  error: null,

  async init() {
    const [status, binary, binaries] = await Promise.all([
      window.llama.server.status(),
      window.llama.binary.info(),
      window.llama.binary.list()
    ])
    set({ status, binary, binaries, devices: binary.devices })
    // An adopted router is shown as the router it is.
    if (status.router) {
      set({ launchMode: 'router', routerDraft: { models: status.router.models.map((m) => m.modelPath), modelsMax: status.router.modelsMax } })
    }
    // Adopting a running server means its config is the truth, not our defaults.
    if (status.config) {
      set({ draft: status.config })
      try {
        const profile = await window.llama.profiles.get(status.config.modelPath)
        set({ profile, profileApplied: Boolean(profile) })
      } catch {
        // No profile yet is normal.
      }
    }
    await Promise.all([get().pullLogs(), get().loadModels()])
    void get().refreshFit()
  },

  async loadModels(force = false) {
    set({ modelsLoading: true })
    try {
      const models = force ? await window.llama.models.rescan() : await window.llama.models.list()
      set({ models })
      // A model may already be selected (adopted server, restored draft), so the
      // plan is refreshed as soon as the library is known.
      if (get().draft.modelPath) await get().refreshPlan()
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ modelsLoading: false })
    }
  },

  async addModelDir() {
    try {
      const dir = await window.llama.dialog.pickModelDir()
      if (dir) await get().loadModels(true)
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  /**
   * llama.cpp's own fitting tool loads the model to measure, so this is only
   * called when the model or binary changes — never on a slider movement.
   */
  async refreshFit() {
    const { draft } = get()
    if (!draft.modelPath) {
      set({ fit: null })
      return
    }
    set({ fitLoading: true })
    try {
      set({ fit: await window.llama.models.fit(draft.modelPath) })
    } catch {
      set({ fit: null })
    } finally {
      set({ fitLoading: false })
    }
  },

  async runHealthCheck() {
    const { draft } = get()
    if (!draft.modelPath) {
      set({ error: 'Choose a model first — verifying needs one to load.' })
      return
    }
    set({ healthRunning: true, health: null, error: null })
    try {
      set({ health: await window.llama.binary.healthCheck(draft.modelPath, draft.gpuLayers) })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ healthRunning: false })
    }
  },

  async refreshPlan() {
    const { draft } = get()
    if (!draft.modelPath) {
      set({ plan: null })
      return
    }
    try {
      set({
        plan: await window.llama.models.plan({
          modelPath: draft.modelPath,
          gpuLayers: draft.gpuLayers,
          contextSize: draft.contextSize || 4096,
          cacheTypeK: draft.cacheTypeK,
          cacheTypeV: draft.cacheTypeV,
          parallel: draft.parallel,
          cpuMoeLayers: draft.cpuMoeLayers,
          speculative: draft.speculative ?? 'off',
          draftModelPath: draft.draftModelPath ?? null
        })
      })
    } catch {
      // A file outside the scanned library cannot be planned for; the UI just
      // hides the estimate rather than showing an error for it.
      set({ plan: null })
    }
  },

  async pullLogs() {
    const fresh = await window.llama.logs.since(get().lastSeq)
    if (fresh.length === 0) return
    set((s) => {
      const logs = [...s.logs, ...fresh]
      return {
        logs: logs.length > MAX_RENDERED_LOGS ? logs.slice(-MAX_RENDERED_LOGS) : logs,
        lastSeq: fresh[fresh.length - 1]!.seq
      }
    })
  },

  async selectBinary(path) {
    set({ busy: true, error: null })
    try {
      const binary = await window.llama.binary.select(path)
      // A different binary means a different allocator and a different verdict.
      set({ binary, devices: binary.devices, health: null, fit: null })
      void get().refreshPlan()
      void get().refreshFit()
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  /**
   * Choosing a model applies whatever settings last worked for it. Without this
   * you rediscover the same context and offload limits every time you come back
   * to a model, which is the pain this app exists to remove.
   */
  async selectModel(modelPath) {
    const previous = get().draft.modelPath
    if (modelPath === previous) return
    set({ health: null, fit: null, profile: null, profileApplied: false })

    let profile: LaunchProfileView | null = null
    try {
      profile = await window.llama.profiles.get(modelPath)
    } catch {
      // A missing profile is the normal case for a new model.
    }

    // A vision model without its projector loads as text-only and never says
    // so, so the pairing found on disk is applied unless a profile overrides it.
    const projector = get().models.find((m) => m.path === modelPath)?.projectorPath ?? null

    set((s) => ({
      draft: profile
        ? { ...s.draft, ...profile.config, modelPath }
        : { ...s.draft, modelPath, mmprojPath: projector },
      profile,
      profileApplied: Boolean(profile)
    }))
    void get().refreshPlan()
    void get().refreshFit()
  },

  async forgetProfile() {
    const { draft } = get()
    if (!draft.modelPath) return
    try {
      await window.llama.profiles.forget(draft.modelPath)
      set({ profile: null, profileApplied: false })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  setDraft(patch) {
    const prevModel = get().draft.modelPath
    // Editing any launch setting means the draft is no longer the remembered
    // configuration, and the badge should stop claiming otherwise.
    if (Object.keys(patch).some((k) => k !== 'modelPath')) set({ profileApplied: false })
    set((s) => ({ draft: { ...s.draft, ...patch } }))
    // Every knob changes the VRAM estimate, so it is recomputed continuously.
    void get().refreshPlan()
    // The fit suggestion and health result belong to a model, so they are
    // invalidated when it changes rather than shown against the wrong one.
    if (patch.modelPath && patch.modelPath !== prevModel) {
      set({ health: null })
      void get().refreshFit()
    }
  },

  async start() {
    const { draft, launchMode } = get()
    if (launchMode === 'router') {
      if (get().routerDraft.models.length === 0) {
        set({ error: 'Choose at least one model for the router.' })
        return
      }
      set({ busy: true, error: null })
      try {
        set({ status: await window.llama.server.startRouter(await routerLaunch(get())) })
      } catch (err) {
        set({ error: (err as Error).message })
      } finally {
        set({ busy: false })
      }
      return
    }
    if (!draft.modelPath) {
      set({ error: 'Choose a .gguf model first.' })
      return
    }
    set({ busy: true, error: null })
    try {
      const status = await window.llama.server.start(draft)
      set({ status })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  setLaunchMode(launchMode) {
    set({ launchMode })
    if (launchMode === 'router') void get().refreshRouterPlan()
  },

  toggleRouterModel(path) {
    const { routerDraft } = get()
    const models = routerDraft.models.includes(path) ? routerDraft.models.filter((p) => p !== path) : [...routerDraft.models, path]
    set({ routerDraft: { models, modelsMax: Math.min(routerDraft.modelsMax, Math.max(1, models.length)) } })
    void get().refreshRouterPlan()
  },

  setRouterMax(n) {
    const { routerDraft } = get()
    set({ routerDraft: { ...routerDraft, modelsMax: Math.max(1, Math.min(n, Math.max(1, routerDraft.models.length))) } })
    void get().refreshRouterPlan()
  },

  async refreshRouterPlan() {
    if (get().routerDraft.models.length === 0) {
      set({ routerPlan: null })
      return
    }
    try {
      set({ routerPlan: await window.llama.models.planRouter(await routerLaunch(get())) })
    } catch {
      set({ routerPlan: null })
    }
  },

  setActiveModel(activeModel) {
    set({ activeModel })
  },

  async measureSpeculation() {
    const { draft } = get()
    set({ speculation: { running: true, step: 'starting', result: null, error: null } })
    const off = window.llama.models.onMeasureSpeculationProgress((step) => set({ speculation: { ...get().speculation, step } }))
    try {
      const result = await window.llama.models.measureSpeculation(draft)
      set({ speculation: { running: false, step: null, result, error: null } })
    } catch (err) {
      set({ speculation: { running: false, step: null, result: null, error: (err as Error).message } })
    } finally {
      off()
    }
  },

  async stop() {
    set({ busy: true, error: null })
    try {
      set({ status: await window.llama.server.stop() })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  async refreshDevices() {
    try {
      set({ devices: await window.llama.binary.devices() })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  clearError() {
    set({ error: null })
  }
}))

/**
 * Each of the router's models with the launch it last worked with — its
 * profile — or the defaults with its projector, as choosing it on its own
 * would give.
 */
async function routerLaunch(s: ServerState): Promise<RouterLaunch> {
  const models = await Promise.all(
    s.routerDraft.models.map(async (modelPath): Promise<LaunchConfig> => {
      let profile: LaunchProfileView | null = null
      try {
        profile = await window.llama.profiles.get(modelPath)
      } catch {
        // None yet: the defaults.
      }
      const projector = s.models.find((m) => m.path === modelPath)?.projectorPath ?? null
      return profile ? { ...DEFAULT_LAUNCH_CONFIG, ...profile.config, modelPath } : { ...DEFAULT_LAUNCH_CONFIG, modelPath, mmprojPath: projector }
    })
  )
  return { models, modelsMax: s.routerDraft.modelsMax }
}

/** The model requests go to now: the one picked, in a router, or the only one. */
export function currentServed(): ServedModel | null {
  const { status, activeModel } = useServerStore.getState()
  return servedModel(status, activeModel)
}

/** Wire the push events from main into the store. Called once at mount. */
export function subscribeToMain(): () => void {
  const store = useServerStore
  let wasReady = false
  const offStatus = window.llama.server.onStatus((status) => {
    store.setState({ status })
    // Main records a profile once a launch actually reaches ready, so the badge
    // only becomes accurate after that write has happened.
    const nowReady = status.phase === 'ready'
    if (nowReady && !wasReady && status.config?.modelPath) {
      void window.llama.profiles
        .get(status.config.modelPath)
        .then((profile) => store.setState({ profile, profileApplied: Boolean(profile) }))
        .catch(() => {})
    }
    wasReady = nowReady
  })
  const offLogs = window.llama.logs.onChanged(() => {
    void store.getState().pullLogs()
  })
  return () => {
    offStatus()
    offLogs()
  }
}
