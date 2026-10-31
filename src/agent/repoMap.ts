/**
 * A ranked map of a project's definitions, small enough for a tight window.
 *
 * Tree-sitter pulls out definitions and the names a file uses. A file that
 * uses a name another file defines is a link, and PageRank plus the task's
 * own names decides what fits in the budget. The parse is cached by content
 * hash. Paths the grant refuses never appear.
 *
 * The queries below were written for this app. The grammars are the
 * tree-sitter wasm builds (Unlicense). That package depends on itself, so it
 * is a devDependency: the packager's production walk runs out of memory on
 * the cycle. A packaged app loads the copies shipped as extra resources.
 * The idea is Aider's repo map and Continue's content-hash cache. This is a
 * new implementation.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, sep } from 'node:path'
import Parser from 'web-tree-sitter'
import { estimateTokens } from '@context/snapshot.js'
import type { AgentToolResult } from '@shared/coding.js'
import type { ToolDefinition } from '@shared/types.js'
import { Grant } from './grant.js'

/** The map a tool call renders, unless the caller asks for less. */
export const REPO_MAP_TOKENS = 1024
/** The map given with the task, when that setting is on. */
export const REPO_MAP_FACT_TOKENS = 512
/** A call cannot ask for more than this. */
export const REPO_MAP_MAX_TOKENS = 4096
/** The scan stops after this many source files and says so. */
export const REPO_MAP_MAX_FILES = 2000
/** A file at least this big is left out of the map. */
export const REPO_MAP_MAX_FILE_BYTES = 256 * 1024

export const REPO_MAP_TOOL: ToolDefinition = {
  name: 'repo_map',
  label: 'Repo map',
  description:
    'A short map of the project: the files most connected to the task, with the names they define. ' +
    'Use it before reading a whole file. focus narrows it to paths or names; budget is a token limit.',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'Paths or names to prefer, separated by spaces. Optional.' },
      budget: { type: 'number', description: `Token budget, at most ${REPO_MAP_MAX_TOKENS}. Defaults to ${REPO_MAP_TOKENS}.` }
    }
  }
}

/**
 * Definitions and references. Written here, not taken from a grammar repo.
 * A pattern that a grammar does not have is skipped when the language loads.
 */
const QUERIES: Record<string, string[]> = {
  typescript: [
    '(function_declaration name: (identifier) @def)',
    '(class_declaration name: (type_identifier) @def)',
    '(method_definition name: (property_identifier) @def)',
    '(type_alias_declaration name: (type_identifier) @def)',
    '(interface_declaration name: (type_identifier) @def)',
    '(variable_declarator name: (identifier) @def)',
    '(call_expression function: (identifier) @ref)'
  ],
  javascript: [
    '(function_declaration name: (identifier) @def)',
    '(class_declaration name: (identifier) @def)',
    '(method_definition name: (property_identifier) @def)',
    '(variable_declarator name: (identifier) @def)',
    '(call_expression function: (identifier) @ref)'
  ],
  python: [
    '(function_definition name: (identifier) @def)',
    '(class_definition name: (identifier) @def)',
    '(call function: (identifier) @ref)'
  ],
  c: [
    '(function_definition declarator: (function_declarator declarator: (identifier) @def))',
    '(call_expression function: (identifier) @ref)'
  ],
  rust: [
    '(function_item name: (identifier) @def)',
    '(struct_item name: (type_identifier) @def)',
    '(enum_item name: (type_identifier) @def)',
    '(call_expression function: (identifier) @ref)'
  ],
  go: [
    '(function_declaration name: (identifier) @def)',
    '(method_declaration name: (field_identifier) @def)',
    '(type_spec name: (type_identifier) @def)',
    '(call_expression function: (identifier) @ref)'
  ]
}

const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.c': 'c',
  '.h': 'c',
  '.rs': 'rust',
  '.go': 'go'
}

const WASM: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  c: 'tree-sitter-c.wasm',
  rust: 'tree-sitter-rust.wasm',
  go: 'tree-sitter-go.wasm'
}

interface SymbolFile {
  path: string
  hash: string
  defs: Array<{ name: string; signature: string }>
  refs: string[]
}

const cache = new Map<string, SymbolFile>()
let parses = 0
let hits = 0

/** How many files were parsed, and how many were served from the hash cache. */
export function repoMapCacheStats(): { parses: number; hits: number } {
  return { parses, hits }
}

export function resetRepoMapCache(): void {
  cache.clear()
  parses = 0
  hits = 0
}

interface Loaded {
  parser: Parser
  languages: Map<string, Parser.Language>
}

