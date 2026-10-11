import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { ManagedBuild } from '@shared/types.js'
import type { SettingsStore } from './settings.js'

/**
 * Which binary to probe at startup.
 * An explicit choice wins, then `LLAMA_SERVER_PATH`, then the official build
 * this app downloaded. An empty string is treated as unset.
 */
export function binaryToProbe(
  settings: { binaryPath?: string; managedBuild?: { path: string } | null },
  envPath?: string
): string | undefined {
  const chosen = settings.binaryPath?.trim() || envPath?.trim() || settings.managedBuild?.path?.trim()
  return chosen || undefined
}

/** Remember a probed official build and select it. */
export async function rememberManagedBuild(
  settings: SettingsStore,
  installed: { tag: string; backend: ManagedBuild['backend']; llamaPath: string; digest: string },
  installedAt = new Date().toISOString()
): Promise<ManagedBuild> {
  const managed: ManagedBuild = {
    tag: installed.tag,
    backend: installed.backend,
    path: installed.llamaPath,
    digest: installed.digest,
    installedAt
  }
  await settings.patch({ binaryPath: installed.llamaPath, managedBuild: managed })
  return managed
}

/**
 * Drop the managed-build setting. When it was the selected binary, the
 * selection is cleared too. Returns whether the selection was cleared.
 */
export async function forgetManagedBuild(settings: SettingsStore): Promise<boolean> {
  const managed = settings.current.managedBuild
  if (!managed) return false
  const clearPath = settings.current.binaryPath === managed.path
  const next: { managedBuild: null; binaryPath?: undefined } = { managedBuild: null }
  if (clearPath) next.binaryPath = undefined
  await settings.patch(next)
  return clearPath
}

/** A server running from this build must be stopped before the folder goes. */
export function removalBlocked(runningPath: string | null | undefined, managedPath: string): string | null {
  if (!runningPath) return null
  const rel = relative(dirname(managedPath), runningPath)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return 'Stop the running server before removing this build.'
  }
  return null
}

/**
 * The managed build's directory, after checking it is a real directory
 * named `bNNNN-vulkan` or `bNNNN-cpu` directly inside `root`.
 * A symlink is refused, and so is anything that resolves outside `root`.
 */
export async function managedDirectory(root: string, llamaPath: string): Promise<string> {
  const dir = dirname(llamaPath)
  const name = basename(dir)
  if (basename(llamaPath) !== 'llama' || !/^b\d+-(vulkan|cpu)$/.test(name)) {
    throw new Error('Refused to use that folder.')
  }
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refused to use that folder.')
  const rootReal = await realpath(root)
  const dirReal = await realpath(dir)
  if (relative(rootReal, dirReal) !== name) throw new Error('Refused to use that folder.')
  return dir
}

/** Remove one managed build directory. Does not follow a symlink. */
export async function deleteManagedDir(root: string, llamaPath: string): Promise<void> {
  await rm(await managedDirectory(root, llamaPath), { recursive: true })
}

/** `<userData>/llama.cpp`. */
export function llamaRoot(userData: string): string {
  return join(userData, 'llama.cpp')
}
