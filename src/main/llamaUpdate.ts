/**
 * The optional once-a-day check for a newer official llama.cpp build.
 *
 * It runs only when the person has turned it on, and only while the selected
 * binary is the one Lowerbeam installed. A check resolves the pinned tag and
 * does not download the archive. Install and Go back are clicks. Neither
 * runs while a server is starting, loading, ready, degraded or stopping.
 * The previous build stays on disk until the new probe has passed.
 */

import {
  LLAMA_CHECK_INTERVAL_MS,
  checkDue,
  llamaUpdateView,
  newerOfficialBuild,
  tagBuildNumber,
  updateCheckApplies
} from '@shared/llamaOffer.js'
import type { BinaryInfo, LlamaUpdateView, ManagedBuild } from '@shared/types.js'
import { managedDirectory, rememberManagedBuild } from './llamaManage.js'
import type { InstallTreeOptions, InstalledBuild, ResolvedAsset } from './llamaRelease.js'
import type { Settings, SettingsStore } from './settings.js'

/** The slice of the release client the check and Install use. */
export interface LlamaUpdateClient {
  resolve(backend: ManagedBuild['backend'], channel: 'pinned', signal?: AbortSignal): Promise<ResolvedAsset>
  installResolved(asset: ResolvedAsset, options: InstallTreeOptions): Promise<InstalledBuild>
}

/** Install and Go back take no path, tag or URL. */
export function expectNoChoice(args: readonly unknown[]): void {
  if (args.some((item) => item !== undefined)) {
    throw new Error('This action does not take a path or a URL.')
  }
}

export function viewFor(settings: Settings, currentPath: string): LlamaUpdateView {
  return llamaUpdateView({
    enabled: settings.llamaUpdateCheck,
    currentPath,
    managed: settings.managedBuild,
    offer: settings.llamaUpdateOffer,
    rollback: settings.llamaRollback
  })
}

/**
 * Ask which pinned tag is current. Does not download.
 * A failure still counts as the day's check, so a restart does not ask again,
 * and it leaves the previous offer in place.
 */
export async function runLlamaUpdateCheck(opts: {
  settings: SettingsStore
  currentPath: string
  now: Date
  resolve: (backend: ManagedBuild['backend']) => Promise<{ tag: string }>
}): Promise<'skipped' | 'checked' | 'failed'> {
  const current = opts.settings.current
  const managed = current.managedBuild
  if (
    !managed ||
    !updateCheckApplies({
      enabled: current.llamaUpdateCheck,
      currentPath: opts.currentPath,
      managedPath: managed.path
    })
  ) {
    return 'skipped'
  }
  if (!checkDue(current.llamaCheckedAt, opts.now.getTime())) return 'skipped'
  try {
    const asset = await opts.resolve(managed.backend)
    const newer = newerOfficialBuild(tagBuildNumber(managed.tag), tagBuildNumber(asset.tag))
    await opts.settings.patch({
      llamaCheckedAt: opts.now.toISOString(),
      llamaUpdateOffer: newer === null ? null : { tag: asset.tag, backend: managed.backend }
    })
    return 'checked'
  } catch {
    await opts.settings.patch({ llamaCheckedAt: opts.now.toISOString() })
    return 'failed'
  }
}

/**
 * Install the pinned build the check offered.
 * Settings change only after the new binary has passed the probe.
 * The build being replaced is passed as `runningPath` so pruning keeps it.
 */
export async function installOfferedUpdate(opts: {
  settings: SettingsStore
  client: LlamaUpdateClient
  root: string
  currentPath: string
  assertStopped: () => void
  now?: Date
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
}): Promise<InstalledBuild> {
  opts.assertStopped()
  const managed = opts.settings.current.managedBuild
  if (!managed || opts.currentPath !== managed.path) {
    throw new Error('A build you chose yourself is left as it is.')
  }
  if (!viewFor(opts.settings.current, opts.currentPath).offerTag) {
    throw new Error('No newer official build is available.')
  }
  const asset = await opts.client.resolve(managed.backend, 'pinned', opts.signal)
  const now = (opts.now ?? new Date()).toISOString()
  const newer = newerOfficialBuild(tagBuildNumber(managed.tag), tagBuildNumber(asset.tag))
  if (newer === null || asset.backend !== managed.backend) {
    await opts.settings.patch({ llamaCheckedAt: now, llamaUpdateOffer: null })
    throw new Error('No newer official build is available.')
  }
  await opts.settings.patch({
    llamaCheckedAt: now,
    llamaUpdateOffer: { tag: asset.tag, backend: managed.backend }
  })
  const installed = await opts.client.installResolved(asset, {
    root: opts.root,
    backend: managed.backend,
    signal: opts.signal,
    onProgress: opts.onProgress,
    runningPath: managed.path
  })
  if (newerOfficialBuild(tagBuildNumber(managed.tag), tagBuildNumber(installed.tag)) === null) {
    throw new Error('No newer official build is available.')
  }
  await opts.settings.patch({ llamaRollback: managed })
  await rememberManagedBuild(opts.settings, installed)
  await opts.settings.patch({ llamaUpdateOffer: null })
  return installed
}

