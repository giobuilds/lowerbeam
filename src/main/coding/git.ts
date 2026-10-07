import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitState } from '@shared/coding.js'

const run = promisify(execFile)

/**
 * The project's git, for applying a run as a commit.
 *
 * Git is run on the project, never on a run's copy, and only for what a
 * person asked for: reading the branch and what is uncommitted, committing
 * exactly the files an apply wrote, and reverting that commit to undo it.
 * Hooks are never run. A run can change any file in the project it was
 * given, `.husky/pre-commit` included, and a commit made right after the
 * apply would run that file at once, outside the box, before anyone had
 * read it.
 */

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...NO_HOOKS, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  })
  return stdout
}

/** Whether the project is a repository, on which branch, and what is uncommitted. */
export async function gitState(root: string): Promise<GitState> {
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    let branch: string | null = (await git(root, ['branch', '--show-current'])).trim() || null
    let head: string | null = null
    try {
      head = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim()
    } catch {
      // A repository with no commit yet.
      branch = branch ?? null
    }
    const entries = porcelain(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']))
    return {
      repo: true,
      top,
      branch,
      head,
      changed: entries.filter((e) => e.code !== '??').length,
      untracked: entries.filter((e) => e.code === '??').length
    }
  } catch {
    return { repo: false, top: null, branch: null, head: null, changed: 0, untracked: 0 }
  }
}

/** Which of `paths` differ from HEAD in the project: edits nobody has committed. */
export async function uncommitted(root: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const entries = porcelain(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]))
  // An untracked file the run is about to create is not the person's edit;
  // one it is about to overwrite is.
  return entries.map((e) => e.path)
}

/** Whether `name` is a branch name git would accept and no branch has it yet. */
export async function checkNewBranch(root: string, name: string): Promise<string | null> {
  try {
    await git(root, ['check-ref-format', '--branch', name])
  } catch {
    return `"${name}" is not a valid branch name.`
  }
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return `A branch named "${name}" already exists.`
  } catch {
    return null
  }
}

/** Start a new branch at HEAD and switch to it; the working tree comes along unchanged. */
export async function switchToNewBranch(root: string, name: string): Promise<void> {
  await git(root, ['switch', '-c', name])
}

/**
 * Commit exactly `paths` — created, changed or removed — and nothing else:
 * whatever else the person had staged stays staged and out of the commit.
 */
export async function commitPaths(root: string, paths: string[], message: string): Promise<{ sha: string; branch: string | null }> {
  await git(root, ['add', '--all', '--', ...paths])
  await git(root, ['commit', '--only', '-m', message, '--', ...paths])
  const sha = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const branch = (await git(root, ['branch', '--show-current'])).trim() || null
  return { sha, branch }
}

/**
 * Whether a commit an apply made can be undone from where the project is now:
 * it has to be on the current branch. Null when it can, the reason when not.
 */
export async function checkRevertable(root: string, sha: string): Promise<string | null> {
  try {
    await git(root, ['merge-base', '--is-ancestor', sha, 'HEAD'])
    return null
  } catch {
    const branch = (await git(root, ['branch', '--show-current']).catch(() => '')).trim()
    return `the commit ${sha.slice(0, 7)} is not on the branch the project is on now (${branch || 'a detached HEAD'}); switch back to undo it`
  }
}

/** The files a commit touched, relative to `root`, and its subject line. */
export async function commitInfo(root: string, sha: string): Promise<{ paths: string[]; subject: string }> {
  const paths = (await git(root, ['show', '--name-only', '--format=', '--relative', '-z', sha])).split('\0').filter(Boolean)
  const subject = (await git(root, ['log', '-1', '--format=%s', sha])).trim()
  return { paths, subject }
}

/**
 * The commit that undoes others, once their files have been restored: the
 * restored files committed alone, as `git revert` would leave them. Not
 * `git revert` itself, which refuses whenever anything is staged, and would
 * be refusing over work that has nothing to do with the run.
 */
export function revertMessage(reverted: Array<{ sha: string; subject: string }>): string {
  if (reverted.length === 1) return `Revert "${reverted[0]!.subject}"\n\nThis reverts commit ${reverted[0]!.sha}.`
  return `Revert ${reverted.length} commits applied by Lowerbeam\n\n${reverted.map((r) => `This reverts commit ${r.sha} ("${r.subject}").`).join('\n')}`
}

function porcelain(out: string): Array<{ code: string; path: string }> {
  const parts = out.split('\0')
  const entries: Array<{ code: string; path: string }> = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.length < 4) continue
    const code = p.slice(0, 2)
    entries.push({ code, path: p.slice(3) })
    // A rename or copy is followed by its source path.
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return entries
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  return ((e.stderr || e.message || String(err)).trim().split('\n')[0] ?? '').slice(0, 200)
}
