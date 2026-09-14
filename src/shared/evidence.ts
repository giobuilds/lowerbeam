/**
 * Test evidence: what a run's command output shows, read against the record.
 *
 * A green suite after an edit proves less than it looks, two ways. Failures
 * that were there before the run began are not the run's, and a pass that
 * came from editing the tests is not a pass. Both are decidable from what
 * the journal and the workspace already hold: the commands the run made, in
 * order, either side of its last edit; the output of each, kept beside the
 * journal; and the files the run changed. The verification is the last
 * command after the last edit. The baseline is the same command before any
 * edit — from the run's own record when the model ran it first, which it
 * usually does, and otherwise from one rerun on a copy of the project as it
 * was, which the person asks for. Failure lines are matched by a heuristic
 * over common runners' vocabulary and compared as sets; that is stated,
 * not hidden, and the outputs themselves are a click away.
 */

import type { JournalEvent } from './coding.js'

export interface CommandEvidence {
  command: string
  exitCode: number | null
  timedOut: boolean
  /** Lines of the output that look like failures, normalised, in order of first appearance. */
  failures: string[]
  /** False when the output was not kept, in which case `failures` is empty and says nothing. */
  outputAvailable: boolean
}

export interface Evidence {
  /** Whether the run changed any file at all; without that there is nothing to verify. */
  edited: boolean
  /** The last command run after the last edit; null when nothing was run after a change, or nothing changed. */
  verification: CommandEvidence | null
  /** The same command before any edit — from the record, or from a rerun on the baseline. */
  baseline: (CommandEvidence & { source: 'record' | 'rerun' }) | null
  /** Failure lines in the verification and not in the baseline: the run's own. */
  newFailures: string[]
  /** In both: there before the run began. */
  preexisting: string[]
  /** In the baseline and not in the verification. */
  fixed: string[]
  /** Test files among the run's changes: a pass proves less. */
  testFilesChanged: string[]
  /** When the baseline was rerun: project files that no longer match the run's baseline, so the rerun was against the project as it is now. */
  drifted: string[]
}

/** A file a test runner would treat as a test, by the conventions most runners share. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|specs?|testdata|fixtures)\//i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.(go|py|rb|rs|c|cc|cpp)$/.test(path) ||
    /(^|\/)[^/]*[._-]spec\.rb$/.test(path)
  )
}

const FAILURE = /(^|[^A-Za-z])(FAIL|FAILED|FAILURE|ERROR|Error|error|AssertionError|not ok|Traceback|panic)([^A-Za-z]|$)|✗|✖|✘/
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const TIMING = /\s*\(?\b\d+(?:\.\d+)?\s*m?s\)?$/
const STAMP = /^\[?\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]?\s*/

/** The lines of a command's output that look like failures, normalised so runs compare. */
export function failureLines(output: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').replace(STAMP, '').replace(TIMING, '').replace(/\s+/g, ' ').trim()
    if (!line || !FAILURE.test(line)) continue
    // Summary counts are not failures: "0 errors", "no failures".
    if (/^(0|no)\s+(errors?|failures?)/i.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** Two outputs' failure lines as sets: what is new, what was already there, what went away. */
export function classifyFailures(before: string[], after: string[]): { newFailures: string[]; preexisting: string[]; fixed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return {
    newFailures: after.filter((l) => !b.has(l)),
    preexisting: after.filter((l) => b.has(l)),
    fixed: before.filter((l) => !a.has(l))
  }
}

/**
 * The same command, allowing for how a model keeps output short: a trailing
 * `| head -50` or `2>&1 | tail -30` does not make it a different test run.
 */
export function sameCommand(a: string, b: string): boolean {
  return normaliseCommand(a) === normaliseCommand(b)
}
function normaliseCommand(command: string): string {
  return command
    .replace(/\s*(2>&1)?\s*\|\s*(head|tail)\b[^|]*$/, '')
    .replace(/\s*2>&1\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A finished command as the journal recorded it, with its position among the run's commands. */
interface Finished {
  index: number
  seq: number
  command: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * The evidence a run's record holds, with the outputs of its commands
 * supplied by position (1-based, in the order the journal has them) — null
 * where the output was not kept.
 */
export function evidenceFrom(events: JournalEvent[], outputs: Record<number, string | null>, changed: string[]): Evidence {
  const calls = new Map<string, string>()
  const commands: Finished[] = []
  let firstEdit = -1
  let lastEdit = -1
  for (const e of events) {
    if (e.type === 'tool.call') calls.set(e.callId, e.name)
    else if (e.type === 'tool.result' && e.ok) {
      const name = calls.get(e.callId)
      if (name === 'edit_file' || name === 'write_file') {
        if (firstEdit < 0) firstEdit = e.seq
        lastEdit = e.seq
      }
    } else if (e.type === 'command.finished') {
      commands.push({ index: commands.length + 1, seq: e.seq, command: e.command, exitCode: e.exitCode, timedOut: e.timedOut })
    }
  }
  const evidenceOf = (c: Finished): CommandEvidence => {
    const output = outputs[c.index] ?? null
    return { command: c.command, exitCode: c.exitCode, timedOut: c.timedOut, failures: output === null ? [] : failureLines(output), outputAvailable: output !== null }
  }
  const testFilesChanged = changed.filter(isTestPath)
  const after = lastEdit < 0 ? null : (commands.filter((c) => c.seq > lastEdit).at(-1) ?? null)
  const edited = lastEdit >= 0
  if (!after) return { edited, verification: null, baseline: null, newFailures: [], preexisting: [], fixed: [], testFilesChanged, drifted: [] }
  const verification = evidenceOf(after)
  const before = commands.filter((c) => c.seq < firstEdit && sameCommand(c.command, after.command)).at(-1) ?? null
  const baseline = before ? { ...evidenceOf(before), source: 'record' as const } : null
  const classes =
    baseline && baseline.outputAvailable && verification.outputAvailable
      ? classifyFailures(baseline.failures, verification.failures)
      : { newFailures: [], preexisting: [], fixed: [] }
  return { edited, verification, baseline, ...classes, testFilesChanged, drifted: [] }
}

/** The evidence with a baseline rerun in place of whatever the record had. */
export function withRerun(
  evidence: Evidence,
  rerun: { command: string; exitCode: number | null; timedOut: boolean; output: string; drifted: string[] }
): Evidence {
  const baseline = { command: rerun.command, exitCode: rerun.exitCode, timedOut: rerun.timedOut, failures: failureLines(rerun.output), outputAvailable: true, source: 'rerun' as const }
  const classes = evidence.verification?.outputAvailable ? classifyFailures(baseline.failures, evidence.verification.failures) : { newFailures: [], preexisting: [], fixed: [] }
  return { ...evidence, baseline, ...classes, drifted: rerun.drifted }
}
