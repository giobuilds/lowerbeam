import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import type { ToolDefinition } from '@shared/types.js'
import type { AgentToolResult } from '@shared/coding.js'
import { Grant } from './grant.js'

/**
 * The three tools a read-only run gets: list, search, read.
 *
 * Each is bounded on purpose. A model that can ask for a whole file will, and
 * a 4,000-line file is the context window gone in one call. Full output is
 * never the model's to have; it gets an excerpt and can ask for the next one.
 *
 * Every path goes through the grant. A refusal is reported as a refusal — the
 * model is told it asked for something outside the project — and recorded as
 * one, because how often a model reaches outside is a measurement.
 */

const LIST_MAX = 200
const SEARCH_MAX_HITS = 30
const SEARCH_MAX_FILES = 5000
const SEARCH_MAX_FILE_BYTES = 512 * 1024
const SEARCH_EXCERPT_CHARS = 200
const READ_MAX_LINES = 200
const READ_MAX_BYTES = 16 * 1024

/**
 * The most of a run's window one `read` may take.
 *
 * A fixed 16 KB is a quarter of a 16,384-token window and most of a 6,144
 * one: measured in the crossover family, a small window could not hold two
 * reads at once, so compaction fired every two or three rounds and the run
 * spent itself re-reading. The cap follows the window instead. At a third of
 * the window — with code running about three characters to the token — the
 * budget at 16,384 tokens is exactly the 16 KB it has always been, so a run
 * with a full window reads precisely as before.
 */
const READ_SHARE = 1 / 3
const BYTES_PER_TOKEN = 3
/** Below this a read is too small to be worth making. */
const READ_MIN_BYTES = 4 * 1024

export function readBudgetBytes(contextLimit: number | null | undefined): number {
  if (!contextLimit) return READ_MAX_BYTES
  const share = Math.round(contextLimit * READ_SHARE * BYTES_PER_TOKEN)
  return Math.max(READ_MIN_BYTES, Math.min(READ_MAX_BYTES, share))
}

/** What a tool needs to know about the run it is serving. */
export interface ToolContext {
  /** The window the run has, when it knows it; the read budget follows it. */
  contextLimit?: number | null
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    label: 'List files',
    description:
      'List the entries in a directory of the project. Start at "." and narrow ' +
      'from there. Returns at most 200 entries.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory, relative to the project root. Defaults to ".".' }
      }
    }
  },
  {
    name: 'search',
    label: 'Search',
    description:
      'Find lines containing a phrase anywhere in the project (case-insensitive, ' +
      'not a regex). Returns up to 30 hits as path:line with a short excerpt. ' +
      'Use it to locate code before reading a file.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to look for.' },
        path: { type: 'string', description: 'Restrict to this directory or file. Defaults to the whole project.' }
      },
      required: ['query']
    }
  },
  {
    name: 'read',
    label: 'Read a file',
    description:
      'Read part of a file: at most 200 lines or 16 KB per call. Give a start ' +
      'line to read further into a long file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File, relative to the project root.' },
        start: { type: 'integer', description: '1-based first line. Defaults to 1.' },
        end: { type: 'integer', description: '1-based last line. At most 200 lines after start.' }
      },
      required: ['path']
    }
  }
]

