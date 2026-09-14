import { create } from 'zustand'
import { DEFAULT_TERMS, type ApplyResult, type ChangeSet, type CodingMode, type CodingRunSummary, type GrantTerms, type JournalEvent } from '@shared/coding.js'
import type { CapabilityStatus } from '@shared/capability.js'
import type { Evidence } from '@shared/evidence.js'

/**
 * A projection of the coding supervisor's state — never a second engine.
 *
 * Runs and their events come from the main process; the store holds what has
 * arrived and asks for the rest on demand. After a reload it rebuilds from
 * the journal rather than from anything it remembered, because the journal
 * is the record and this is a view of it.
 */
interface CodingState {
  project: string | null
  runs: CodingRunSummary[]
  activeRunId: string | null
  /** Events per run, in sequence order, for the runs that have been opened. */
  events: Record<string, JournalEvent[]>
  task: string
  mode: CodingMode
  /** The terms the next run will have beyond its mode: a visible change to the grant, made before the run. */
  terms: GrantTerms
  /** Whether "edit and run" can be offered, and why not when it cannot. */
  sandbox: { ok: boolean; reason: string | null } | null
  /** What the capability record says about the loaded model; null while it is being identified. */
  capability: CapabilityStatus | null
  /** An edit run's changes, once fetched; the last apply or undo result beside them. */
  changes: Record<string, ChangeSet>
  /** What a run's commands show, once fetched. */
  evidence: Record<string, Evidence>
  applyResults: Record<string, ApplyResult>
  busy: Record<string, boolean>
  error: string | null

  init: () => Promise<void>
  setMode: (mode: CodingMode) => void
  setTerms: (patch: Partial<GrantTerms>) => void
  addReadRoot: () => Promise<void>
  removeReadRoot: (dir: string) => void
  loadCapability: () => Promise<void>
  loadChanges: (runId: string) => Promise<void>
  loadEvidence: (runId: string) => Promise<void>
  checkBaseline: (runId: string) => Promise<void>
  apply: (runId: string) => Promise<void>
  undo: (runId: string) => Promise<void>
  discard: (runId: string) => Promise<void>
  pickProject: () => Promise<void>
  setTask: (task: string) => void
  start: () => Promise<void>
  cancel: (runId?: string) => Promise<void>
  open: (runId: string) => Promise<void>
  clearError: () => void
}

