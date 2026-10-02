import { app } from 'electron'
import { EventEmitter } from 'node:events'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types.js'
import { updateMode, type UpdateMode } from './updateMode.js'

const { autoUpdater } = electronUpdater

/**
 * Updates, from the GitHub releases electron-builder publishes.
 *
 * An AppImage is a single file the user owns, so it updates itself: the new
 * one downloads in the background, is checked against the sha512 in the
 * release's latest-linux.yml, and replaces the old file when the app quits.
 * An RPM belongs to the package manager, and installing one means a password
 * prompt, which is not "on the next restart" — so an RPM, or anything else,
 * is only told that a release exists and where. A build that is not packaged
 * never checks.
 *
 * Checks contact GitHub, so they can be turned off; the setting lives with the
 * other settings and this only reads it.
 */

/** First check after start, once the window has settled; then every few hours. */
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RELEASES = 'https://github.com/giobuilds/lowerbeam/releases'

export class Updater extends EventEmitter {
  private current: UpdateState
  private timer: NodeJS.Timeout | null = null
  private readonly mode: UpdateMode

  constructor(private readonly enabled: () => boolean) {
    super()
    this.mode = updateMode(app.isPackaged)
    this.current = { phase: this.mode === 'off' ? 'unsupported' : 'idle', version: null, percent: null, url: null, error: null, selfUpdating: this.mode === 'self' }
    if (this.mode === 'off') return

    autoUpdater.autoDownload = this.mode === 'self'
    autoUpdater.autoInstallOnAppQuit = this.mode === 'self'
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    // For trying the whole flow against a local server before any release
    // exists: a generic provider serving latest-linux.yml and the AppImage.
    const feed = process.env['LOWERBEAM_UPDATE_URL']
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })

    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking', error: null }))
    autoUpdater.on('update-not-available', () => this.set({ phase: 'idle' }))
    autoUpdater.on('update-available', (info) => {
      const url = `${RELEASES}/tag/v${info.version}`
      this.set(this.mode === 'self' ? { phase: 'downloading', version: info.version, percent: 0, url } : { phase: 'available', version: info.version, url })
    })
    autoUpdater.on('download-progress', (p) => this.set({ phase: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ phase: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', (err: Error) => this.set({ phase: 'error', error: err.message.split('\n')[0] ?? 'update failed' }))
  }

  get state(): UpdateState {
    return this.current
  }

  /** Start checking on a schedule, if checks are on. Called once the window exists. */
  start(): void {
    if (this.mode === 'off' || this.timer) return
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  /** Check now, unless checks are off or an update is already on its way or waiting. */
  async check(): Promise<UpdateState> {
    if (this.mode === 'off' || !this.enabled()) return this.current
    if (this.current.phase === 'downloading' || this.current.phase === 'ready') return this.current
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message.split('\n')[0] ?? 'update check failed' })
    }
    return this.current
  }

  /** Quit, install the downloaded update, and start the new version. */
  restartToUpdate(): void {
    if (this.current.phase !== 'ready') throw new Error('No update has been downloaded.')
    autoUpdater.quitAndInstall(true, true)
  }

  private set(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.emit('state', this.current)
  }
}