/**
 * The two write tools, declared only for an edit run and refused by the grant
 * in any other. Both carry a precondition, because a write against a file
 * that has changed underneath the model is how a patch lands in the wrong
 * place: edit_file must match exactly once, write_file must be told the
 * hash the file had when it was read.
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'edit_file',
    label: 'Edit a file',
    description:
      'Replace one exact passage in a file. `find` must appear exactly once — ' +
      'include enough surrounding lines to make it unique. Read the file first; ' +
      'if the edit is refused as not found or ambiguous, read it again and retry ' +
      'with the text as it actually is.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File, relative to the project root.' },
        find: { type: 'string', description: 'The exact text to replace, verbatim, including whitespace.' },
        replace: { type: 'string', description: 'What to put in its place.' }
      },
      required: ['path', 'find', 'replace']
    }
  },
  {
    name: 'write_file',
    label: 'Write a file',
    description:
      'Create a new file with the given content. To overwrite an existing file, ' +
      'pass expected_sha256 from the header the read tool showed; a mismatch ' +
      'means the file changed since and the write is refused. Prefer edit_file ' +
      'for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File, relative to the project root.' },
        content: { type: 'string', description: 'The whole content of the file.' },
        expected_sha256: { type: 'string', description: 'Required to overwrite: the hash shown when the file was read.' }
      },
      required: ['path', 'content']
    }
  }
]

export async function runAgentTool(
  grant: Grant,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {}
): Promise<AgentToolResult> {
  switch (name) {
    case 'list_files':
      return listFiles(grant, str(args.path) || '.')
    case 'search':
      return search(grant, str(args.query), str(args.path) || '.')
    case 'read':
      return read(grant, str(args.path), int(args.start), int(args.end), readBudgetBytes(context.contextLimit))
    case 'edit_file':
      return editFile(grant, str(args.path), str(args.find), str(args.replace))
    case 'write_file':
      return writeWholeFile(grant, str(args.path), str(args.content), str(args.expected_sha256))
    default:
      // Unknown tools fail closed: nothing is guessed at.
      return { ok: false, content: `There is no tool called ${name}.` }
  }
}

async function listFiles(grant: Grant, dir: string): Promise<AgentToolResult> {
  const resolved = await grant.resolve(dir)
  if (!resolved.ok) return refusal(resolved)
  let entries
  try {
    entries = await readdir(resolved.path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, content: `Could not list ${dir}: ${(err as Error).message}` }
  }
  const visible = entries.filter((e) => Grant.visible(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  const lines = visible.slice(0, LIST_MAX).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  const more = visible.length > LIST_MAX ? `\n… and ${visible.length - LIST_MAX} more` : ''
  return { ok: true, content: `${resolved.relative}:\n${lines.join('\n')}${more}` }
}

async function search(grant: Grant, query: string, dir: string): Promise<AgentToolResult> {
  if (!query.trim()) return { ok: false, content: 'Give something to search for.' }
  const resolved = await grant.resolve(dir)
  if (!resolved.ok) return refusal(resolved)

  const needle = query.toLowerCase()
  const hits: string[] = []
  let scanned = 0

  const walk = async (abs: string): Promise<void> => {
    if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) return
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!Grant.visible(e.name)) continue
      const child = join(abs, e.name)
      if (e.isDirectory()) {
        await walk(child)
      } else if (e.isFile()) {
        scanned += 1
        await scanFile(child)
      }
      if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) return
    }
  }

  const scanFile = async (abs: string): Promise<void> => {
    let info
    try {
      info = await stat(abs)
    } catch {
      return
    }
    if (info.size > SEARCH_MAX_FILE_BYTES) return
    const text = await readText(abs)
    if (text === null) return
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_HITS; i++) {
      const line = lines[i]!
      if (!line.toLowerCase().includes(needle)) continue
      const rel = relative(grant.realRoot, abs).split(sep).join('/')
      hits.push(`${rel}:${i + 1}: ${excerpt(line)}`)
    }
  }

  // A file, not a directory: search that file. Every model tried this —
  // "search for X in src/main/ipc.ts" is the natural call — and until it
  // was handled the answer was "No lines contain", which was false: across
  // the first four matrices 56 of 62 such searches were answered that way.
  let info
  try {
    info = await stat(resolved.path)
  } catch {
    return { ok: false, content: `No such path: ${resolved.relative}` }
  }
  if (info.isFile()) await scanFile(resolved.path)
  else await walk(resolved.path)
  if (hits.length === 0) return { ok: true, content: `No lines contain "${query}"${info.isFile() ? ` in ${resolved.relative}` : ''}.` }
  const capped = hits.length >= SEARCH_MAX_HITS ? `\n(first ${SEARCH_MAX_HITS} hits; narrow the search for more)` : ''
  return { ok: true, content: hits.join('\n') + capped }
}

async function read(
  grant: Grant,
  path: string,
  start: number | null,
  end: number | null,
  maxBytes: number
): Promise<AgentToolResult> {
  if (!path) return { ok: false, content: 'Give a path to read.' }
  const resolved = await grant.resolve(path)
  if (!resolved.ok) return refusal(resolved)
  const text = await readText(resolved.path)
  if (text === null) return { ok: false, content: `${resolved.relative} is not a text file.` }

  const lines = text.split('\n')
  const first = Math.max(1, start ?? 1)
  const last = Math.min(lines.length, end ?? first + READ_MAX_LINES - 1, first + READ_MAX_LINES - 1)
  if (first > lines.length) {
    return { ok: false, content: `${resolved.relative} has only ${lines.length} lines.` }
  }

  // Number the lines, so what the model cites can be checked against the file.
  const width = String(last).length
  const out: string[] = []
  let bytes = 0
  let shown = first - 1
  for (let i = first - 1; i < last; i++) {
    const line = `${String(i + 1).padStart(width)}| ${lines[i]}`
    bytes += line.length + 1
    if (bytes > maxBytes) break
    out.push(line)
    shown = i + 1
  }
  const tail =
    shown < lines.length ? `\n(lines ${shown + 1}–${lines.length} not shown; read from ${shown + 1} for more)` : ''
  // The hash is what write_file has to quote back to overwrite: proof the
  // model is writing over what it read, not over something newer.
  const hash = createHash('sha256').update(text).digest('hex')
  return { ok: true, content: `${resolved.relative} (${lines.length} lines, sha256 ${hash.slice(0, 16)})\n${out.join('\n')}${tail}` }
}

async function editFile(grant: Grant, path: string, find: string, replace: string): Promise<AgentToolResult> {
  if (!path) return { ok: false, content: 'Give a path to edit.' }
  if (!find) return { ok: false, content: 'Give the exact text to find.' }
  const resolved = await grant.resolveForWrite(path)
  if (!resolved.ok) return refusal(resolved)
  const text = await readText(resolved.path)
  if (text === null) return { ok: false, content: `${resolved.relative} does not exist or is not a text file. Use write_file to create a file.` }

  // Exact first. Then tolerant of the one thing a model cannot see: a uniform
  // indentation difference — it copies passages out of numbered read output
  // and keeps a space where the line number was. The file's indentation is
  // what is kept; the block's relative indentation is what the model chose.
  const exact = locate(text, find)
  const match = exact.count > 0 ? exact : locateIndented(text, find)
  if (match.count === 0) {
    return { ok: false, content: `Not found in ${resolved.relative}: the text to find does not appear. Read the file again and copy the passage exactly.` }
  }
  if (match.count > 1) {
    return { ok: false, content: `Ambiguous in ${resolved.relative}: the text to find appears more than once. Include more surrounding lines so it is unique.` }
  }
  const replacement = match.indent === null ? replace : reindent(replace, find, match.indent)
  const next = text.slice(0, match.start) + replacement + text.slice(match.end)
  await writeFile(resolved.path, next)
  const line = text.slice(0, match.start).split('\n').length
  const note = match.indent === null ? '' : ' (indentation taken from the file)'
  return { ok: true, content: `Edited ${resolved.relative} at line ${line}: ${find.split('\n').length} line(s) replaced by ${replace.split('\n').length}${note}.` }
}

interface Located {
  count: number
  start: number
  end: number
  /** The file's indentation of the matched block, when the match was tolerant; null when exact. */
  indent: string | null
}

