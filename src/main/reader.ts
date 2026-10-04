import { WebContentsView, session, shell, type BaseWindow, type BrowserWindow, type WebContents } from 'electron'
import { IPC } from '@shared/ipc.js'
import { EventEmitter } from 'node:events'
import type { ReaderState } from '@shared/types.js'
import { isWebUrl } from '@shared/url.js'
import { privateHostReason } from './web.js'

/**
 * The pane that shows a page from a search result.
 *
 * It exists because the alternative was worse: an ordinary link click navigated
 * the app window itself, and the preload bridge stays attached across a
 * navigation, so the page arrived holding every IPC channel this app has —
 * including the one that starts MCP servers, which runs a command. A page the
 * model found could have spawned processes.
 *
 * So the reader is a separate web contents with no preload at all, its own
 * empty session, and no way to reach the app: the bridge does not exist in it,
 * and it never shares an origin with the renderer. It draws over the window
 * rather than inside the page, which is why the renderer has to tell it where.
 *
 * Nor does it reach this computer or the local network unasked. A link in a
 * model's answer to `http://192.168.1.1/…` or `http://127.0.0.1:<port>/slots`
 * is held, and the person is asked; a page's own requests there — an image
 * aimed at a router — are cancelled. Every request in the pane's session goes
 * through the check, so a redirect there is held the same way.
 */
export class Reader extends EventEmitter<{ state: [ReaderState] }> {
  private view: WebContentsView | null = null
  private bounds: Electron.Rectangle | null = null
  private lastError = ''
  private held: { url: string; why: string } | null = null
  /** The last page that loaded with a response, for going back to when a held page is not opened. */
  private lastLoaded = ''
  /** Hosts the person chose to open although they are private; for as long as the pane is open. */
  private allowedHosts = new Set<string>()
  private verdicts = new Map<string, Promise<string | null>>()

  constructor(private readonly window: BaseWindow) {
    super()
  }

  get state(): ReaderState {
    const wc = this.view?.webContents
    return {
      open: this.view !== null,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      error: this.lastError,
      held: this.held
    }
  }

  open(url: string): void {
    if (!isWebUrl(url)) return
    this.lastError = ''
    this.held = null
    const view = this.view ?? this.create()
    void view.webContents.loadURL(url)
    this.announce()
  }

  /** The person's answer about a held private page: open it, and its host from now on, or let it go. */
  decideHeld(open: boolean): void {
    const held = this.held
    if (!held) return
    this.held = null
    const wc = this.view?.webContents
    if (open) {
      this.allowedHosts.add(new URL(held.url).hostname)
      void wc?.loadURL(held.url)
    } else {
      // The refused load left an error page where the page was. Back to the
      // page the link was on, or, when there was none, close. (Electron's
      // canGoBack does not count that error page, so going back is no help.)
      if (!wc || !this.lastLoaded) return this.close()
      void wc.loadURL(this.lastLoaded)
    }
    this.announce()
  }

  /**
   * Whether a request from this pane may go out. Called for every request in
   * the session; a top-level page on a private address is held for the
   * person, anything else there is refused.
   */
  async admits(url: string, resourceType: string): Promise<boolean> {
    if (!/^https?:/i.test(url)) return true
    const host = new URL(url).hostname
    if (this.allowedHosts.has(host)) return true
    let verdict = this.verdicts.get(host)
    if (!verdict) {
      verdict = privateHostReason(url)
      this.verdicts.set(host, verdict)
    }
    const why = await verdict
    if (!why) return true
    if (resourceType === 'mainFrame') {
      this.held = { url, why }
      this.announce()
    }
    return false
  }

  /** Where in the window the pane sits, or null while something covers it. */
  setBounds(bounds: Electron.Rectangle | null): void {
    this.bounds = bounds
    if (!this.view) return
    // Zero bounds do not hide a view — it keeps its last size and goes on
    // drawing — so visibility is what has to be switched.
    this.view.setVisible(bounds !== null)
    if (bounds) this.view.setBounds(bounds)
  }

  goBack(): void {
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  close(): void {
    if (!this.view) return
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    // The page keeps running until its contents are destroyed: a video would go
    // on playing behind a closed pane.
    this.view.webContents.close()
    this.view = null
    this.lastError = ''
    this.held = null
    this.lastLoaded = ''
    this.allowedHosts.clear()
    this.verdicts.clear()
    this.announce()
  }

  /**
   * The window is going. Let go of the page without touching the window, whose
   * contentView and webContents are already destroyed by the time this runs.
   */
  dispose(): void {
    const wc = this.view?.webContents
    this.view = null
    this.bounds = null
    if (wc && !wc.isDestroyed()) wc.close()
    this.removeAllListeners()
  }

  private create(): WebContentsView {
    const partition = 'reader'
    const readerSession = session.fromPartition(partition)

    // Nothing a page asks for is worth granting: this pane exists to read text.
    readerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    readerSession.setPermissionCheckHandler(() => false)
    readerSession.on('will-download', (event) => event.preventDefault())
    guardSession(readerSession)

    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // Deliberately no preload. This is the whole point of the pane.
        spellcheck: false
      }
    })
    this.view = view

    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      // A page opening a window means a link the reader should follow, not a
      // second window this app has to police.
      if (isWebUrl(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault()
    })

    wc.on('did-start-loading', () => this.announce())
    wc.on('did-stop-loading', () => this.announce())
    wc.on('page-title-updated', () => this.announce())
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      if (httpResponseCode > 0) this.lastLoaded = url
      this.lastError = ''
      this.announce()
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // Aborted loads are what a user clicking away looks like, not a failure.
      // -20 is a request the guard cancelled; a held page says so itself.
      if (!isMainFrame || code === -3 || (code === -20 && this.held)) return
      this.lastError = `${description || 'Could not load'} (${url})`
      this.announce()
    })

    this.window.contentView.addChildView(view)
    view.setVisible(this.bounds !== null)
    if (this.bounds) view.setBounds(this.bounds)
    return view
  }

  /** Whether a request came from this pane's page. */
  owns(webContentsId: number | undefined): boolean {
    return webContentsId !== undefined && this.view?.webContents.id === webContentsId
  }

  private announce(): void {
    this.emit('state', this.state)
  }
}

/**
 * Every reader window shares the one partition, and a session has one
 * request hook, so it is set once and asks the reader whose page made the
 * request. A request from no reader's page is refused.
 */
let guarded = false
function guardSession(readerSession: Electron.Session): void {
  if (guarded) return
  guarded = true
  readerSession.webRequest.onBeforeRequest((details, callback) => {
    const reader = [...readers.values()].find((r) => r.owns(details.webContentsId))
    if (!reader) return callback({ cancel: true })
    reader.admits(details.url, details.resourceType).then(
      (ok) => callback({ cancel: !ok }),
      () => callback({ cancel: true })
    )
  })
}

/**
 * One reader per window, found from whichever window sent the request, so the
 * handlers stay window-agnostic the way the rest of the IPC surface is.
 */
const readers = new Map<number, Reader>()

export function attachReader(win: BrowserWindow): Reader {
  const reader = new Reader(win)
  // Read once and keep it: after the window is destroyed, even reaching for its
  // webContents throws, which is what crashed the main process on quit.
  const id = win.webContents.id
  readers.set(id, reader)
  reader.on('state', (state) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.readerChanged, state)
  })
  win.on('closed', () => {
    readers.delete(id)
    reader.dispose()
  })
  return reader
}

export function readerFor(sender: WebContents): Reader | undefined {
  return readers.get(sender.id)
}

/** Hand a URL to the browser the user actually uses. */
export function openExternally(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url)
}
