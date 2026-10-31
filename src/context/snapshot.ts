/**
 * A compaction record that is a snapshot, not a vague summary.
 *
 * The first message and a share of the newest turns stay verbatim. An
 * earlier snapshot's constraints are kept. Files and test results are
 * taken from the journal. A snapshot that is empty of a goal, or no
 * smaller than the turns it replaces, is refused.
 *
 * The idea is Gemini CLI's chat compression and OpenHands' summarizing
 * condenser. This is a new implementation. Chat keeps its prose record
 * unless a caller turns this on.
 */
import type { JournalEvent } from '@shared/coding.js'
import { unsupportedLines } from './verify.js'

/** Compact once the next request would use this much of the window. */
export const SNAPSHOT_TRIGGER_SHARE = 0.5
/** The newest share of turns left verbatim, besides the first user message. */
export const SNAPSHOT_KEEP_SHARE = 0.3

/** Same estimate the coding loop uses: code is nearer three characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

export interface SnapshotFile {
  path: string
  sha256: string | null
}

export interface SnapshotCommand {
  command: string
  exitCode: number | null
  passed: boolean
}

export interface RunSnapshot {
  goal: string
  constraints: string[]
  decisions: string[]
  filesChanged: SnapshotFile[]
  commands: SnapshotCommand[]
  openQuestions: string[]
  nextStep: string
}

export const SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, sha256: { type: 'string' } },
        required: ['path']
      }
    },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'number' },
          passed: { type: 'boolean' }
        },
        required: ['command', 'passed']
      }
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    nextStep: { type: 'string' }
  },
  required: ['goal', 'constraints', 'decisions', 'filesChanged', 'commands', 'openQuestions', 'nextStep']
} as const

export function renderSnapshot(snapshot: RunSnapshot): string {
  const lines = [
    'Snapshot of this run. It replaces the turns it names; the first message and the newest turns are still above and below.',
    `Goal: ${snapshot.goal}`,
    snapshot.constraints.length ? `Constraints: ${snapshot.constraints.join('; ')}.` : 'Constraints: none.',
    snapshot.decisions.length ? `Decisions: ${snapshot.decisions.join('; ')}.` : 'Decisions: none yet.',
    snapshot.filesChanged.length
      ? `Files changed: ${snapshot.filesChanged.map((file) => (file.sha256 ? `${file.path} (${file.sha256.slice(0, 12)})` : file.path)).join('; ')}.`
      : 'Files changed: none.',
    snapshot.commands.length
      ? `Commands: ${snapshot.commands.map((command) => `\`${command.command}\` → ${command.passed ? 'passed' : `exit ${command.exitCode ?? '?'}`}`).join('; ')}.`
      : 'Commands: none.',
    snapshot.openQuestions.length ? `Open questions: ${snapshot.openQuestions.join('; ')}.` : 'Open questions: none.',
    `Next step: ${snapshot.nextStep}`
  ]
  return lines.join('\n')
}

export function parseSnapshot(value: unknown): RunSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.goal !== 'string' || typeof record.nextStep !== 'string') return null
  if (!stringArray(record.constraints) || !stringArray(record.decisions) || !stringArray(record.openQuestions)) return null
  if (!Array.isArray(record.filesChanged) || !Array.isArray(record.commands)) return null
  const files: SnapshotFile[] = []
  for (const item of record.filesChanged) {
    if (!item || typeof item !== 'object') return null
    const file = item as { path?: unknown; sha256?: unknown }
    if (typeof file.path !== 'string' || !file.path) return null
    files.push({ path: file.path, sha256: typeof file.sha256 === 'string' ? file.sha256 : null })
  }
  const commands: SnapshotCommand[] = []
  for (const item of record.commands) {
    if (!item || typeof item !== 'object') return null
    const command = item as { command?: unknown; exitCode?: unknown; passed?: unknown }
    if (typeof command.command !== 'string' || typeof command.passed !== 'boolean') return null
    commands.push({
      command: command.command,
      exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
      passed: command.passed
    })
  }
  return {
    goal: record.goal.trim(),
    constraints: record.constraints as string[],
    decisions: record.decisions as string[],
    filesChanged: files,
    commands,
    openQuestions: record.openQuestions as string[],
    nextStep: record.nextStep.trim()
  }
}

/**
 * Carry every earlier constraint forward.
 *
 * A later snapshot may add constraints. It may not drop one: the journal
 * is what says a constraint is finished, and this check does not guess.
 */
export function mergeConstraints(previous: RunSnapshot | null, next: RunSnapshot): RunSnapshot {
  if (!previous) return next
  const constraints = [...previous.constraints]
  for (const constraint of next.constraints) {
    if (!constraints.includes(constraint)) constraints.push(constraint)
  }
  return { ...next, constraints }
}

