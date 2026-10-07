import { cp, readdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/**
 * Carry a previous installation's data across a rename.
 *
 * Electron derives the user-data directory from the application name, so
 * renaming the app silently points it at an empty folder: conversations,
 * per-model profiles, download history and the machine calibration all appear
 * to have vanished. They have not — the app is simply looking somewhere new.
 *
 * The copy happens once, only when the new location has nothing in it, and the
 * old directory is left untouched so the previous version keeps working and the
 * migration can be repeated if something goes wrong.
 */

const LEGACY_DIRECTORY_NAMES = ['llama-gui']
/** Written once a migration has happened, or the app's data was deleted on purpose: either way, never migrate again. */
export const MIGRATION_MARKER = '.migrated-from'
const MARKER = MIGRATION_MARKER

/**
 * The files this app owns. Emptiness is not a usable test: Electron creates the
 * user-data directory and fills it with caches, preferences and cookies before
 * any of this runs, so a brand-new profile is never empty — it just has none of
 * our data in it.
 */
const OUR_FILES = ['settings.json', 'profiles.json', 'conversations']

export async function migrateLegacyUserData(userDataPath: string): Promise<string | null> {
  if ((await hasOurData(userDataPath)) || (await readdir(userDataPath).catch(() => [] as string[])).includes(MARKER)) return null

  const parent = dirname(userDataPath)
  for (const legacyName of LEGACY_DIRECTORY_NAMES) {
    const legacy = join(parent, legacyName)
    if (legacy === userDataPath) continue
    if (!(await hasOurData(legacy))) continue

    try {
      // The old directory is copied, not moved: an interrupted migration then
      // costs nothing, and the previous version still runs.
      // Only our own files are carried across. Copying the whole directory
      // would drag Electron's caches, cookies and GPU state into a profile that
      // has already built its own.
      for (const name of OUR_FILES) {
        await cp(join(legacy, name), join(userDataPath, name), {
          recursive: true,
          force: false,
          errorOnExist: false
        }).catch(() => {})
      }
      await writeFile(join(userDataPath, MARKER), legacy, 'utf8')
      return legacy
    } catch {
      // A failed migration must not stop the app starting; it just begins empty.
      return null
    }
  }
  return null
}

/** Does this directory hold data belonging to this app, as opposed to Electron's? */
async function hasOurData(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return OUR_FILES.some((name) => entries.includes(name))
  } catch {
    return false
  }
}