function locate(text: string, find: string): Located {
  const first = text.indexOf(find)
  if (first < 0) return { count: 0, start: 0, end: 0, indent: null }
  const count = text.indexOf(find, first + 1) >= 0 ? 2 : 1
  return { count, start: first, end: first + find.length, indent: null }
}

/** Match line by line with each side's common leading whitespace removed. */
function locateIndented(text: string, find: string): Located {
  const want = stripCommonIndent(find.replace(/\n$/, '').split('\n')).map((l) => l.trimEnd())
  if (want.length === 0 || want.every((l) => !l.trim())) return { count: 0, start: 0, end: 0, indent: null }
  const lines = text.split('\n')
  let count = 0
  let hit: { at: number; indent: string } | null = null
  for (let i = 0; i + want.length <= lines.length; i++) {
    const window = lines.slice(i, i + want.length)
    const indent = commonIndent(window)
    const same = window.every((l, k) => l.slice(indent.length).trimEnd() === want[k])
    if (!same) continue
    count += 1
    hit ??= { at: i, indent }
  }
  if (!hit) return { count: 0, start: 0, end: 0, indent: null }
  const start = lines.slice(0, hit.at).reduce((n, l) => n + l.length + 1, 0)
  const end = start + lines.slice(hit.at, hit.at + want.length).join('\n').length
  return { count, start, end, indent: hit.indent }
}

/** The replacement, with the model's common indent swapped for the file's. */
function reindent(replace: string, find: string, indent: string): string {
  const trailing = replace.endsWith('\n') ? '\n' : ''
  const own = commonIndent(find.replace(/\n$/, '').split('\n'))
  return (
    replace
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => (l.trim() ? indent + (l.startsWith(own) ? l.slice(own.length) : l.trimStart()) : ''))
      .join('\n') + trailing
  )
}

function commonIndent(lines: string[]): string {
  let indent: string | null = null
  for (const l of lines) {
    if (!l.trim()) continue
    const lead = l.match(/^[ \t]*/)?.[0] ?? ''
    if (indent === null || lead.length < indent.length) indent = lead
  }
  return indent ?? ''
}

function stripCommonIndent(lines: string[]): string[] {
  const indent = commonIndent(lines)
  return lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()))
}

async function writeWholeFile(grant: Grant, path: string, content: string, expected: string): Promise<AgentToolResult> {
  if (!path) return { ok: false, content: 'Give a path to write.' }
  const resolved = await grant.resolveForWrite(path)
  if (!resolved.ok) return refusal(resolved)
  const existing = await readText(resolved.path)
  if (existing !== null) {
    const hash = createHash('sha256').update(existing).digest('hex')
    if (!expected) {
      return { ok: false, content: `${resolved.relative} already exists. To overwrite it, pass expected_sha256 from the read tool's header, or use edit_file.` }
    }
    if (!hash.startsWith(expected)) {
      return { ok: false, content: `${resolved.relative} has changed since it was read (hash mismatch). Read it again before overwriting.` }
    }
  }
  await mkdir(dirname(resolved.path), { recursive: true })
  await writeFile(resolved.path, content)
  return { ok: true, content: `${existing === null ? 'Created' : 'Overwrote'} ${resolved.relative} (${content.split('\n').length} lines).` }
}

function refusal(r: { denied: boolean; reason: string }): AgentToolResult {
  return { ok: false, denied: r.denied, content: r.reason }
}

/** Text, or null for anything that looks binary. */
async function readText(abs: string): Promise<string | null> {
  let handle
  try {
    handle = await open(abs, 'r')
    const probe = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    if (probe.subarray(0, bytesRead).includes(0)) return null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > SEARCH_EXCERPT_CHARS ? trimmed.slice(0, SEARCH_EXCERPT_CHARS) + '…' : trimmed
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null
}
