import { lstat, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataUsage } from '@shared/types.js'
import { MIGRATION_MARKER } from './migrate.js'
import { PRIVATE_FILE } from './private.js'

/**
 * What the app keeps on disk, how much of it, and how to get rid of it.
 *
 * Conversations, coding runs and the workspace copies runs make all stay
 * until they are deleted, and a workspace copy is a copy of the project's
 * source. So the sizes are shown, each kind can be deleted in one step, and
 * the whole of the app's data can go at once. Models are not app data: they
 * are the user's files, wherever they were downloaded to, and are never
 * touched here.
 */

/** Bytes under a path, links counted as themselves and never followed. */
export async function sizeOf(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  let names: string[] = []
  try {
    names = await readdir(path)
  } catch {
    return total
  }
  for (const name of names) total += await sizeOf(join(path, name))
  return total
}

export interface DataPaths {
  userData: string
  conversations: string
  coding: string
}

/** How much each kind of data takes, and how many of it there are. */
export async function dataUsage(paths: DataPaths, retentionDays: number | null): Promise<Omit<DataUsage, 'slots'>> {
  const names = async (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[])
  const conversationFiles = (await names(paths.conversations)).filter((n) => n.endsWith('.json'))
  const codingFiles = await names(paths.coding)
  const runFiles = codingFiles.filter((n) => RUN_FILE.test(n))
  const workspaces = await names(join(paths.coding, 'workspaces'))
  let runBytes = 0
  for (const n of runFiles) runBytes += await sizeOf(join(paths.coding, n))
  runBytes += await sizeOf(join(paths.coding, 'measure'))
  return {
    path: paths.userData,
    conversations: { count: conversationFiles.length, bytes: await sizeOf(paths.conversations) },
    runs: { count: runFiles.filter((n) => n.endsWith('.jsonl') && !n.endsWith('.words.jsonl')).length, bytes: runBytes },
    workspaces: { count: workspaces.length, bytes: await sizeOf(join(paths.coding, 'workspaces')) },
    total: await sizeOf(paths.userData),
    retentionDays
  }
}

/** A run's own files beside the journal: the journal, the model's words, command outputs, a baseline rerun. */
export const RUN_FILE = /^[a-f0-9-]{36}\.(jsonl|words\.jsonl|cmd-\d+\.txt|baseline\.json)$/i

/**
 * The app's own files, removed: everything it wrote into its data folder,
 * Electron's storage aside, which the caller clears through the session.
 * The migration marker is left (or written), so a deliberately emptied
 * profile is not refilled from an older version's folder on the next start.
 */
export async function deleteOwnData(userData: string): Promise<void> {
  for (const name of OWN_DATA) await rm(join(userData, name), { recursive: true, force: true })
  for (const name of await readdir(userData).catch(() => [] as string[])) {
    // Backups the settings store keeps of a file it could not read.
    if (/^settings\.json\..*\.bak$/.test(name)) await rm(join(userData, name), { force: true })
  }
  await writeFile(join(userData, MIGRATION_MARKER), `deleted ${new Date().toISOString()}\n`, { mode: PRIVATE_FILE })
}

const OWN_DATA = ['coding', 'conversations', 'slots', 'settings.json', 'profiles.json', 'server.json', 'router-presets.ini', 'router-cache']
