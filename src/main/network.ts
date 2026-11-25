import { OFFLINE_MESSAGE, NET_REASONS, type NetReason, type NetworkView } from '@shared/network.js'

/**
 * The one switch for requests Lowerbeam starts itself, and the record of
 * which of those are in flight.
 *
 * A download that is already running is stopped by the handlers registered
 * with `onStop`. A link the person opens, and an MCP server they enable, are
 * not started here, so the switch does not cancel them.
 */
export class OfflineError extends Error {
  constructor() {
    super(OFFLINE_MESSAGE)
    this.name = 'OfflineError'
  }
}

export class NetworkGate {
  private offline: boolean
  private readonly counts = new Map<NetReason, number>()
  private order: NetReason[] = []
  private readonly listeners = new Set<(view: NetworkView) => void>()
  private readonly stops = new Set<() => void>()

  constructor(offline = false) {
    this.offline = offline
  }

  get isOffline(): boolean {
    return this.offline
  }

  view(): NetworkView {
    return { offline: this.offline, active: this.order.map((reason) => NET_REASONS[reason]) }
  }

  subscribe(fn: (view: NetworkView) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Cancel work that is already past the point of asking. Called only when
   * the switch moves to off, not when it was already off.
   */
  onStop(stop: () => void): () => void {
    this.stops.add(stop)
    return () => this.stops.delete(stop)
  }

  setOffline(offline: boolean): void {
    if (this.offline === offline) return
    this.offline = offline
    if (offline) for (const stop of [...this.stops]) stop()
    this.emit()
  }

  /** Show `reason` until the returned function is called. A second call is a no-op. */
  hold(reason: NetReason): () => void {
    this.add(reason)
    let released = false
    return () => {
      if (released) return
      released = true
      this.remove(reason)
    }
  }

  /**
   * Run one internet call. Refuses before `run` when the switch is off, and
   * the badge shows `reason` until the call settles.
   */
  async reach<T>(reason: NetReason, run: () => Promise<T>): Promise<T> {
    if (this.offline) throw new OfflineError()
    const release = this.hold(reason)
    try {
      if (this.offline) throw new OfflineError()
      return await run()
    } finally {
      release()
    }
  }

  private add(reason: NetReason): void {
    const n = this.counts.get(reason) ?? 0
    this.counts.set(reason, n + 1)
    if (n === 0) this.order.push(reason)
    this.emit()
  }

  private remove(reason: NetReason): void {
    const n = this.counts.get(reason) ?? 0
    if (n <= 1) {
      this.counts.delete(reason)
      this.order = this.order.filter((item) => item !== reason)
    } else {
      this.counts.set(reason, n - 1)
    }
    this.emit()
  }

  private emit(): void {
    const view = this.view()
    for (const fn of this.listeners) fn(view)
  }
}
