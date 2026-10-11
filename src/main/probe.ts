import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessSync, constants } from 'node:fs'
import { join, basename } from 'node:path'
import type { BinaryInfo, BinaryKind, GpuDevice } from '@shared/types.js'

const run = promisify(execFile)

/** Where a distro package, a release tarball or the install script put things. */
const SEARCH_DIRS = [
  join(process.env['HOME'] ?? '', '.local/bin'),
  join(process.env['HOME'] ?? '', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/opt/llama.cpp/bin',
  join(process.env['HOME'] ?? '', 'llama.cpp/build/bin')
]

/**
 * Both shapes of llama.cpp, newest-style first.
 *
 * Order matters: `llama serve` is the current distribution, while a stale
 * distro `llama-server` often sits in /usr/bin alongside it. Preferring the
 * unified CLI avoids silently driving a build the user does not actually use —
 * which is how a working GPU can look like a broken one.
 */
const CANDIDATE_NAMES: Array<{ name: string; kind: BinaryKind }> = [
  { name: 'llama', kind: 'unified' },
  { name: 'llama-server', kind: 'llama-server' }
]

export interface Candidate {
  path: string
  kind: BinaryKind
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Every llama.cpp executable we can find, in preference order. */
export function discoverBinaries(explicit?: string): Candidate[] {
  const found: Candidate[] = []
  const seen = new Set<string>()

  if (explicit && isExecutable(explicit)) {
    found.push({ path: explicit, kind: guessKind(explicit) })
    seen.add(explicit)
  }
  for (const { name, kind } of CANDIDATE_NAMES) {
    for (const dir of SEARCH_DIRS) {
      const path = join(dir, name)
      if (!seen.has(path) && isExecutable(path)) {
        found.push({ path, kind })
        seen.add(path)
      }
    }
  }
  return found
}

function guessKind(path: string): BinaryKind {
  return basename(path) === 'llama-server' ? 'llama-server' : 'unified'
}

/**
 * llama.cpp writes --version and --help to stderr, and the ROCm/CUDA backends
 * add device-init noise, so both streams are read and filtered. A non-zero exit
 * is not fatal: --version exits non-zero on some builds.
 */
async function capture(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000
    })
    return stdout + stderr
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    if (out) return out
    throw new Error(e.message ?? String(err))
  }
}

/**
 * One documented option, as the installed binary describes it.
 *
 * Parsed from --help rather than shipped as a copy, so the reference always
 * matches the build actually installed — llama.cpp adds, renames and changes
 * the meaning of flags often enough that a bundled list would mislead.
 */
export interface FlagDoc {
  /** e.g. "-c, --ctx-size" */
  names: string
  /** Argument placeholder, e.g. "N" or "{none,linear,yarn}". Empty for switches. */
  argument: string
  description: string
  /** Section heading it appeared under, e.g. "sampling params". */
  section: string
  /** Environment variable that sets the same thing, when documented. */
  env: string | null
}

/**
 * llama.cpp lays --help out as a flag column and a description column, with
 * wrapped descriptions continuing on indented lines, and `----- name -----`
 * section headers between groups.
 */
/** "N", "TYPE", "<dev1,dev2>", "{none,linear}", "[on|off]", "MiB0,MiB1,..." */
function isArgumentPlaceholder(part: string): boolean {
  if (part.length > 40) return false
  return /^(?:[A-Z][A-Z0-9_]*|<[^>]+>|\{[^}]+\}|\[[^\]]+\]|[A-Za-z]+\d[\w,.]*)$/.test(part)
}

export function parseFlagDocs(helpText: string): FlagDoc[] {
  const docs: FlagDoc[] = []
  let section = 'general'
  let current: FlagDoc | null = null

  const push = (): void => {
    if (!current) return
    current.description = current.description.replace(/\s+/g, ' ').trim()
    const env = current.description.match(/\(env:\s*([A-Z0-9_]+)\)/)
    if (env) {
      current.env = env[1]!
      current.description = current.description.replace(env[0], '').trim()
    }
    if (current.names) docs.push(current)
    current = null
  }

  for (const raw of helpText.split('\n')) {
    const heading = raw.match(/^-{2,}\s*(.+?)\s*-{2,}$/)
    if (heading) {
      push()
      section = heading[1]!.trim()
      continue
    }
    // A flag line starts at the left margin with a dash. The flag column holds
    // several space-separated pieces — "-c,    --ctx-size N" — so the split
    // cannot simply be "the first run of two spaces", which lands after "-c,".
    if (/^-/.test(raw)) {
      push()
      const parts = raw.trim().split(/\s{2,}/)
      const names: string[] = []
      let argument = ''
      let i = 0
      for (; i < parts.length; i++) {
        const part = parts[i]!
        if (part.startsWith('-')) {
          names.push(part)
          continue
        }
        // An argument placeholder: N, TYPE, <dev1,dev2>, {none,linear}, [on|off].
        if (!argument && isArgumentPlaceholder(part)) {
          argument = part
          continue
        }
        break
      }
      const joined = names.join(' ').trim()
      // A trailing placeholder can also sit inside the last name chunk.
      const trailing = joined.match(/^(.*?)\s+([A-Z][A-Z0-9_]*|<[^>]+>|\{[^}]+\}|\[[^\]]+\])$/)
      current = {
        names: (trailing ? trailing[1]! : joined).replace(/,$/, '').trim(),
        argument: argument || (trailing ? trailing[2]! : ''),
        description: parts.slice(i).join(' ').trim(),
        section,
        env: null
      }
      continue
    }
    // Indented continuation of the previous description.
    if (current && /^\s{2,}\S/.test(raw)) current.description += ` ${raw.trim()}`
  }
  push()
  return docs
}

