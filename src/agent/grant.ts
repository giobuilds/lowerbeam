import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The one project a run may see.
 *
 * Every path a tool receives comes from the model, and the model has read the
 * project — including anything in it that tells the model where else to look.
 * So a path is never trusted by its spelling. It is resolved to what it really
 * names, symlinks included, and only then compared with the root.
 *
 * A prefix comparison on the string alone is not a filesystem boundary:
 * `../`, a symlink out, and a root that is itself a symlink all pass one.
 */
export class Grant {
  private constructor(
    /** The root as the caller gave it. */
    readonly root: string,
    /** The root with every symlink resolved, which is what paths are checked against. */
    readonly realRoot: string,
    /** What is allowed. Checked by the tools, not by the model. `run` includes `edit`. */
    readonly mode: 'inspect' | 'edit' | 'run',
    /** Further roots the run may read and never write, each resolved like the root. A visible term of the grant. */
    readonly alsoRead: Array<{ root: string; realRoot: string }> = []
  ) {}

  static async open(root: string, mode: 'inspect' | 'edit' | 'run' = 'inspect', alsoRead: string[] = []): Promise<Grant> {
    const extra = []
    for (const dir of alsoRead) extra.push({ root: resolve(dir), realRoot: await realpath(dir) })
    return new Grant(resolve(root), await realpath(root), mode, extra)
  }

  /** How a resolved path is named back to the model: inside the project by its relative path, in an extra root by its full path. */
  nameFor(real: string): string {
    const rel = relative(this.realRoot, real)
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel || '.'
    return real
  }

  /**
   * Resolve a path a tool wants to *write*. The file may not exist yet, so
   * its parent is what is resolved; the parent must exist and be inside.
   */
  async resolveForWrite(requested: string): Promise<Resolved> {
    if (this.mode === 'inspect') return { ok: false, denied: true, reason: 'This run is read-only.' }
    const candidate = isAbsolute(requested) ? requested : resolve(this.root, requested)
    const name = basename(candidate)
    if (!name || name === '.' || name === '..') return { ok: false, denied: true, reason: `Not a file path: ${requested}` }
    // The file, and its folders, may not exist yet. Walk up to the nearest
    // ancestor that does, check that one, and keep the remainder — which is
    // then plain names, since resolve() has already flattened any `..`.
    let ancestor = dirname(candidate)
    const remainder: string[] = [name]
    while (!(await exists(ancestor))) {
      remainder.unshift(basename(ancestor))
      const up = dirname(ancestor)
      if (up === ancestor) return { ok: false, denied: true, reason: `Cannot place ${requested} anywhere.` }
      ancestor = up
    }
    const parent = await this.resolve(ancestor)
    if (!parent.ok) return parent
    const path = join(parent.path, ...remainder)
    // The excluded names apply to what would be created, not only to what
    // exists: with no .git directory present, a write to .git/config would
    // otherwise walk up to the root and make one.
    const first = relative(this.realRoot, path).split(sep)[0]
    if (first && EXCLUDED.has(first)) {
      return { ok: false, denied: true, reason: `Not part of the grant: ${first}/` }
    }
    const secret = secretReason(path, relative(this.realRoot, path))
    if (secret) return { ok: false, denied: true, reason: secret }
    // An existing file could itself be a link out; resolve it if it is there.
    try {
      const real = await realpath(path)
      const rel = relative(this.realRoot, real)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { ok: false, denied: true, reason: `${requested} is a link to somewhere outside the project and cannot be written.` }
      }
      return { ok: true, path: real, relative: rel }
    } catch {
      return { ok: true, path, relative: relative(this.realRoot, path) }
    }
  }

  /**
   * Resolve a path the model supplied to one that is provably inside the
   * grant, or say why not. Relative paths are taken from the root; absolute
   * ones are allowed only if they land inside it anyway.
   */
  async resolve(requested: string): Promise<Resolved> {
    const candidate = isAbsolute(requested) ? requested : resolve(this.root, requested)

    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      // Not existing is not the same as forbidden, and saying which helps the
      // model correct a typo instead of trying elsewhere.
      return { ok: false, denied: false, reason: `No such path: ${requested}` }
    }

    let rel = relative(this.realRoot, real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      // An extra root the grant names is readable too, by its full path.
      const extra = this.alsoRead.find((r) => {
        const within = relative(r.realRoot, real)
        return !within.startsWith('..') && !isAbsolute(within)
      })
      if (extra) {
        const within = relative(extra.realRoot, real)
        const first = within.split(sep)[0]
        if (first && EXCLUDED.has(first)) return { ok: false, denied: true, reason: `Not part of the grant: ${first}/` }
        const secret = secretReason(real, within)
        if (secret) return { ok: false, denied: true, reason: secret }
        return { ok: true, path: real, relative: real }
      }
      // Say which kind of outside. A path that reads as inside the project and
      // resolves elsewhere is a link out, and a model told only "outside"
      // retries it in every spelling it can think of.
      const spelledInside = !relative(this.root, candidate).startsWith('..') && !isAbsolute(relative(this.root, candidate))
      return {
        ok: false,
        denied: true,
        reason: spelledInside
          ? `${requested} is a link to somewhere outside the project and cannot be read. Nothing inside the project is behind it; answer from the project itself.`
          : `Outside the project: ${requested}. Only files inside the project${this.alsoRead.length ? ' and the folders the grant names' : ''} can be read; do not ask for it again.`
      }
    }

    // Repository control files and dependency trees are outside the normal
    // grant even though they sit inside the tree: nothing a task needs is in
    // them, and a great deal that a task should not touch is.
    const first = rel.split(sep)[0]
    if (first && EXCLUDED.has(first)) {
      return { ok: false, denied: true, reason: `Not part of the grant: ${first}/` }
    }
    const secret = secretReason(real, rel)
    if (secret) return { ok: false, denied: true, reason: secret }

    rel = rel || '.'
    return { ok: true, path: real, relative: rel }
  }

  /** Whether a directory entry should be walked or listed at all. */
  static visible(name: string): boolean {
    return !EXCLUDED.has(name)
  }

  /** Whether the entry at `abs` should be walked or listed: neither a build folder nor anything holding credentials. */
  static visibleAt(abs: string): boolean {
    // With its parent's name, so a nested rule (`.config/gh`) holds in a walk too.
    return Grant.visible(basename(abs)) && secretReason(abs, join(basename(dirname(abs)), basename(abs))) === null
  }
}

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'out', '.build'])