let loading: Promise<Loaded> | null = null
/** A test points the loader at files that are not there, then back. */
let filesForTest: { runtime: string; grammars: string } | null = null

export function useTreeSitterFilesForTest(files: { runtime: string; grammars: string } | null): void {
  filesForTest = files
  loading = null
}

function treeSitterFiles(): { runtime: string; grammars: string } {
  if (filesForTest) return filesForTest
  const packaged = join(process.resourcesPath ?? '', 'tree-sitter')
  if (process.resourcesPath && existsSync(join(packaged, 'tree-sitter.wasm'))) {
    return { runtime: join(packaged, 'tree-sitter.wasm'), grammars: join(packaged, 'grammars') }
  }
  // The app's own modules, not whichever directory the process was started in.
  const require = createRequire(import.meta.url)
  const runtimePkg = dirname(require.resolve('web-tree-sitter/package.json'))
  const grammarPkg = dirname(require.resolve('tree-sitter-wasms/package.json'))
  return {
    runtime: join(runtimePkg, 'tree-sitter.wasm'),
    grammars: join(grammarPkg, 'out')
  }
}

async function load(): Promise<Loaded> {
  if (!loading) {
    const pending = (async () => {
      const files = treeSitterFiles()
      await Parser.init({ locateFile: () => files.runtime })
      const languages = new Map<string, Parser.Language>()
      for (const [name, file] of Object.entries(WASM)) {
        languages.set(name, await Parser.Language.load(join(files.grammars, file)))
      }
      return { parser: new Parser(), languages }
    })()
    loading = pending
    pending.catch(() => {
      if (loading === pending) loading = null
    })
  }
  return loading
}

export interface RepoMapOptions {
  /** Paths or names to rank higher. */
  focus?: string
  /** Also rank files the run has already read or edited. */
  touched?: readonly string[]
  /** Names from the task, ranked the same way as focus. */
  task?: string
  budget?: number
  /** How many source files to read. The tool does not set this. */
  maxFiles?: number
}

/** The map as the model sees it, within the budget. */
export async function renderRepoMap(grant: Grant, options: RepoMapOptions = {}): Promise<string> {
  const budget = clampBudget(options.budget)
  const maxFiles = options.maxFiles ?? REPO_MAP_MAX_FILES
  const scanned = await scan(grant, maxFiles)
  const focus = tokensOf(`${options.focus ?? ''} ${options.task ?? ''}`)
  const touched = new Set(options.touched ?? [])
  const ranked = rank(scanned.files, focus, touched)
  const lines: string[] = []
  for (const file of ranked) {
    const block = [file.path, ...file.defs.slice(0, 8).map((def) => `  ${def.signature}`)].join('\n')
    const next = lines.length ? `${lines.join('\n\n')}\n\n${block}` : block
    if (estimateTokens(next) > budget) {
      if (lines.length === 0 && estimateTokens(file.path) <= budget) lines.push(file.path)
      break
    }
    lines.push(block)
  }
  const body = lines.join('\n\n') || 'No source files in the grant.'
  const counted = maxFiles === 1 ? '1 file' : `${maxFiles} files`
  return scanned.capped ? `${body}\n\n(stopped after ${counted})` : body
}

export async function repoMapTool(grant: Grant, args: Record<string, unknown>, touched: readonly string[] = []): Promise<AgentToolResult> {
  const focus = typeof args.focus === 'string' ? args.focus : ''
  const budget = typeof args.budget === 'number' ? args.budget : REPO_MAP_TOKENS
  if (budget > REPO_MAP_MAX_TOKENS) {
    return { ok: false, content: `The budget cannot be more than ${REPO_MAP_MAX_TOKENS} tokens.` }
  }
  try {
    const text = await renderRepoMap(grant, { focus, budget, touched })
    return { ok: true, content: text }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'it failed to load'
    return { ok: false, content: `The repo map is unavailable: ${reason}` }
  }
}

export interface ReadCount {
  id: string
  /** Whole-file reads, the ones a map is meant to avoid. */
  withMap: number
  withoutMap: number
}

/** The comparison a harness prints: whole-file reads with the map, and without it. */
export function mapReadReport(rows: readonly ReadCount[]): string {
  const lines = ['Whole-file reads, with the repo map and without it.']
  let withMap = 0
  let withoutMap = 0
  for (const row of rows) {
    withMap += row.withMap
    withoutMap += row.withoutMap
    lines.push(`${row.id}: ${row.withMap} with the map, ${row.withoutMap} without`)
  }
  lines.push(`total: ${withMap} with the map, ${withoutMap} without`)
  return lines.join('\n')
}