/** Every long flag the binary advertises, so the UI can hide unsupported controls. */
export function parseFlags(helpText: string): string[] {
  const flags = new Set<string>()
  for (const match of helpText.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) flags.add(match[1]!)
  return [...flags].sort()
}

/** "  ROCm0: AMD Radeon RX 6600 (8176 MiB, 8142 MiB free)" */
export function parseDevices(listText: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  const re = /^\s*(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm
  for (const m of listText.matchAll(re)) {
    devices.push({ id: m[1]!, name: m[2]!, totalMiB: Number(m[3]), freeMiB: Number(m[4]) })
  }
  return devices
}

export function parseVersion(versionText: string): string {
  const m = versionText.match(/^version:\s*(.+)$/m)
  return m ? m[1]!.trim() : 'unknown'
}

/**
 * The build number llama.cpp prints in its version line.
 * `0.6.0-dev (build 11429, commit d81235049)` and the same line with a
 * `version:` prefix both yield 11429. Absent when the binary did not say.
 */
export function parseBuildNumber(version: string): number | null {
  const m = /\bbuild\s+(\d+)\b/.exec(version)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Newer builds document `--flash-attn [on|off|auto]`; older ones show the flag
 * with no value. Passing a value to the old form (or omitting it on the new
 * form) makes llama.cpp exit during argument parsing.
 */
export function parseFlashAttnStyle(helpText: string): 'bare' | 'value' {
  return /--flash-attn\s*\[?\s*on\s*\|\s*off/i.test(helpText) ? 'value' : 'bare'
}

/** The unified CLI advertises subcommands; the standalone server does not. */
export function detectKind(bareHelpText: string, fallback: BinaryKind): BinaryKind {
  if (/^\s*Available commands:/im.test(bareHelpText) && /^\s*serve\b/im.test(bareHelpText)) {
    return 'unified'
  }
  return fallback
}

export function argvPrefixFor(kind: BinaryKind): string[] {
  return kind === 'unified' ? ['serve'] : []
}

export async function probeBinary(candidate: Candidate): Promise<BinaryInfo> {
  // Ask the binary what it is rather than trusting its filename.
  const bareHelp = await capture(candidate.path, ['--help'])
  const kind = detectKind(bareHelp, candidate.kind)
  const prefix = argvPrefixFor(kind)

  const [versionText, helpText, listText] = await Promise.all([
    capture(candidate.path, ['--version']),
    // The unified CLI's flags live under the subcommand, not at top level.
    prefix.length ? capture(candidate.path, [...prefix, '--help']) : Promise.resolve(bareHelp),
    capture(candidate.path, [...prefix, '--list-devices'])
  ])

  const version = parseVersion(versionText)
  return {
    path: candidate.path,
    kind,
    argvPrefix: prefix,
    version,
    flags: parseFlags(helpText),
    flagDocs: parseFlagDocs(helpText),
    flashAttnStyle: parseFlashAttnStyle(helpText),
    devices: parseDevices(listText),
    label: `${kind === 'unified' ? 'llama serve' : 'llama-server'} — ${version}`
  }
}

/** Probe every candidate, dropping any that fail to run at all. */
export async function probeAll(explicit?: string): Promise<BinaryInfo[]> {
  const results = await Promise.allSettled(discoverBinaries(explicit).map(probeBinary))
  return results
    .filter((r): r is PromiseFulfilledResult<BinaryInfo> => r.status === 'fulfilled')
    .map((r) => r.value)
}

/**
 * Free VRAM moves as other processes come and go, so the planner re-reads it at
 * launch time rather than trusting the cached probe.
 */
export async function readDevices(binary: BinaryInfo): Promise<GpuDevice[]> {
  return parseDevices(await capture(binary.path, [...binary.argvPrefix, '--list-devices']))
}