/**
 * Credentials, excluded from every grant at any depth and never copied into
 * a workspace: a project that keeps a key or a `.env` beside its code has not
 * thereby given it to a model. Templates — `.env.example` and the like — are
 * what a task reads to learn the settings, and hold no secrets by convention.
 * Some names are kept out by their shape alone (`*.pem`, `id_rsa*`), which
 * catches test fixtures too; the refusal says so, so a missing file has a
 * visible reason.
 * Beyond names, the folder under the home directory where the desktop keeps
 * its keyrings. Lowerbeam's own state is not listed here: a run's workspace
 * lives in it. It is kept out by refusing it, and anything holding it, as a
 * project or an extra root.
 */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.password-store', '.docker'])
/** Folders that hold credentials only under their own parent: `.config/gh`, not every `gh`. */
const SECRET_NESTED = new Set(['.config/gh', '.config/gcloud'])
/** Package-manager and git settings files, which carry tokens as often as settings. */
const SECRET_FILES = new Set(['.npmrc', '.yarnrc.yml', '.netrc', '.git-credentials', '.pypirc'])
/**
 * Names that read as keys or credentials wherever they are. `secrets.*` is
 * the data formats only: a `secrets.ts` that loads them is code, and a task
 * may need it.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/^id_(rsa|ed25519|ecdsa|dsa)/, 'id_rsa*'],
  [/\.(pem|key|p12|pfx)$/i, '*.pem, *.key, *.p12 or *.pfx'],
  [/credentials.*\.json$/i, '*credentials*.json'],
  [/^secrets\.(json|ya?ml|toml|ini|env|txt|conf|cfg|properties|xml)$/i, 'secrets.*']
]

/** A template — `.env.example`, `secrets.sample.json` — holds the settings' names, not their values. */
function template(name: string): boolean {
  return /\.(example|sample|template)(\.|$)/i.test(name)
}

/** Why a name holds credentials, in words, or null. `parent` is the name of the folder it is in, when known. */
function secretName(name: string, parent?: string): string | null {
  if (SECRET_DIRS.has(name) || (parent !== undefined && SECRET_NESTED.has(`${parent}/${name}`))) return `${name} holds credentials`
  if (template(name)) return null
  if (SECRET_FILES.has(name) || name === '.env' || name === '.envrc' || name.startsWith('.env.')) return `${name} holds credentials`
  for (const [pattern, shape] of SECRET_PATTERNS) {
    if (pattern.test(name)) return `${name} is named like a key or credentials file (${shape}) and is kept out by name, test fixtures included`
  }
  return null
}

const SECRET_ROOTS = (() => {
  const homes = [homedir()]
  try {
    const real = realpathSync(homedir())
    if (real !== homes[0]) homes.push(real)
  } catch {
    /* no home: nothing anchored to it */
  }
  return homes.map((h) => join(h, '.local', 'share', 'keyrings'))
})()

/**
 * Why a path holds credentials and is not part of any grant, or null. `abs`
 * is the path; `rel` the part of it inside the granted root, whose every name
 * is checked.
 */
export function secretReason(abs: string, rel: string): string | null {
  const parts = rel.split(/[\\/]/)
  for (let i = 0; i < parts.length; i++) {
    const why = parts[i] ? secretName(parts[i]!, i > 0 ? parts[i - 1] : undefined) : null
    if (why) return `Not part of the grant: ${why}.`
  }
  for (const root of SECRET_ROOTS) {
    if (abs === root || abs.startsWith(root + sep)) return `Not part of the grant: ${abs} holds credentials.`
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return true
  } catch {
    return false
  }
}

export type Resolved =
  | { ok: true; path: string; relative: string }
  | { ok: false; denied: boolean; reason: string }
