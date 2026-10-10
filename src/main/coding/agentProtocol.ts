import type { CodingMode, GrantTerms, JournalEvent } from '@shared/coding.js'
import type { ChatSettingsView } from '@shared/types.js'
import type { Executed, RunResult } from '../../agent/loop.js'

/**
 * What a coding run sends to the utility process that runs the loop.
 *
 * The grant is opened there from `grantRoot`. Callbacks do not cross: events,
 * the model's words and commands come back as messages.
 */
export interface AgentJob {
  baseUrl: string
  apiKey: string | null
  model: string
  requestModel: string | null
  task: string
  /** The workspace copy for an edit or run, and the project for an inspect. */
  grantRoot: string
  mode: CodingMode
  /** Further roots the run may read, already accepted by the main process. */
  alsoRead: string[]
  settings: ChatSettingsView
  maxRounds: number
  timeoutMs: number
  runId: string
  contextLimit: number | null
  terms: GrantTerms
}

export type ParentToChild =
  | { type: 'start'; job: AgentJob }
  | { type: 'cancel' }
  | { type: 'exec-result'; id: string; ok: true; result: Executed }
  | { type: 'exec-result'; id: string; ok: false; error: string }
  | { type: 'kept'; round: number; error?: string }

export type ChildToParent =
  | { type: 'event'; event: JournalEvent }
  | { type: 'keep'; round: number; words: { reasoning: string; content: string } }
  | { type: 'exec'; id: string; command: string }
  | { type: 'exec-abort'; id: string }
  | { type: 'result'; result: RunResult }
  | { type: 'error'; message: string }

/** The main process's side of the utility process. */
export interface AgentPort {
  postMessage(message: ParentToChild): void
  onMessage(listener: (message: ChildToParent) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

/** The utility process's side. */
export interface ChildPort {
  postMessage(message: ChildToParent): void
  onMessage(listener: (message: ParentToChild) => void): void
}

/** How long a cancel may wait for the loop to finish before the process is killed. */
export const CANCEL_GRACE_MS = 15_000
