import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ApplyResult, ChangeSet, FileChange } from '@shared/coding.js'
import { secretReason } from '../../agent/grant.js'

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
 * uncommitted edits included.
 *
 * A symlink in the copy is never followed here. A command in the box can make
 * one point at a host file the box cannot see; reading it on the run's behalf
 * would show that file in Changes. A link is recorded by its text, compared by
 * its text, shown by its text, and never applied. Nothing here reads git history; git is only
 * asked which files exist, so `.gitignore` is honoured, and a folder that is
 * not a repository is walked instead.
 */

/** Files that are never part of a workspace: nothing a task needs, plenty it must not touch. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', '.build', '.lowerbeam-deps'])

export interface Manifest {
  projectRoot: string
  /** Relative path → sha256 of content at copy time, or `link:` and the link's text in the copy. */
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
      files[rel] = (await lstat(to)).isSymbolicLink() ? LINK + (await readlink(to)) : await hashFile(from)
    }
    const manifest: Manifest = { projectRoot, files, createdAt: Date.now() }
    await writeFile(join(dir, '.lowerbeam-baseline.json'), JSON.stringify(manifest))
    return new Workspace(dir, manifest)
  }

  static async open(dir: string): Promise<Workspace> {
    const manifest = JSON.parse(await readFile(join(dir, '.lowerbeam-baseline.json'), 'utf8')) as Manifest
    return new Workspace(dir, manifest)
  }

  /**
   * What the run changed: every file that differs from the baseline, with a
   * diff. The baseline is walked first, file by file where each was copied
   * to — not re-listed, since git lists a project (tracked files under a
   * fixture's node_modules, symlinks) differently from the walk that lists
   * a copy, and the difference is not a change the run made. Then the copy
   * is walked for what the baseline does not name. A link the run made or
   * changed is a `symlink` entry showing only where it points.
   */
  async changes(): Promise<ChangeSet> {
    const files: FileChange[] = []
    for (const rel of Object.keys(this.manifest.files).sort()) {
      const before = this.manifest.files[rel]!
      const path = join(this.root, rel)
      const st = await lstatOrNull(path)
      if (st === null) {
        files.push({ path: rel, kind: 'deleted', diff: '' })
      } else if (st.isSymbolicLink()) {
        const text = await readlink(path)
        if (before !== LINK + text) files.push({ path: rel, kind: 'symlink', diff: linkDiff(text) })
      } else if (st.isFile()) {
        if ((await hashFile(path)) !== before) files.push({ path: rel, kind: 'modified', diff: await this.diffFor(rel, rel) })
      }
    }
    const { files: made, links } = await walkCopy(this.root, this.root)
    for (const rel of made.sort()) {
      if (rel in this.manifest.files || rel.startsWith('.lowerbeam-')) continue
      files.push({ path: rel, kind: 'created', diff: await this.diffFor(rel, null) })
    }
    for (const rel of links.sort()) {
      if (rel in this.manifest.files) continue
      files.push({ path: rel, kind: 'symlink', diff: linkDiff(await readlink(join(this.root, rel))) })
    }
    return { files, baselineAt: this.manifest.createdAt }
  }

  /**
   * Put the run's changes into the project — each file only if the project
   * still holds what the baseline held. A file the user edited since is a
   * conflict, reported and left alone; nothing is merged and nothing is
   * guessed. What was overwritten is kept beside the workspace so undo has
   * something to restore. A path that goes through a symlink in the project
   * is a conflict too: the copy has no such link, so the run wrote to a
   * plain folder, and following the link would put the file wherever it
   * points.
   */
  async apply(): Promise<ApplyResult> {
    const changes = await this.changes()
    const project = await realpath(this.manifest.projectRoot)
    const undoDir = join(this.root, '.lowerbeam-undo')
    await mkdir(undoDir, { recursive: true })
    const applied: string[] = []
    const conflicts: Array<{ path: string; reason: string }> = []
    const originals: Record<string, string | null> = {}

    for (const change of changes.files) {
      const target = join(project, change.path)
      if (change.kind === 'symlink') {
        conflicts.push({ path: change.path, reason: 'the run left a symlink here, and a link is never applied' })
        continue
      }
      const unsafe = await unsafeTarget(project, change.path)
      if (unsafe) {
        conflicts.push({ path: change.path, reason: unsafe })
        continue
      }
      const source = join(this.root, change.path)
      if (change.kind !== 'deleted' && !(await lstatOrNull(source))?.isFile()) {
        conflicts.push({ path: change.path, reason: 'the run’s copy no longer holds a plain file here' })
        continue
      }
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
        // Checked again now the folders exist, in case one appeared as a
        // link in between. The run cannot do that: it writes only the copy.
        const raced = await unsafeTarget(project, change.path)
        if (raced) {
          conflicts.push({ path: change.path, reason: raced })
          continue
        }
        await cp(source, target)
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
    const project = await realpath(this.manifest.projectRoot)
    const applied: string[] = []
    const conflicts: Array<{ path: string; reason: string }> = []
    for (const [path, entry] of Object.entries(record.entries)) {
      const target = join(project, path)
      const unsafe = await unsafeTarget(project, path)
      if (unsafe) {
        conflicts.push({ path, reason: unsafe })
        continue
      }
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
    if (after === LINKED || before === LINKED) return '(a symlink: not read)'
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
 * Credentials are never among them, tracked or not: what the grant would
 * refuse to read is not copied for a run to find.
 */
export async function listProjectFiles(root: string): Promise<string[]> {
  return (await listAll(root)).filter((rel) => secretReason(join(root, rel), rel) === null)
}

async function listAll(root: string): Promise<string[]> {
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

/**
 * A copy's plain files and its links, listed apart. The walk never descends
 * through a link, so a link to a folder is one entry, not the folder.
 */
async function walkCopy(root: string, dir: string): Promise<{ files: string[]; links: string[] }> {
  const out = { files: [] as string[], links: [] as string[] }
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const abs = join(dir, e.name)
    const rel = relative(root, abs).split(sep).join('/')
    if (e.isDirectory()) {
      const inner = await walkCopy(root, abs)
      out.files.push(...inner.files)
      out.links.push(...inner.links)
    } else if (e.isFile()) out.files.push(rel)
    else if (e.isSymbolicLink()) out.links.push(rel)
  }
  return out
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

/**
 * Why `rel` must not be written under `root`, or null when it may. Every part
 * of the path that exists must be a real folder or file, not a link — one
 * pointing back inside the project is refused as well, since the change was
 * made at a different path from the one it would land on. What does not exist
 * yet is created by apply as plain folders. `root` is already resolved.
 */
async function unsafeTarget(root: string, rel: string): Promise<string | null> {
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'the path does not stay inside the project'
  let at = root
  for (const part of parts) {
    at = join(at, part)
    try {
      if ((await lstat(at)).isSymbolicLink()) {
        return `${relative(root, at).split(sep).join('/')} is a symlink in the project, and the change would be written wherever it points`
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return `${relative(root, at).split(sep).join('/')} cannot be checked in the project (${(err as NodeJS.ErrnoException).code ?? 'error'})`
    }
  }
  return null
}

/** The manifest's mark for a link, recorded by its text rather than by what it points at. */
const LINK = 'link:'

function linkDiff(text: string): string {
  return `symlink → ${text}`
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return await hashFile(path)
  } catch {
    return null
  }
}

/** What readTextOrNull returns for a link: it is not read. */
const LINKED = Symbol('linked')

async function readTextOrNull(path: string): Promise<string | null | typeof LINKED> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return LINKED
    const buf = await readFile(path)
    return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8')
  } catch {
    return null
  }
}
