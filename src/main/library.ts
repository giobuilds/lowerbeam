/**
 * The models already on disk, and how one of them is removed.
 *
 * A scan lists every GGUF. This adds the two facts that decide whether it
 * is worth the space: when it was last launched, and whether the same file
 * name and size already sit in another folder. Deleting unlinks the model
 * and the vision projector paired with it. A symlink's target is removed
 * only when nothing else in the library still points at it, and only when
 * that target sits inside a folder the app was already willing to scan.
 */
import { lstat, realpath, stat, unlink } from 'node:fs/promises'
import { sep } from 'node:path'

export interface LibraryFile {
  path: string
  fileName: string
  fileSize: number
}

/** Same file name and size: the copies a person can confuse across folders. */
export function duplicateCounts(files: LibraryFile[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const key = `${file.fileName}:${file.fileSize}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function copyCount(file: LibraryFile, counts: Map<string, number>): number {
  return counts.get(`${file.fileName}:${file.fileSize}`) ?? 1
}

function insideRoot(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    const prefix = root.endsWith(sep) ? root : root + sep
    return resolved === root || resolved.startsWith(prefix)
  })
}

/**
 * Unlink one library path.
 *
 * Returns the bytes freed. A symlink whose target is still used, or whose
 * target lies outside the scanned folders, frees nothing of the target:
 * only the link the library was showing goes away.
 */
export async function removeModelFile(
  target: string,
  libraryPaths: string[],
  roots: string[]
): Promise<number> {
  if (!libraryPaths.includes(target)) {
    throw new Error('That file is not in the model library.')
  }
  return unlinkKnown(target, libraryPaths, roots)
}

export interface RemovableModel {
  path: string
  projectorPath?: string
}

/**
 * Remove a model and the vision projector paired with it.
 *
 * The projector stays when another model in the library is still paired with
 * that same file. A projector that is already gone does not undo the model
 * delete.
 */
export async function removeModelAndProjector(
  modelPath: string,
  models: RemovableModel[],
  roots: string[]
): Promise<number> {
  const model = models.find((entry) => entry.path === modelPath)
  if (!model) throw new Error('That file is not in the model library.')
  const modelPaths = models.map((entry) => entry.path)
  let freed = await unlinkKnown(modelPath, modelPaths, roots)
  const projector = model.projectorPath
  if (!projector) return freed
  const stillPaired = models.some((entry) => entry.path !== modelPath && entry.projectorPath === projector)
  if (stillPaired) return freed
  const otherProjectors = models
    .filter((entry) => entry.path !== modelPath && entry.projectorPath)
    .map((entry) => entry.projectorPath!)
  try {
    freed += await unlinkKnown(projector, otherProjectors, roots)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return freed
}

/** Unlink `target`. `holders` are other paths that may still name the same bytes. */
async function unlinkKnown(target: string, holders: string[], roots: string[]): Promise<number> {
  const followed = await stat(target)
  const link = await lstat(target)
  const resolved = await realpath(target)
  await unlink(target)
  if (!link.isSymbolicLink()) return followed.size

  for (const other of holders) {
    if (other === target) continue
    try {
      if ((await realpath(other)) === resolved) return 0
    } catch {
      // A path that vanished between the scan and the delete is not a copy.
    }
  }
  if (!insideRoot(resolved, roots)) return 0
  await unlink(resolved)
  return followed.size
}
