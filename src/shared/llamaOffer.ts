import type { ManagedBuild } from './types.js'

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
