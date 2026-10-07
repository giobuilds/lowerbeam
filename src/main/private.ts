import { chmod, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The app's own data is its user's alone.
 *
 * Settings hold the Local API key; conversations, journals, command outputs
 * and workspace copies hold what the user and the model read and wrote. On a
 * machine with other accounts, a file written with the default 0644 under a
 * 0755 folder is theirs to read. So every file the app writes into its data
 * is created 0600 and every folder 0700, and what an older version left
 * behind is tightened on start.
 */
export const PRIVATE_FILE = 0o600
export const PRIVATE_DIR = 0o700

/**
 * Take group and other access off everything under `root`, and `root`
 * itself. Owner bits are kept as they are, so a script that was executable
 * stays so. Links are not followed: what one points at is not the app's.
 * Returns how many entries were changed.
 */
export async function tightenTree(root: string): Promise<number> {
  let changed = 0
  const visit = async (path: string): Promise<void> => {
    let info
    try {
      info = await lstat(path)
    } catch {
      return
    }
    if (info.isSymbolicLink()) return
    if ((info.mode & 0o077) !== 0) {
      try {
        await chmod(path, info.mode & 0o7700 & ~0o077)
        changed += 1
      } catch {
        // Not ours to change, or gone; the next start tries again.
      }
    }
    if (!info.isDirectory()) return
    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      return
    }
    for (const name of names) await visit(join(path, name))
  }
  await visit(root)
  return changed
}