async function scan(grant: Grant, maxFiles: number): Promise<{ files: SymbolFile[]; capped: boolean }> {
  const loaded = await load()
  const found: SymbolFile[] = []
  let capped = false
  const walk = async (dir: string): Promise<void> => {
    if (capped) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (capped) return
      const abs = join(dir, entry.name)
      if (!Grant.visibleAt(abs)) continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const resolved = await grant.resolve(grant.nameFor(abs))
      if (!resolved.ok) continue
      const lang = EXTENSIONS[extname(entry.name)]
      if (!lang) continue
      const info = await stat(resolved.path).catch(() => null)
      if (!info || info.size >= REPO_MAP_MAX_FILE_BYTES) continue
      if (found.length >= maxFiles) {
        capped = true
        return
      }
      const text = await readFile(resolved.path, 'utf8').catch(() => null)
      if (text === null) continue
      found.push(await symbolsOf(loaded, resolved.relative.split(sep).join('/'), text, lang))
    }
  }
  await walk(grant.realRoot)
  return { files: found, capped }
}

async function symbolsOf(loaded: Loaded, path: string, text: string, lang: string): Promise<SymbolFile> {
  const hash = createHash('sha256').update(text).digest('hex')
  const cached = cache.get(path)
  if (cached && cached.hash === hash) {
    hits += 1
    return cached
  }
  parses += 1
  const language = loaded.languages.get(lang === 'tsx' ? 'tsx' : lang)
  const defs: SymbolFile['defs'] = []
  const refs: string[] = []
  if (language) {
    loaded.parser.setLanguage(language)
    const tree = loaded.parser.parse(text)
    const patterns = QUERIES[lang === 'tsx' ? 'typescript' : lang] ?? []
    if (tree) {
      for (const pattern of patterns) {
        let query: Parser.Query
        try {
          query = language.query(pattern)
        } catch {
          continue
        }
        for (const capture of query.captures(tree.rootNode)) {
          const name = capture.node.text
          if (!name || name.length > 80) continue
          if (capture.name === 'def') {
            const signature = capture.node.parent?.text.split('\n')[0]?.slice(0, 120) ?? name
            defs.push({ name, signature })
          } else if (capture.name === 'ref') refs.push(name)
        }
        query.delete()
      }
      tree.delete()
    }
  }
  const file = { path, hash, defs, refs }
  cache.set(path, file)
  return file
}

function rank(files: SymbolFile[], focus: Set<string>, touched: Set<string>): SymbolFile[] {
  const definedBy = new Map<string, string[]>()
  for (const file of files) {
    for (const def of file.defs) {
      const list = definedBy.get(def.name) ?? []
      list.push(file.path)
      definedBy.set(def.name, list)
    }
  }
  const inbound = new Map<string, Array<{ from: string; weight: number }>>()
  for (const file of files) inbound.set(file.path, [])
  for (const file of files) {
    const to = new Set<string>()
    for (const ref of file.refs) {
      for (const target of definedBy.get(ref) ?? []) {
        if (target !== file.path) to.add(target)
      }
    }
    const out = [...to]
    if (!out.length) continue
    const weight = 1 / out.length
    for (const target of out) inbound.get(target)?.push({ from: file.path, weight })
  }
  const n = Math.max(1, files.length)
  const score = new Map(files.map((file) => [file.path, 1 / n]))
  for (let i = 0; i < 20; i++) {
    const next = new Map<string, number>()
    for (const file of files) {
      let fromOthers = 0
      for (const edge of inbound.get(file.path) ?? []) fromOthers += (score.get(edge.from) ?? 0) * edge.weight
      let value = (1 - 0.85) / n + 0.85 * fromOthers
      const named = file.defs.some((def) => focus.has(def.name)) || focus.has(basename(file.path)) || [...focus].some((item) => file.path.endsWith(item))
      if (named || touched.has(file.path)) value += 1
      next.set(file.path, value)
    }
    for (const [path, value] of next) score.set(path, value)
  }
  return [...files].sort((a, b) => (score.get(b.path) ?? 0) - (score.get(a.path) ?? 0) || a.path.localeCompare(b.path))
}

function tokensOf(text: string): Set<string> {
  return new Set(text.split(/[^A-Za-z0-9_./-]+/).filter((token) => token.length > 1))
}

function clampBudget(budget: number | undefined): number {
  if (!budget || budget < 1) return REPO_MAP_TOKENS
  return Math.min(REPO_MAP_MAX_TOKENS, Math.floor(budget))
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}