export const useCodingStore = create<CodingState>((set, get) => ({
  project: null,
  runs: [],
  activeRunId: null,
  events: {},
  task: '',
  mode: 'inspect',
  terms: DEFAULT_TERMS,
  sandbox: null,
  capability: null,
  changes: {},
  evidence: {},
  applyResults: {},
  busy: {},
  error: null,

  async init() {
    const { runs, lastProject } = await window.llama.coding.list()
    set({ runs, project: lastProject })
    void window.llama.coding.sandbox().then((sandbox) => set({ sandbox }))
    // Reopen the newest run so a reload lands where the user was.
    const newest = runs[runs.length - 1]
    if (newest) await get().open(newest.id)
  },

  async pickProject() {
    const chosen = await window.llama.coding.pickProject()
    if (chosen) set({ project: chosen, error: null })
  },

  setTask(task) {
    set({ task })
  },

  setMode(mode) {
    set({ mode })
  },

  setTerms(patch) {
    set({ terms: { ...get().terms, ...patch } })
  },

  async addReadRoot() {
    const dir = await window.llama.coding.pickReadRoot()
    if (!dir) return
    const { terms, project } = get()
    // The project is granted already; a folder inside it adds nothing.
    if (project && (dir === project || dir.startsWith(project + '/'))) return
    if (!terms.alsoRead.includes(dir)) set({ terms: { ...terms, alsoRead: [...terms.alsoRead, dir] } })
  },

  removeReadRoot(dir) {
    const { terms } = get()
    set({ terms: { ...terms, alsoRead: terms.alsoRead.filter((d) => d !== dir) } })
  },

  async loadCapability() {
    // Identifying a model hashes its file the first time, which takes a
    // while; the tab says so until this lands.
    set({ capability: null })
    try {
      const capability = await window.llama.coding.capability()
      set({ capability })
      // A mode the record refuses is not left selected.
      const { mode } = get()
      if (capability.state === 'measured' && capability.record.modes[mode].verdict === 'refused') set({ mode: 'inspect' })
    } catch (err) {
      set({ capability: { state: 'none' }, error: (err as Error).message })
    }
  },

  async loadChanges(runId) {
    const changes = await window.llama.coding.changes(runId)
    if (changes) set({ changes: { ...get().changes, [runId]: changes } })
  },

  async loadEvidence(runId) {
    const evidence = await window.llama.coding.evidence(runId)
    if (evidence) set({ evidence: { ...get().evidence, [runId]: evidence } })
  },

  async checkBaseline(runId) {
    set({ busy: { ...get().busy, [runId]: true }, error: null })
    try {
      const evidence = await window.llama.coding.checkBaseline(runId)
      if (evidence) set({ evidence: { ...get().evidence, [runId]: evidence } })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      const { [runId]: _done, ...rest } = get().busy
      set({ busy: rest })
    }
  },

  async apply(runId) {
    set({ busy: { ...get().busy, [runId]: true }, error: null })
    try {
      const result = await window.llama.coding.apply(runId)
      set({ applyResults: { ...get().applyResults, [runId]: result } })
      await get().loadChanges(runId)
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      const { [runId]: _done, ...rest } = get().busy
      set({ busy: rest })
    }
  },

  async undo(runId) {
    set({ busy: { ...get().busy, [runId]: true }, error: null })
    try {
      const result = await window.llama.coding.undo(runId)
      set({ applyResults: { ...get().applyResults, [runId]: result } })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      const { [runId]: _done, ...rest } = get().busy
      set({ busy: rest })
    }
  },

  async discard(runId) {
    await window.llama.coding.discard(runId)
    const { [runId]: _gone, ...changes } = get().changes
    set({ changes })
  },

  async start() {
    const { project, task } = get()
    if (!project || !task.trim()) return
    try {
      const run = await window.llama.coding.start({ projectRoot: project, task: task.trim(), mode: get().mode, grant: get().terms })
      set({
        runs: [...get().runs, run],
        activeRunId: run.id,
        events: { ...get().events, [run.id]: get().events[run.id] ?? [] },
        task: '',
        error: null
      })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async cancel(runId) {
    const id = runId ?? get().activeRunId
    if (id) await window.llama.coding.cancel(id)
  },

  async open(runId) {
    set({ activeRunId: runId })
    // Always fetch and merge: what arrived live may be missing its head — the
    // first events race the reply that carries the run id — and the journal
    // is the record, so it wins on any gap.
    const fromDisk = await window.llama.coding.get(runId)
    const live = get().events[runId] ?? []
    const bySeq = new Map<number, JournalEvent>()
    for (const e of [...fromDisk, ...live]) bySeq.set(e.seq, e)
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    set({ events: { ...get().events, [runId]: merged } })
  },

  clearError() {
    set({ error: null })
  }
}))

/** Events and run summaries arrive from the main process; wire them in once. */
export function subscribeToCoding(): () => void {
  const offEvent = window.llama.coding.onEvent((event) => {
    const { events } = useCodingStore.getState()
    // Kept for every run, known or not: a journal is a few kilobytes, and an
    // event that arrives before the run's id does would otherwise be lost.
    const list = events[event.run] ?? []
    // Sequence numbers make a duplicate — a reconnect replaying an event
    // already applied — harmless.
    if (list.some((e) => e.seq === event.seq)) return
    useCodingStore.setState({ events: { ...events, [event.run]: [...list, event] } })
  })
  const offRuns = window.llama.coding.onRunsChanged((runs) => useCodingStore.setState({ runs }))
  return () => {
    offEvent()
    offRuns()
  }
}