export interface JournalFacts {
  filesChanged: SnapshotFile[]
  commands: SnapshotCommand[]
}

/**
 * Files and commands as the journal recorded them, which win over the model.
 *
 * A hash comes from an apply in the journal, or from the workspace manifest.
 * The tool result's summary is not a hash. A path or a hash that the journal
 * and the manifest do not both contain is left out, by the same line check a
 * compaction record uses.
 */
export function factsFromJournal(
  events: readonly JournalEvent[],
  manifest: Readonly<Record<string, string>> = {}
): JournalFacts {
  const calls = new Map<string, JournalEvent & { type: 'tool.call' }>()
  const applied = new Map<string, string | null>()
  const files: SnapshotFile[] = []
  const commands: SnapshotCommand[] = []
  for (const event of events) {
    if (event.type === 'tool.call') calls.set(event.callId, event)
    if (event.type === 'applied') {
      for (const file of event.files) applied.set(file.path, file.sha256)
    }
    if (event.type === 'tool.result' && event.ok) {
      const call = calls.get(event.callId)
      if (!call || (call.name !== 'edit_file' && call.name !== 'write_file')) continue
      const path = typeof call.args.path === 'string' ? call.args.path : ''
      if (!path || files.some((file) => file.path === path)) continue
      files.push({ path, sha256: null })
    }
    if (event.type === 'command.finished') {
      commands.push({
        command: event.command,
        exitCode: event.exitCode,
        passed: event.exitCode === 0 && !event.timedOut
      })
    }
  }
  const source = [
    ...events.filter((event) => event.type !== 'tool.result').map((event) => JSON.stringify(event)),
    ...Object.entries(manifest).flatMap(([path, hash]) => [path, hash])
  ].join('\n')
  const kept: SnapshotFile[] = []
  for (const file of files) {
    if (unsupportedLines(file.path, source).length) continue
    const hash = applied.get(file.path) ?? manifest[file.path] ?? null
    const usable = hash !== null && unsupportedLines(hash, source).length === 0 ? hash : null
    kept.push({ path: file.path, sha256: usable })
  }
  return { filesChanged: kept, commands }
}

export type SnapshotVerdict = { ok: true; snapshot: RunSnapshot } | { ok: false; reason: string }

/**
 * Accept a snapshot only when it can stand in for the turns.
 *
 * Files and commands are corrected from the journal first. A hash comes
 * from an apply, or from the workspace manifest of files the run has
 * already changed. The goal has to be there, and the rendered snapshot
 * has to be smaller than the text it replaces.
 */
export function acceptSnapshot(
  proposed: RunSnapshot | null,
  previous: RunSnapshot | null,
  events: readonly JournalEvent[],
  replacedText: string,
  manifest: Readonly<Record<string, string>> = {}
): SnapshotVerdict {
  if (!proposed) return { ok: false, reason: 'The snapshot was not the shape asked for.' }
  const merged = mergeConstraints(previous, proposed)
  const facts = factsFromJournal(events, manifest)
  const snapshot: RunSnapshot = {
    ...merged,
    goal: merged.goal.trim(),
    nextStep: merged.nextStep.trim(),
    filesChanged: facts.filesChanged,
    commands: facts.commands
  }
  if (!snapshot.goal) return { ok: false, reason: 'The snapshot had no goal.' }
  if (estimateTokens(renderSnapshot(snapshot)) >= estimateTokens(replacedText)) {
    return { ok: false, reason: 'The snapshot was no smaller than the turns it would replace.' }
  }
  return { ok: true, snapshot }
}

/**
 * The first user message, plus the newest share of the turns after it.
 *
 * The kept tail does not open on a tool result whose call was dropped.
 * The cut moves back to include that call.
 */
export function keptTurnIndexes(countOrTurns: number | readonly { role: string }[], keepShare = SNAPSHOT_KEEP_SHARE): number[] {
  const turns = typeof countOrTurns === 'number' ? null : countOrTurns
  const count = typeof countOrTurns === 'number' ? countOrTurns : countOrTurns.length
  if (count <= 2) return Array.from({ length: count }, (_, index) => index)
  const body = count - 2
  const keep = Math.max(1, Math.ceil(body * keepShare))
  let start = count - keep
  if (turns) {
    while (start > 2 && turns[start]?.role === 'tool') start -= 1
  }
  const recent: number[] = []
  for (let index = start; index < count; index++) if (index > 1) recent.push(index)
  return [0, 1, ...recent]
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
