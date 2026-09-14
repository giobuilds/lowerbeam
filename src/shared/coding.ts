/**
 * The record of a coding run.
 *
 * Every event a run produces is appended here before its side effect, with a
 * run id, a sequence number and a timestamp, so the interface can reconnect
 * without inventing state, a crash leaves an honest trail, and a compaction
 * record can be checked against what actually happened rather than against
 * what the model says happened.
 *
 * Versioned from the start: the journal outlives whichever engine wrote it.
 */

export const JOURNAL_VERSION = 1

interface Base {
  v: typeof JOURNAL_VERSION
  run: string
  seq: number
  /** ms since epoch */
  ts: number
}

export interface TokenCount {
  promptTokens: number
  predictedTokens: number
  /** The prefix the server already held; with the other two, the window's occupancy. */
  cacheTokens?: number
}

export type JournalEvent =
  | (Base & {
      type: 'run.started'
      task: string
      model: string
      grantRoot: string
      mode?: CodingMode
      /** What the run may reach beyond the project, when anything. Absent means the defaults. */
      grant?: GrantTerms
    })
  | (Base & {
      type: 'model.request'
      round: number
      turns: number
      tools: string[]
      /** Older tool results sent as their first line only, to stay inside the window. */
      folded?: number
    })
  | (Base & {
      type: 'model.response'
      round: number
      contentChars: number
      /**
       * What the model said in prose alongside its tool calls, bounded. Kept
       * because it is the only thing in a coding run the model says in its
       * own words, and a record that carries it has to be checkable against
       * the journal like everything else.
       */
      say?: string
      reasoningChars: number
      toolCalls: number
      usage: TokenCount | null
      finishReason: string | null
      ms: number
    })
  | (Base & {
      type: 'tool.call'
      callId: string
      name: string
      args: Record<string, unknown>
    })
  | (Base & {
      type: 'tool.result'
      callId: string
      ok: boolean
      /** The call asked for something outside the grant and was refused. */
      denied: boolean
      summary: string
      chars: number
    })
  | (Base & {
      /** A command the run executed in the sandbox. Full output is an artifact; this is the account of it. */
      type: 'command.finished'
      command: string
      exitCode: number | null
      ms: number
      timedOut: boolean
      /** Bytes of output kept, and whether more was dropped. */
      outputBytes: number
      truncated: boolean
    })
  | (Base & {
      /**
       * The working set was rebuilt from the record: everything before the
       * newest round replaced by these notes, projected from the journal up
       * to `throughSeq` with no model involved.
       */
      type: 'checkpoint'
      throughSeq: number
      record: Checkpoint
      /** What made it happen: the window filling, or the server refusing a request that overflowed it. */
      reason: 'window' | 'overflow'
      /** The window's occupancy as last measured before the rebuild, when known. */
      occupancy: number | null
      /** Characters of prose the notes render to. */
      chars: number
      /** The run's round limit after this compaction: re-reading costs rounds, and they are given back. */
      roundsAllowed?: number
    })
  | (Base & {
      /**
       * A write run reached the middle of its rounds without changing a
       * file, and was told so once: what the record shows it has read,
       * searched and run, and that the task is a change. Projected from the
       * journal like the notes, so the claim is checkable the same way.
       */
      type: 'reminder'
      /** The round the reminder precedes. */
      round: number
      throughSeq: number
      record: Checkpoint
      /** Characters of prose the reminder renders to. */
      chars: number
    })
  | (Base & {
      type: 'run.finished'
      outcome: RunOutcome
      answer: string
      rounds: number
      ms: number
      tokens: TokenCount
      /** Tool calls refused for reaching outside the grant. */
      denials: number
    })

export type RunOutcome =
  /** The model stopped calling tools and gave an answer. */
  | 'answered'
  /** The model used every round without answering. */
  | 'rounds'
  | 'timeout'
  | 'cancelled'
  | 'error'

/**
 * What a run may do. `inspect` is list, search and read inside the project.
 * `edit` adds write_file and edit_file — against an isolated copy of the
 * project, never the project itself; the person applies the result. `run`
 * adds run_command: commands in that copy, inside a sandbox with no network,
 * which is how the model gets to run the tests on its own change.
 */
export type CodingMode = 'inspect' | 'edit' | 'run'

