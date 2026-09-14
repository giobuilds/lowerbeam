import { spawn } from 'node:child_process'
import { DEFAULT_TERMS, type GrantTerms } from '@shared/coding.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const run = promisify(execFile)

/**
 * Running a command from a coding run, inside a box.
 *
 * The box is bubblewrap: a mount namespace with the system toolchain read
 * only, the workspace copy read-write, the project's dependency tree read
 * only at the workspace path, a private /tmp, and no network at all — the
 * model server on loopback is unreachable from inside. A pid namespace so
 * the tree is the whole tree, and --die-with-parent so nothing outlives the
 * run. Probed before this existed: the home directory is ENOENT from inside,
 * a write to /usr/bin is EROFS, a connection to 127.0.0.1 is refused, and
 * killing the box kills every sleep it started.
 *
 * What it is not: a VM. Kernel and hardware are shared. It is the second
 * layer, for a process that bypasses the tool API; the grant is the first.
 */

export interface SandboxProbe {
  ok: boolean
  bubblewrap: string | null
  userNamespaces: boolean
  landlock: boolean
  /** Why execution is unavailable, in words, when it is. */
  reason: string | null
}

/** Whether this machine can run anything in a box. Cached: it does not change while the app runs. */
export async function probeSandbox(): Promise<SandboxProbe> {
  if (cachedProbe) return cachedProbe
  let bubblewrap: string | null = null
  try {
    bubblewrap = (await run('bwrap', ['--version'])).stdout.trim()
  } catch {
    /* absent */
  }
  let userNamespaces = false
  try {
    const { readFile } = await import('node:fs/promises')
    userNamespaces = Number((await readFile('/proc/sys/user/max_user_namespaces', 'utf8')).trim()) > 0
  } catch {
    /* not linux, or not readable */
  }
  let landlock = false
  try {
    const { readFile } = await import('node:fs/promises')
    landlock = (await readFile('/sys/kernel/security/lsm', 'utf8')).split(',').map((s) => s.trim()).includes('landlock')
  } catch {
    /* absent */
  }
  const reason = !bubblewrap
    ? 'bubblewrap (bwrap) is not installed, so commands cannot be contained.'
    : !userNamespaces
      ? 'unprivileged user namespaces are disabled, so bubblewrap cannot run without root.'
      : null
  cachedProbe = { ok: reason === null, bubblewrap, userNamespaces, landlock, reason }
  return cachedProbe
}
let cachedProbe: SandboxProbe | null = null

export interface SandboxCommand {
  /** The workspace copy: the only place the command may write. */
  workspace: string
  /** The project the copy was taken from; its dependency tree is lent, read only. */
  projectRoot: string
  /** Run with `sh -c`; the model gives a line, not an argv. */
  command: string
  timeoutMs: number
  /** Kept per stream; anything past it is dropped, and the drop is reported. */
  maxOutputBytes: number
  signal?: AbortSignal
  /** What the box may reach beyond the copy and the lent toolchain. Default: nothing. */
  terms?: GrantTerms
}

export interface SandboxResult {
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  ms: number
}

export async function runInSandbox(cmd: SandboxCommand): Promise<SandboxResult> {
  const probe = await probeSandbox()
  if (!probe.ok) throw new Error(probe.reason ?? 'no sandbox')

  const args = await bwrapArgs(cmd.workspace, cmd.projectRoot, cmd.terms)
  const started = Date.now()
  // pipefail, where the shell has it: `node tests/run.mjs x | head -50` is
  // how a model keeps output short, and without it the exit code is head's —
  // a failing suite reported as exit 0, and recorded that way.
  const child = spawn('bwrap', [...args, '--', 'sh', '-c', `set -o pipefail 2>/dev/null; ${cmd.command}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own group, so a timeout or a stop reaches the whole tree from
    // outside the box as well as inside it.
    detached: true
  })

  const out = collect(child.stdout, cmd.maxOutputBytes)
  const err = collect(child.stderr, cmd.maxOutputBytes)
  let timedOut = false
  let cancelled = false
  const killTree = (): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    killTree()
  }, cmd.timeoutMs)
  const onAbort = (): void => {
    cancelled = true
    killTree()
  }
  cmd.signal?.addEventListener('abort', onAbort, { once: true })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null))
    child.on('exit', (code) => resolve(code))
  })
  clearTimeout(timer)
  cmd.signal?.removeEventListener('abort', onAbort)

  return {
    exitCode,
    stdout: out.text(),
    stderr: err.text(),
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    timedOut,
    cancelled,
    ms: Date.now() - started
  }
}

/**
 * The box's shape. Bound in: the system (/usr, /lib64) read only, the
 * toolchain the current process runs on (so a node installed under the home
 * directory is there without the home directory being there), the workspace
 * read-write, the project's node_modules read only at the workspace path.
 * Nothing else exists inside — unless the grant's terms say so: an extra
 * root is bound read only, the network is shared back in, and with install
 * the project's node_modules is not lent at all, so the copy's own, which
 * starts empty, is what an install writes. The project's is never written.
 */
export async function bwrapArgs(workspace: string, projectRoot: string, terms: GrantTerms = DEFAULT_TERMS): Promise<string[]> {
  const args = [
    '--ro-bind', '/usr', '/usr',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-all',
    ...(terms.network ? ['--share-net'] : []),
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', process.env['LANG'] ?? 'C.UTF-8',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'CI', '1'
  ]
  for (const dir of ['/lib64', '/lib', '/bin', '/sbin', '/etc/alternatives', '/etc/ld.so.cache', '/etc/resolv.conf', '/etc/ssl', '/etc/pki']) {
    if (await exists(dir)) args.push('--ro-bind', dir, dir)
  }

  // The toolchain: whatever node this process would run, by its install root.
  const path: string[] = ['/usr/local/bin', '/usr/bin', '/bin']
  const node = await findNode()
  if (node) {
    const root = dirname(dirname(node)) // …/bin/node → …
    args.push('--ro-bind', root, root)
    path.unshift(dirname(node))
  }
  args.push('--setenv', 'PATH', path.join(':'))

  args.push('--bind', workspace, workspace)
  const deps = join(projectRoot, 'node_modules')
  if (!terms.install && (await exists(deps))) args.push('--ro-bind', deps, join(workspace, 'node_modules'))
  for (const dir of terms.alsoRead) if (await exists(dir)) args.push('--ro-bind', dir, dir)
  args.push('--chdir', workspace)
  return args
}

/** The node the user's shell would run, not necessarily the one Electron embeds. */
async function findNode(): Promise<string | null> {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const candidate = join(dir, 'node')
    if (await exists(candidate)) {
      try {
        return await realpath(candidate)
      } catch {
        return candidate
      }
    }
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Keep the first `limit` bytes of a stream and note whether more arrived. */
function collect(stream: NodeJS.ReadableStream | null, limit: number): { text: () => string; truncated: boolean } {
  const chunks: Buffer[] = []
  let size = 0
  const state = { truncated: false, text: () => Buffer.concat(chunks).toString('utf8') }
  stream?.on('data', (chunk: Buffer) => {
    if (size >= limit) {
      state.truncated = true
      return
    }
    const keep = chunk.subarray(0, Math.max(0, limit - size))
    chunks.push(keep)
    size += keep.length
    if (keep.length < chunk.length) state.truncated = true
  })
  return state
}