/**
 * Select the build an update replaced. The folder is already on disk, so
 * this probes it and does not download. A failed probe leaves the current
 * build selected.
 */
export async function restorePreviousBuild(opts: {
  settings: SettingsStore
  root: string
  currentPath: string
  assertStopped: () => void
  probe: (path: string) => Promise<BinaryInfo>
}): Promise<BinaryInfo> {
  opts.assertStopped()
  const current = opts.settings.current.managedBuild
  const previous = opts.settings.current.llamaRollback
  if (!current || opts.currentPath !== current.path) {
    throw new Error('A build you chose yourself is left as it is.')
  }
  if (!previous || previous.path === current.path) {
    throw new Error('There is no earlier official build to go back to.')
  }
  await managedDirectory(opts.root, previous.path)
  const binary = await opts.probe(previous.path)
  const left = current
  await rememberManagedBuild(
    opts.settings,
    {
      tag: previous.tag,
      backend: previous.backend,
      llamaPath: previous.path,
      digest: previous.digest
    },
    previous.installedAt
  )
  const offer =
    newerOfficialBuild(tagBuildNumber(previous.tag), tagBuildNumber(left.tag)) !== null
      ? { tag: left.tag, backend: left.backend }
      : null
  await opts.settings.patch({ llamaRollback: null, llamaUpdateOffer: offer })
  return binary
}

/**
 * Asks at most once a day, and only while the setting is on.
 * The timer does not keep the process alive.
 */
export class LlamaUpdateSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private idle: Promise<void> = Promise.resolve()
  private publish: (view: LlamaUpdateView) => void = () => {}

  constructor(
    private readonly settings: SettingsStore,
    private readonly resolve: (backend: ManagedBuild['backend']) => Promise<{ tag: string }>,
    private readonly currentPath: () => string,
    private readonly now: () => Date = () => new Date()
  ) {}

  setPublisher(fn: (view: LlamaUpdateView) => void): void {
    this.publish = fn
  }

  view(): LlamaUpdateView {
    return viewFor(this.settings.current, this.currentPath())
  }

  publishView(): void {
    this.publish(this.view())
  }

  start(): void {
    void this.kick().catch(() => {})
  }

  stop(): void {
    this.again = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The setting changed, or the selected binary did. */
  nudge(): void {
    void this.kick().catch(() => {})
  }

  /** Run a due check before the caller reads the view, so the answer includes it. */
  settle(): Promise<void> {
    return this.kick()
  }

  private kick(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.idle
    }
    this.running = true
    this.idle = (async () => {
      try {
        do {
          this.again = false
          await this.once()
        } while (this.again)
      } finally {
        this.running = false
      }
    })()
    return this.idle
  }

  private async once(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.settings.current.llamaUpdateCheck) return
    const outcome = await runLlamaUpdateCheck({
      settings: this.settings,
      currentPath: this.currentPath(),
      now: this.now(),
      resolve: this.resolve
    })
    if (outcome !== 'skipped') this.publishView()
    if (!this.settings.current.llamaUpdateCheck) return
    const applies = updateCheckApplies({
      enabled: true,
      currentPath: this.currentPath(),
      managedPath: this.settings.current.managedBuild?.path
    })
    const checkedAt = this.settings.current.llamaCheckedAt
    let wait = LLAMA_CHECK_INTERVAL_MS
    if (applies && checkedAt) {
      const then = Date.parse(checkedAt)
      if (Number.isFinite(then)) wait = then + LLAMA_CHECK_INTERVAL_MS - this.now().getTime()
    }
    this.timer = setTimeout(() => {
      void this.kick()
    }, Math.max(60_000, wait))
    this.timer.unref()
  }
}