/**
 * The terms of a run's grant beyond the mode: what else it may reach.
 *
 * Additional access is a visible change to the run's grant, set before the
 * run starts, recorded in its journal and enforced by the grant and the
 * sandbox — never an approval button that turns a scoped job into host
 * execution. Each term is off unless the person turns it on for a run, and
 * a term the machine cannot honour stays unavailable.
 */
export interface GrantTerms {
  /** Directories outside the project the run may read, never write. Resolved and checked like the root. */
  alsoRead: string[]
  /** Commands in the sandbox may reach the network. */
  network: boolean
  /**
   * Commands may install dependencies: writes to node_modules land in the
   * copy, on top of the project's tree, which is never written. An install
   * usually needs the network as well.
   */
  install: boolean
}

export const DEFAULT_TERMS: GrantTerms = { alsoRead: [], network: false, install: false }

export function sameTerms(a: GrantTerms, b: GrantTerms): boolean {
  return a.network === b.network && a.install === b.install && a.alsoRead.length === b.alsoRead.length && a.alsoRead.every((d, i) => d === b.alsoRead[i])
}

/** The terms as a sentence or two, for the run's header and the model's instructions. Empty when nothing beyond the mode is granted. */
export function describeTerms(terms: GrantTerms, mode: CodingMode): string {
  const parts: string[] = []
  if (terms.alsoRead.length) parts.push(`You may also read, but not change, ${terms.alsoRead.map((d) => `\`${d}\``).join(' and ')}; refer to files there by their full path.`)
  if (mode === 'run') {
    if (terms.network) parts.push('Commands may use the network.')
    if (terms.install) parts.push('Commands may install dependencies into the copy, on top of what the project already has; the project\u2019s own dependency tree is not changed.')
  }
  return parts.join(' ')
}

export type ChangeKind = 'created' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  kind: ChangeKind
  /** A unified diff against the baseline, or '(binary)'. Empty for a deletion. */
  diff: string
}

export interface ChangeSet {
  files: FileChange[]
  /** When the baseline was taken, so "since the run began" has a time. */
  baselineAt: number
}

export interface ApplyResult {
  applied: string[]
  /** Files left alone, and why. Nothing is merged and nothing is guessed. */
  conflicts: Array<{ path: string; reason: string }>
}

/** What the interface needs to list runs and show one, without the whole journal. */
export interface CodingRunSummary {
  id: string
  task: string
  projectRoot: string
  mode: CodingMode
  /** Set once an edit run's changes have been applied to the project. */
  appliedAt: number | null
  model: string
  startedAt: number
  finishedAt: number | null
  outcome: RunOutcome | 'running'
  answer: string
  rounds: number
  denials: number
  /** The terms the run had beyond its mode. */
  grant: GrantTerms
}

export interface CodingStartRequest {
  projectRoot: string
  task: string
  mode: CodingMode
  grant?: GrantTerms
}

/** What a tool hands back to the loop. Text is what the model sees; the rest is for the journal. */
export interface AgentToolResult {
  ok: boolean
  denied?: boolean
  content: string
}

/**
 * What a coding run knows about itself once its older turns are gone: a
 * projection of the journal, not a summary by the model. Facts (the task) stay
 * verbatim in the prompt and are not repeated here; this is the state —
 * what was read, what changed, what ran, and whether the change was checked.
 * Every entry names something the journal records, which is what makes it
 * checkable.
 */
export interface Checkpoint {
  /** The last journal sequence the record covers, inclusive. */
  throughSeq: number
  rounds: number
  /** Files read, in order of first reading, with the last range shown. */
  read: Array<{ path: string; range: string | null }>
  /** Searches made, with the first line of what came back. */
  searched: Array<{ query: string; result: string }>
  /** Files the run has changed in its copy, by successful edit or write. State: reflects the record, not memory. */
  changed: Array<{ path: string; how: 'edited' | 'created' | 'overwrote'; times: number }>
  /** Commands run, oldest first. */
  commands: Array<{ command: string; exitCode: number | null; timedOut: boolean }>
  /**
   * Whether the change has been checked: `passed`/`failed` is the last command
   * run after the last edit; `stale` means commands ran but none since the
   * last edit; `none` means nothing has been run.
   */
  verification: { status: 'none' | 'passed' | 'failed' | 'stale'; command: string | null }
  /** The most recent refused or failed tool calls, oldest first. */
  problems: string[]
  /**
   * Transient: what the model last said it was doing, in its own words, and
   * the round it said it on. Replaced at every checkpoint, never accumulated.
   */
  intent: { round: number; text: string } | null
}
