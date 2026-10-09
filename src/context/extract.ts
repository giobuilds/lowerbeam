/**
 * The part of a conversation that can be kept without a model.
 *
 * A command, a path, a flag, a signature or an error string is reused later
 * character for character. A summary that paraphrases one has already lost it.
 * These are recognisable by their shape, so the record is the transcript's own
 * spelling, in the order it first appeared. Nothing here is sent to a model,
 * and nothing here replaces the prose summary: that is a later milestone.
 */

export interface MechanicalRecord {
  commands: string[]
  /** File paths and host names. Both are reused verbatim, and both have a shape. */
  paths: string[]
  flags: string[]
  /** Includes, macros, function signatures, and the string literals a program prints. */
  interfaces: string[]
  errors: string[]
}

const SHELL = new Set(['bash', 'sh', 'shell', 'console', 'zsh', 'fish'])
const CODE = new Set(['c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go'])

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g
const FILE = /\b(?:\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:c|h|cc|cpp|hpp|ts|tsx|js|mjs|py|rs|go|json|yml|yaml|md)\b/g
const HOST = /\b[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)*\.[A-Za-z]{2,}\b/g
const FLAG = /(?:^|[\s(])(-{1,2}[A-Za-z][\w-]*)/g
const ERROR = /(?:\b(?:fatal error|error|warning)\s*:|\bTS\d{3,}\b|Segmentation fault|Assertion failed)/

function push(list: string[], value: string): void {
  const trimmed = value.trim()
  if (trimmed && !list.includes(trimmed)) list.push(trimmed)
}

function tagOf(raw: string): string {
  return raw.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function takeShell(body: string, commands: string[]): void {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    push(commands, trimmed)
  }
}

/** A declaration line, not the statements under it. Bodies are a later concern. */
function takeDeclaration(line: string, interfaces: string[]): void {
  const trimmed = line.trim()
  if (/^#\s*(?:include|define)\b/.test(trimmed)) {
    push(interfaces, trimmed)
    return
  }
  const signature = /^(?:(?:static|extern|inline|const|unsigned|signed|struct|enum)\s+)*(?:void|int|char|long|short|float|double|size_t|bool|[A-Za-z_]\w*)\s+\**[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{?$/.exec(trimmed)
  if (signature) push(interfaces, trimmed.replace(/\s*\{$/, ''))
}

/**
 * Walk C-like source once, so a quote inside a comment is not a string and a
 * comment marker inside a string is not a comment.
 */
function takeCode(body: string, interfaces: string[]): void {
  let mode: 'code' | 'line' | 'block' | 'string' | 'char' = 'code'
  let line = ''
  let literal = ''
  const flush = () => {
    takeDeclaration(line, interfaces)
    line = ''
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    const next = body[i + 1]
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code'
        flush()
      }
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code'
        i++
      }
      continue
    }
    if (mode === 'string') {
      if (ch === '\\' && next !== undefined) {
        // Keep the escape as written. The spelling in the transcript includes the slash.
        literal += ch + next
        i++
        continue
      }
      if (ch === '"') {
        if (literal.trim().length >= 2) push(interfaces, literal)
        literal = ''
        mode = 'code'
        continue
      }
      if (ch === '\n') {
        // A string that runs off the line was not closed. Keep what was real code.
        literal = ''
        mode = 'code'
        flush()
        continue
      }
      literal += ch
      continue
    }
    if (mode === 'char') {
      if (ch === '\\' && next !== undefined) {
        i++
        continue
      }
      if (ch === '\'') mode = 'code'
      continue
    }
    if (ch === '/' && next === '/') {
      mode = 'line'
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      mode = 'block'
      i++
      continue
    }
    if (ch === '"') {
      mode = 'string'
      continue
    }
    if (ch === '\'') {
      mode = 'char'
      continue
    }
    if (ch === '\n') flush()
    else line += ch
  }
  if (mode === 'code') flush()
}

function looksLikeCode(body: string): boolean {
  return /^\s*#\s*include\b/m.test(body) || /^\s*(?:static\s+)?(?:int|void|char)\s+\w+\s*\(/m.test(body)
}

function looksLikeShell(body: string): boolean {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.every((line) => /^(?:gcc|g\+\+|clang|make|cmake|npm|npx|sudo|\.\/)/.test(line))
}

function takeTick(inner: string, record: MechanicalRecord): void {
  const text = inner.trim()
  if (/^#\s*include\b/.test(text)) {
    push(record.interfaces, text)
    return
  }
  if (/^(?:gcc|g\+\+|clang|clang\+\+|make|cmake|npm|npx|node|python3?|pip3?|sudo|cargo)\s+\S/.test(text) || /^\.\//.test(text) || / && /.test(text)) {
    push(record.commands, text)
  }
}

function collect(text: string, pattern: RegExp, into: string[]): void {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) push(into, match[1] ?? match[0])
}

export function extractMechanics(text: string): MechanicalRecord {
  const record: MechanicalRecord = { commands: [], paths: [], flags: [], interfaces: [], errors: [] }
  const fences: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(FENCE)) {
    const body = match[2] ?? ''
    const tag = tagOf(match[1] ?? '')
    if (SHELL.has(tag) || (!tag && looksLikeShell(body))) takeShell(body, record.commands)
    else if (CODE.has(tag) || (!tag && looksLikeCode(body))) takeCode(body, record.interfaces)
    const start = match.index ?? 0
    fences.push({ start, end: start + match[0].length })
  }

  // Commands written inline, outside a fence, are still commands.
  const tick = /`([^`\n]+)`/g
  for (const match of text.matchAll(tick)) {
    const at = match.index ?? 0
    if (fences.some((fence) => at >= fence.start && at < fence.end)) continue
    takeTick(match[1] ?? '', record)
  }

  collect(text, FILE, record.paths)
  collect(text, HOST, record.paths)
  collect(text, FLAG, record.flags)
  for (const line of text.split('\n')) {
    if (ERROR.test(line)) push(record.errors, line)
  }
  return record
}

/** One text, so a fact can be looked up the same way as in a summary. */
export function mechanicalText(record: MechanicalRecord): string {
  return [...record.commands, ...record.paths, ...record.flags, ...record.interfaces, ...record.errors].join('\n')
}
