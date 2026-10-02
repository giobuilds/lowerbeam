import { spawn } from 'node:child_process'
import { DEFAULT_TERMS, type GrantTerms } from '@shared/coding.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  /** How Node is lent to the box, in words: from its install root, as the binary alone, or not at all. */
  toolchain: string
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
  const node = await findNode()
  const toolchain = node
    ? (await lendNode(node, await realHome())).note
    : 'No node was found on PATH, so commands run with the system’s tools only.'
  cachedProbe = { ok: reason === null, bubblewrap, userNamespaces, landlock, reason, toolchain }
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
 * the project's node_modules becomes the read-only lower layer of an
 * overlay whose writes land in the copy, so an install adds to what the
 * project has and the project's tree is never written. Where the kernel
 * will not mount an overlay unprivileged, the project's tree is not lent
 * and the copy's own, which starts empty, is what an install writes.
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

  // The toolchain: whatever node this process would run.
  const path: string[] = ['/usr/local/bin', '/usr/bin', '/bin']
  const node = await findNode()
  if (node) {
    const loan = await lendNode(node, await realHome())
    args.push(...loan.args)
    path.unshift(loan.bin)
  }
  args.push('--setenv', 'PATH', path.join(':'))

  args.push('--bind', workspace, workspace)
  const deps = join(projectRoot, 'node_modules')
  if (await exists(deps)) {
    if (!terms.install) args.push('--ro-bind', deps, join(workspace, 'node_modules'))
    else if (await overlaySupported()) {
      // Writes go beside the copy's files, not among them, so a change
      // listing never walks an installed tree.
      const upper = join(workspace, DEPS_DIR, 'upper')
      const work = join(workspace, DEPS_DIR, 'work')
      await mkdir(upper, { recursive: true })
      await mkdir(work, { recursive: true })
      args.push('--overlay-src', deps, '--overlay', upper, work, join(workspace, 'node_modules'))
    }
  }
  for (const dir of terms.alsoRead) if (await exists(dir)) args.push('--ro-bind', dir, dir)
  args.push('--chdir', workspace)
  return args
}

/** Where an install's writes are kept, beside the copy's own files. Never a change. */
export const DEPS_DIR = '.lowerbeam-deps'

/**
 * Whether this kernel mounts an overlay for an unprivileged user inside
 * bubblewrap — Linux 5.11 and later do, and bubblewrap has had the option
 * since 0.10. Tried once, on a throwaway directory, and remembered.
 */
let overlayProbe: Promise<boolean> | null = null
export function overlaySupported(): Promise<boolean> {
  overlayProbe ??= (async () => {
    const base = await mkdtemp(join(tmpdir(), 'lowerbeam-overlay-'))
    try {
      const lower = join(base, 'lower')
      for (const d of ['lower', 'upper', 'work', 'dest']) await mkdir(join(base, d))
      await writeFile(join(lower, 'probe'), '')
      const args = ['--ro-bind', '/usr', '/usr', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent']
      for (const dir of ['/lib64', '/lib', '/bin']) if (await exists(dir)) args.push('--ro-bind', dir, dir)
      args.push('--overlay-src', lower, '--overlay', join(base, 'upper'), join(base, 'work'), join(base, 'dest'))
      await run('bwrap', [...args, '--', 'sh', '-c', `test -f ${join(base, 'dest', 'probe')} && touch ${join(base, 'dest', 'written')}`], { timeout: 10_000 })
      return await exists(join(base, 'upper', 'written'))
    } catch {
      return false
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => undefined)
    }
  })()
  return overlayProbe
}

export interface NodeLoan {
  /** What makes node visible in the box: binds, and links for npm and npx. */
  args: string[]
  /** The folder to put first on PATH inside the box. */
  bin: string
  /** How it was lent, in words, for the interface. */
  note: string
}

/**
 * How to make `node` (a resolved path) visible in the box without the home
 * folder. Its install root — `…/bin/node` → `…` — is bound whole when that
 * is an install of its own: nvm, fnm, volta, /usr/local, /opt. When the root
 * is the home folder, an ancestor of it, or a folder directly in it — node in
 * `~/bin` or `~/.local/bin` — binding it would lend the home folder or
 * `~/.local`, keyrings and all. Then the binary is lent alone, with npm and
 * npx where they are links into the root's `lib/node_modules`, as npm's own
 * install makes them.
 */
export async function lendNode(node: string, home: string): Promise<NodeLoan> {
  const bin = dirname(node)
  const root = dirname(bin)
  if (!holdsHome(root, home)) return { args: ['--ro-bind', root, root], bin, note: `Node is lent from its install, ${root}.` }

  const args = ['--ro-bind', node, node]
  const modules = join(root, 'lib', 'node_modules')
  const lent = new Set<string>()
  for (const tool of ['npm', 'npx']) {
    const link = join(bin, tool)
    let text: string
    try {
      text = await readlink(link)
    } catch {
      continue
    }
    const inside = relative(modules, resolve(bin, text))
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
    const pkg = join(modules, inside.split(sep)[0]!)
    if (!(await exists(pkg))) continue
    if (!lent.has(pkg)) args.push('--ro-bind', pkg, pkg)
    lent.add(pkg)
    args.push('--symlink', text, link)
  }
  const where = root === home ? 'the home folder' : dirname(root) === home ? 'a folder directly in the home folder' : 'above the home folder'
  return {
    args,
    bin,
    note: `Node is lent as the binary alone${lent.size ? ', with npm' : ''}: its install root, ${root}, is ${where}, which is never lent.`
  }
}

/** Whether binding `dir` would lend the home folder or a folder directly in it. */
function holdsHome(dir: string, home: string): boolean {
  return dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep) || dirname(dir) === home
}

async function realHome(): Promise<string> {
  return realpath(homedir()).catch(() => homedir())
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
