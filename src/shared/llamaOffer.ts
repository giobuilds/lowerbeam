import type { LlamaUpdateView, ManagedBuild } from './types.js'

/**
 * The first-run offer replaces the "not found" notice.
 * A binary that is already there gets neither the offer nor a request:
 * the download runs only when someone clicks Download.
 */
export function showFirstRunOffer(binaryPath: string): boolean {
  return binaryPath === ''
}

/** "Lowerbeam-managed · llama serve 0.6.0-dev (build 11429) · Vulkan" */
export function managedLabel(version: string, kind: string, backend: ManagedBuild['backend']): string {
  const program = kind === 'llama-server' ? 'llama-server' : 'llama serve'
  const which = backend === 'cpu' ? 'CPU' : 'Vulkan'
  return `Lowerbeam-managed · ${program} ${version} · ${which}`
}

export interface DownloadChoice {
  backend: 'vulkan' | 'cpu'
  channel: 'pinned' | 'newest'
}

/** Which ways forward a failure message should offer. The message itself is shown as sent. */
export function downloadRecovery(message: string, choice: DownloadChoice): {
  retry: boolean
  newest: boolean
  cpu: boolean
} {
  const offline = message.startsWith("Couldn't reach GitHub") || message.includes('Download cancelled')
  const pointer = /nightly-tag\.txt|build tag like|None of the five/.test(message)
  return {
    retry: offline,
    newest: pointer && choice.channel === 'pinned',
    cpu: message.includes('No Vulkan GPU') && choice.backend === 'vulkan'
  }
}

/** The Server panel's checkbox. Off unless the person turns it on. */
export const LLAMA_UPDATE_LABEL = 'Check for newer official llama.cpp builds (once a day)'

/** How long a successful or failed check waits before asking GitHub again. */
export const LLAMA_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** `b11429` → 11429. Anything else is not a build number. */
export function tagBuildNumber(tag: string): number | null {
  const match = /^b(\d+)$/.exec(tag)
  const digits = match?.[1]
  if (!digits) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * The pinned build to offer, or null when the number is missing, equal, or older.
 * A missing number is not treated as newer.
 */
export function newerOfficialBuild(installed: number | null, pinned: number | null): number | null {
  if (installed === null || pinned === null) return null
  return pinned > installed ? pinned : null
}

/** The check runs only for the managed binary, and only after the person turns it on. */
export function updateCheckApplies(input: {
  enabled: boolean
  currentPath: string
  managedPath?: string | null
}): boolean {
  const managed = input.managedPath ?? ''
  return input.enabled && managed !== '' && input.currentPath === managed
}

/** True when there has been no check, or the last one was at least a day ago. */
export function checkDue(
  checkedAt: string | null | undefined,
  now: number,
  intervalMs = LLAMA_CHECK_INTERVAL_MS
): boolean {
  if (!checkedAt) return true
  const then = Date.parse(checkedAt)
  if (!Number.isFinite(then)) return true
  return now - then >= intervalMs
}

export function offerSentence(tag: string): string {
  return `llama.cpp ${tag} is available`
}

export function rollbackSentence(tag: string): string {
  return `Go back to ${tag}`
}

/**
 * What the Server panel may show. An offer is hidden when the check is off,
 * when the selected binary is not the managed one, or when the pinned tag is
 * not newer. Going back stays available after an update even if the check is
 * then turned off, and is hidden when the person is on a binary they chose.
 */
export function llamaUpdateView(input: {
  enabled: boolean
  currentPath: string
  managed: { tag: string; path: string; backend: ManagedBuild['backend'] } | null
  offer: { tag: string; backend: ManagedBuild['backend'] } | null
  rollback: { tag: string; path: string } | null
}): LlamaUpdateView {
  const managed = input.managed
  const onManaged = managed !== null && input.currentPath === managed.path
  let offerTag: string | null = null
  if (onManaged && input.enabled && input.offer && input.offer.backend === managed.backend) {
    if (newerOfficialBuild(tagBuildNumber(managed.tag), tagBuildNumber(input.offer.tag)) !== null) {
      offerTag = input.offer.tag
    }
  }
  let rollbackTag: string | null = null
  if (
    onManaged &&
    input.rollback &&
    input.rollback.path !== managed.path &&
    input.rollback.tag !== managed.tag &&
    tagBuildNumber(input.rollback.tag) !== null
  ) {
    rollbackTag = input.rollback.tag
  }
  return { enabled: input.enabled, offerTag, rollbackTag }
}
