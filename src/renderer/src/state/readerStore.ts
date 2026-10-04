import { create } from 'zustand'
import type { ReaderState } from '@shared/types.js'

interface ReaderStore extends ReaderState {
  /** Set while a modal covers the window: the pane draws over the page, so it has to go. */
  hidden: boolean
  width: number
  openUrl: (url: string) => Promise<void>
  close: () => Promise<void>
  back: () => Promise<void>
  openExternal: () => void
  /** Open the held private page here after all, or let it go. */
  decideHeld: (open: boolean) => Promise<void>
  setHidden: (hidden: boolean) => void
  setWidth: (width: number) => void
}

const EMPTY: ReaderState = {
  open: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  error: '',
  held: null
}

/** A cramped column is the difference between reading a page and squinting at it. */
const MIN_WIDTH = 320
const MAX_WIDTH = 900
const STORED_WIDTH = 'reader.width'

export const useReaderStore = create<ReaderStore>((set, get) => ({
  ...EMPTY,
  hidden: false,
  width: readStoredWidth(),

  async openUrl(url) {
    const state = await window.llama.reader.open(url)
    if (state) set(state)
  },
  async close() {
    const state = await window.llama.reader.close()
    set(state ?? EMPTY)
  },
  async back() {
    await window.llama.reader.back()
  },
  openExternal() {
    // A held page is the one the person is looking at, though nothing loaded.
    const { url, held } = get()
    const target = held?.url ?? url
    if (target) void window.llama.reader.openExternal(target)
  },
  async decideHeld(open) {
    const state = await window.llama.reader.decideHeld(open)
    set(state ?? EMPTY)
  },
  setHidden(hidden) {
    set({ hidden })
  },
  setWidth(width) {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
    set({ width: clamped })
    try {
      localStorage.setItem(STORED_WIDTH, String(clamped))
    } catch {
      // A remembered width is a convenience, not something worth failing over.
    }
  }
}))

function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORED_WIDTH))
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) return Math.min(MAX_WIDTH, stored)
  } catch {
    /* falls through to the default */
  }
  return 480
}

/** The pane lives in the main process, so its state arrives rather than being held here. */
export function subscribeToReader(): () => void {
  return window.llama.reader.onChanged((state) => useReaderStore.setState(state))
}
