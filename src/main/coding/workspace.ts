import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ApplyResult, ChangeSet, FileChange } from '@shared/coding.js'

const run = promisify(execFile)

/**
 * An isolated copy of the project for one run to write in.
 *
 * The agent never writes to the project itself. It writes to this copy, the
 * copy is compared with the baseline it was taken from, and the person
 * decides what goes back. The baseline is a manifest of content hashes taken
 * at copy time, which is what makes three things checkable rather than
 * assumed: what the run changed, whether the original moved underneath it
 * before apply, and whether an applied change is still what was applied
 * when undo is asked for.
 *
 * Dirty state is copied, not discarded: the baseline is what the user sees,
 * uncommitted edits included. Nothing here reads git history; git is only
 * asked which files exist, so `.gitignore` is honoured, and a folder that is
 * not a repository is walked instead.
 */

/** Files that are never part of a workspace: nothing a task needs, plenty it must not touch. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', '.build', '.lowerbeam-deps'])

export interface Manifest {
  projectRoot: string
  /** Relative path → sha256 of content at copy time. */
  files: Record<string, string>
  createdAt: number
}

export class Workspace {
  private constructor(
    readonly root: string,
    readonly manifest: Manifest
  ) {}

  /** Copy the project into `dir` and record what was copied. */
  static async create(projectRoot: string, dir: string): Promise<Workspace> {
    await mkdir(dir, { recursive: true })
    const files: Record<string, string> = {}
    for (const rel of await listProjectFiles(projectRoot)) {
      const from = join(projectRoot, rel)
      const to = join(dir, rel)
      await mkdir(dirname(to), { recursive: true })
      await cp(from, to, { dereference: false })
      files[rel] = await hashFile(from)
    }
    const manifest: Manifest = { projectRoot, files, createdAt: Date.now() }
    await writeFile(join(dir, '.lowerbeam-baseline.json'), JSON.stringify(manifest))
    return new Workspace(dir, manifest)
  }

  static async open(dir: string): Promise<Workspace> {
    const manifest = JSON.parse(await readFile(join(dir, '.lowerbeam-baseline.json'), 'utf8')) as Manifest
    return new Workspace(dir, manifest)
  }

  /** What the run changed: every file that differs from the baseline, with a diff. */
  async changes(): Promise<ChangeSet> {
    const files: FileChange[] = []
    const now = new Set(await listProjectFiles(this.root))
    now.delete('.lowerbeam-baseline.json')

    for (const rel of [...now].sort()) {
      const before = this.manifest.files[rel]
      const afterHash = await hashFile(join(this.root, rel))
      if (before === undefined) {
        files.push({ path: rel, kind: 'created', diff: await this.diffFor(rel, null) })
      } else if (before !== afterHash) {
        files.push({ path: rel, kind: 'modified', diff: await this.diffFor(rel, rel) })
      }
    }
    for (const rel of Object.keys(this.manifest.files).sort()) {
      if (!now.has(rel)) files.push({ path: rel, kind: 'deleted', diff: '' })
    }
    return { files, baselineAt: this.manifest.createdAt }
  }

  /**
   * Put the run's changes into the project — each file only if the project
   * still holds what the baseline held. A file the user edited since is a
   * conflict, reported and left alone; nothing is merged and nothing is
   * guessed. What was overwritten is kept beside the workspace so undo has
   * something to restore.
   */
  async apply(): Promise<ApplyResult> {
    const changes = await this.changes()
    const project = this.manifest.projectRoot
    const undoDir = join(this.root, '.lowerbeam-undo')
    await mkdir(undoDir, { recursive: true })
    const applied: string[] = []
    const conflicts: Array<{ path: string; reason: string }> = []
    const originals: Record<string, string | null> = {}

    for (const change of changes.files) {
      const target = join(project, change.path)
      const baseline = this.manifest.files[change.path]
      const current = await hashFileOrNull(target)

      if (change.kind === 'created' && current !== null) {
        conflicts.push({ path: change.path, reason: 'the project now has a file at this path that the run did not create' })
        continue
      }
      if (change.kind !== 'created' && current !== baseline) {
        conflicts.push({
          path: change.path,
          reason: current === null ? 'the file was removed from the project since the run began' : 'the file was edited in the project since the run began'
        })
        continue
      }

      originals[change.path] = current === null ? null : await readFile(target, 'utf8')
      if (change.kind === 'deleted') {
        await unlink(target)
      } else {
        await mkdir(dirname(target), { recursive: true })
        await cp(join(this.root, change.path), target)
      }
      applied.push(change.path)
    }

    // The undo record: what each applied path held before, keyed to what it holds now.
    const record: UndoRecord = { at: Date.now(), entries: {} }
    for (const path of applied) {
      const target = join(project, path)
      record.entries[path] = { before: originals[path] ?? null, appliedHash: await hashFileOrNull(target) }
    }
    await writeFile(join(undoDir, 'record.json'), JSON.stringify(record))
    return { applied, conflicts }
  }

  /**
   * Reverse an apply — for each file, only if the project still holds exactly
   * what was applied. A file edited since is left alone and reported.
   */
  async undo(): Promise<ApplyResult> {
    let record: UndoRecord
    try {
      record = JSON.parse(await readFile(join(this.root, '.lowerbeam-undo', 'record.json'), 'utf8')) as UndoRecord
    } catch {
      return { applied: [], conflicts: [] }
    }
    const project = this.manifest.projectRoot
    const applied: string[] = []
    const conflicts: Array<{ path: string; reason: string }> = []
    for (const [path, entry] of Object.entries(record.entries)) {
      const target = join(project, path)
      if ((await hashFileOrNull(target)) !== entry.appliedHash) {
        conflicts.push({ path, reason: 'the file was edited in the project after the change was applied' })
        continue
      }
      if (entry.before === null) await unlink(target)
      else await writeFile(target, entry.before)
      applied.push(path)
    }
    await rm(join(this.root, '.lowerbeam-undo'), { recursive: true, force: true })
    return { applied, conflicts }
  }

  async discard(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  private async diffFor(rel: string, baselineRel: string | null): Promise<string> {
    const after = await readTextOrNull(join(this.root, rel))
    const before = baselineRel ? await readTextOrNull(join(this.manifest.projectRoot, baselineRel)) : ''
    if (after === null || before === null) return '(binary)'
    return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', { context: 3 })
  }
}

interface UndoRecord {
  at: number
  entries: Record<string, { before: string | null; appliedHash: string | null }>
}

/**
 * The files a project consists of: what git tracks or would track when
 * there is a repository, otherwise a walk that skips the usual dead weight.
 */
export async function listProjectFiles(root: string): Promise<string[]> {
  try {
    await stat(join(root, '.git'))
    const { stdout } = await run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024
    })
    const files: string[] = []
    for (const rel of stdout.split('\0')) {
      if (!rel || rel.split('/')[0] && SKIP.has(rel.split('/')[0]!)) continue
      try {
        if ((await stat(join(root, rel))).isFile()) files.push(rel)
      } catch {
        /* listed but gone — a deleted tracked file */
      }
    }
    return files
  } catch {
    return walk(root, root)
  }
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(root, abs)))
    else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'))
  }
  return out
}

export async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return await hashFile(path)
  } catch {
    return null
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path)
    return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8')
  } catch {
    return null
  }
}
