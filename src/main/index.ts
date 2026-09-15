import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerSupervisor } from './supervisor.js'
import { probeAll } from './probe.js'
import { SettingsStore } from './settings.js'
import { ConversationStore } from './conversations.js'
import { ProfileStore } from './profiles.js'
import { recordSuccessfulLaunches } from './profileRecorder.js'
import { DownloadManager } from './downloads.js'
import { McpRegistry } from './mcpRegistry.js'
import { setSearxngUrl } from './tools.js'
import { registerIpc, wireEvents } from './ipc.js'
import { buildAppMenu } from './menu.js'
import { migrateLegacyUserData } from './migrate.js'
import { attachContextMenu, registerContextMenuCommands } from './contextMenu.js'
import { attachReader } from './reader.js'
import { CodingSupervisor } from './coding/supervisor.js'
import { isWebUrl } from '@shared/url.js'
import type { BinaryInfo } from '@shared/types.js'

const dirname = fileURLToPath(new URL('.', import.meta.url))

let supervisor: ServerSupervisor | null = null
let downloads: DownloadManager | null = null
let mcp: McpRegistry | null = null
let coding: CodingSupervisor | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Lowerbeam',
    // Packaged, the desktop entry carries the icon; in development the window has it from here.
    ...(app.isPackaged ? {} : { icon: join(dirname, '../../resources/icon.png') }),
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      spellcheck: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  attachContextMenu(win)
  const reader = attachReader(win)

  // External links open in the reading pane, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    reader.open(url)
    return { action: 'deny' }
  })

  // The one that matters: an ordinary <a href> is a same-window navigation, and
  // the preload bridge survives it — a remote page would arrive holding every
  // IPC channel this app has, including the one that runs a command to start an
  // MCP server. The app window renders its own files and nothing else, ever.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isWebUrl(url)) reader.open(url)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * Whether a URL is the app itself: its own files in a build, or the dev server.
 * Anything else — including a reload of a page already navigated to — is not.
 */
export function isAppUrl(url: string): boolean {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) return url.startsWith(dev)
  return url.startsWith('file://')
}

/**
 * The renderer streams tokens straight from llama-server, so it needs to reach
 * loopback HTTP — and nothing else. Everything remote stays blocked.
 */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const dev = Boolean(process.env['ELECTRON_RENDERER_URL'])
    const csp = [
      "default-src 'self'",
      // Vite injects inline styles in dev; production is bundled and needs no exception.
      dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
      `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*${dev ? ' ws://localhost:*' : ''}`,
      "object-src 'none'",
      "frame-src 'none'"
    ].join('; ')
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
    })
  })
}

async function bootstrap(): Promise<void> {
  applyCsp()

  // Must happen before any store reads its file: the app was renamed, and
  // Electron derives this directory from the application name, so without this
  // every conversation, profile and measurement would look lost.
  const migrated = await migrateLegacyUserData(app.getPath('userData'))
  if (migrated) console.log(`carried settings across from ${migrated}`)

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  await settings.load()

  const discovered = await probeAll(
    settings.current.binaryPath ?? process.env['LLAMA_SERVER_PATH']
  )
  // A previously chosen binary wins; otherwise take the first discovered, which
  // prefers the unified `llama` CLI over a possibly stale distro llama-server.
  const chosen =
    discovered.find((b) => b.path === settings.current.binaryPath) ??
    discovered[0] ??
    // The UI still opens with nothing installed — it shows a "not found" state
    // rather than the app failing to launch at all.
    ({
      path: '',
      kind: 'unified',
      argvPrefix: [],
      version: 'not found',
      flags: [],
      flagDocs: [],
      flashAttnStyle: 'bare',
      devices: [],
      label: 'no llama.cpp found'
    } satisfies BinaryInfo)

  const conversations = new ConversationStore(join(app.getPath('userData'), 'conversations'))
  await conversations.init()

  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles.json'))
  await profiles.load()

  supervisor = new ServerSupervisor(chosen, join(app.getPath('userData'), 'server.json'))
  recordSuccessfulLaunches(supervisor, profiles)

  // The manager reads the binary lazily so a binary swap is picked up without
  // having to rebuild it.
  downloads = new DownloadManager(
    () => supervisor!.binaryInfo,
    (job) => {
      void settings.patch({
        downloadHistory: [job, ...settings.current.downloadHistory.filter((j) => j.id !== job.id)]
          .slice(0, 20)
      })
    },
    (id) => {
      void settings.patch({
        downloadHistory: settings.current.downloadHistory.filter((j) => j.id !== id)
      })
    }
  )
  downloads.restore(settings.current.downloadHistory)

  // Servers the user configured last time are brought back up before the window
  // opens, so their tools are listed as soon as the chat is usable.
  mcp = new McpRegistry((configs) => {
    void settings.patch({ mcpServers: configs })
  })
  setSearxngUrl(settings.current.searxngUrl)
  void mcp.apply(settings.current.mcpServers)
  coding = new CodingSupervisor(join(app.getPath('userData'), 'coding'), () => supervisor)
  await coding.load()

  registerIpc(supervisor, settings, conversations, profiles, mcp, downloads, coding, discovered)
  wireEvents(supervisor, downloads, mcp, coding)
  await supervisor.adoptOrReap()

  registerContextMenuCommands()
  buildAppMenu(() => supervisor)
  createWindow()
}

// A second instance would fight over the handoff file and spawn a rival server.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(bootstrap)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Do not let the app exit while a child llama-server is still alive.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    // Every child has to be stopped whether or not a llama-server is among
    // them: MCP servers are spawned detached, so nothing else would reap them.
    downloads?.shutdown()
    mcp?.shutdown()
    coding?.shutdown()
    if (!supervisor || supervisor.status.pid === null) return
    event.preventDefault()
    void supervisor.shutdown().finally(() => app.quit())
  })
}
