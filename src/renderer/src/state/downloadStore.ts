import { create } from 'zustand'
import type { DownloadJob, FitVerdict, HfFile, HfModel, RemoteFit } from '@shared/types.js'
import { recommendedQuant } from '@shared/moeFit.js'
import { useServerStore } from './serverStore.js'

interface DownloadState {
  query: string
  results: HfModel[]
  searching: boolean
  /** Repo whose file list is expanded, and its GGUF files. */
  expanded: string | null
  files: HfFile[]
  filesLoading: boolean
  /** Fit estimate per file in the expanded repo, keyed by file path. */
  fits: Record<string, RemoteFit>
  fitsLoading: boolean
  sortBy: 'size' | 'fit' | 'speed'
  onlyFitting: boolean
  /** MTP heads and speculative drafts are hidden. Off shows them. */
  chatOnly: boolean
  jobs: DownloadJob[]
  error: string | null

  setQuery: (q: string) => void
  search: () => Promise<void>
  expand: (repo: string) => Promise<void>
  setSortBy: (by: 'size' | 'fit' | 'speed') => void
  setOnlyFitting: (only: boolean) => void
  setChatOnly: (chatOnly: boolean) => void
  start: (repo: string, file: HfFile) => Promise<void>
  cancel: (id: string) => Promise<void>
  forget: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
  refreshJobs: () => Promise<void>
  clearError: () => void
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  query: '',
  results: [],
  searching: false,
  expanded: null,
  files: [],
  filesLoading: false,
  fits: {},
  fitsLoading: false,
  sortBy: 'fit',
  onlyFitting: false,
  chatOnly: true,
  jobs: [],
  error: null,

  setQuery(query) {
    set({ query })
  },

  async search() {
    set({ searching: true, error: null })
    try {
      set({ results: await window.llama.downloads.search(get().query, get().chatOnly), expanded: null, files: [] })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ searching: false })
    }
  },

  async expand(repo) {
    if (get().expanded === repo) {
      set({ expanded: null, files: [] })
      return
    }
    set({ expanded: repo, files: [], fits: {}, filesLoading: true, error: null })
    try {
      const files = await window.llama.downloads.files(repo)
      // Guard against a slower earlier request landing after a newer one.
      if (get().expanded !== repo) return
      set({ files, filesLoading: false, fitsLoading: true })

      // Fit estimates need a ranged fetch of the model header, so they arrive
      // after the file list rather than blocking it.
      const fits = await window.llama.downloads.fit(repo)
      if (get().expanded !== repo) return
      set({ fits: Object.fromEntries(fits.map((f) => [f.file, f])) })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ filesLoading: false, fitsLoading: false })
    }
  },

  setSortBy(sortBy) {
    set({ sortBy })
  },

  setOnlyFitting(onlyFitting) {
    set({ onlyFitting })
  },

  setChatOnly(chatOnly) {
    set({ chatOnly })
    void get().search()
  },

  async start(repo, file) {
    set({ error: null })
    try {
      await window.llama.downloads.start(repo, file.path, file.size)
      await get().refreshJobs()
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async cancel(id) {
    try {
      await window.llama.downloads.cancel(id)
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  /** Remove one entry from the list. The downloaded file is untouched. */
  async forget(id) {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
    try {
      await window.llama.downloads.forget(id)
    } catch (err) {
      set({ error: (err as Error).message })
      await get().refreshJobs()
    }
  },

  async clearFinished() {
    set((s) => ({ jobs: s.jobs.filter((j) => j.state === 'running' || j.state === 'queued') }))
    try {
      await window.llama.downloads.clearFinished()
    } catch (err) {
      set({ error: (err as Error).message })
      await get().refreshJobs()
    }
  },

  async refreshJobs() {
    try {
      set({ jobs: await window.llama.downloads.list() })
    } catch {
      // The list is a convenience; failing to read it is not worth an error.
    }
  },

  clearError() {
    set({ error: null })
  }
}))

/** Best first: a full offload, then experts-in-RAM, then a partial split, then CPU-only. */
export const FIT_RANK: Record<FitVerdict, number> = { full: 0, hybrid: 1, partial: 2, cpu: 3, unknown: 4 }

/**
 * The best choice is the largest quantisation that still fits entirely in
 * VRAM. When none do, a mixture of experts gets the sweet spot for this card
 * — IQ2_M or Q3 on about 8 GB, Q4_K_M on about 12 GB — rather than no
 * recommendation at all. `cardMiB` is total VRAM when the device reports it.
 */
export function recommendedFile(
  files: HfFile[],
  fits: Record<string, RemoteFit>,
  cardMiB: number | null = null
): string | null {
  return recommendedQuant(files, fits, cardMiB)
}

/** Push job updates from main into the store. */
export function subscribeToDownloads(): () => void {
  void useDownloadStore.getState().refreshJobs()
  return window.llama.downloads.onChanged((job) => {
    useDownloadStore.setState((s) => {
      const jobs = s.jobs.some((j) => j.id === job.id)
        ? s.jobs.map((j) => (j.id === job.id ? job : j))
        : [job, ...s.jobs]
      return { jobs }
    })
    // A finished download is a new model, so the library has to notice.
    if (job.state === 'done') void useServerStore.getState().loadModels(true)
  })
}
