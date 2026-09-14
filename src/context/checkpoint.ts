import type { Checkpoint, JournalEvent } from '@shared/coding.js'
import type { ChatTurn } from '@shared/chatClient.js'

/**
 * A coding run's memory, projected from its journal.
 *
 * When a run's window fills past what folding can hold, everything before the
 * newest round is replaced by notes. In chat those notes are a summary the
 * model writes; here they are not. A coding run's turns are tool calls and
 * their results, and the journal already holds every path, query, edit, exit
 * code and refusal in structured form — so the record is computed from it,
 * costs no model time, and can be checked line by line against its source.
 * The task itself stays in the prompt word for word; it is never summarised.
 *
 * What is lost is the body of every tool result. That is the intended loss:
 * anything consequential is read again from the file rather than trusted from
 * memory, and the notes say so.
 */

/**
 * How recently the model must have spoken for its words to count as intent.
 *
 * Transient means replaced every step, and an intent nothing replaces is
 * worse than none: in one run the model said on round 5 that it would check
 * how the harness runs the suite, said nothing new for eleven rounds, and
 * five successive checkpoints handed that same sentence back to it. A plan
 * the model has not restated is not what it is doing now.
 */
export const INTENT_FRESH_ROUNDS = 2

export function checkpointFrom(events: JournalEvent[], throughSeq: number = Number.POSITIVE_INFINITY): Checkpoint {
  const covered = events.filter((e) => e.seq <= throughSeq)
  const calls = new Map<string, Extract<JournalEvent, { type: 'tool.call' }>>()
  const read = new Map<string, string | null>()
  const searched: Checkpoint['searched'] = []
  const changed = new Map<string, Checkpoint['changed'][number]>()
  const commands: Checkpoint['commands'] = []
  const failures: Array<{ seq: number; text: string }> = []
  let intent: Checkpoint['intent'] = null
  let lastEditSeq = -1
  let lastCommand: { seq: number; command: string; exitCode: number | null; timedOut: boolean } | null = null
  let rounds = 0
  let last = -1

  for (const e of covered) {
    last = Math.max(last, e.seq)
    switch (e.type) {
      case 'model.request':
        rounds = Math.max(rounds, e.round)
        break
      case 'model.response':
        // Transient: the newest one stands, the one before it is gone.
        if (e.say) intent = { round: e.round, text: e.say }
        break
      case 'tool.call':
        calls.set(e.callId, e)
        break
      case 'tool.result': {
        const call = calls.get(e.callId)
        if (!call) break
        if (!e.ok) {
          failures.push({ seq: e.seq, text: `${call.name}: ${e.summary}` })
          break
        }
        const path = typeof call.args['path'] === 'string' ? call.args['path'] : null
        if (call.name === 'read' && path) {
          read.set(path, rangeOf(call.args, e.summary))
        } else if (call.name === 'search') {
          searched.push({ query: String(call.args['query'] ?? ''), result: e.summary })
        } else if ((call.name === 'edit_file' || call.name === 'write_file') && path) {
          const how = e.summary.startsWith('Created') ? 'created' : e.summary.startsWith('Overwrote') ? 'overwrote' : 'edited'
          const entry = changed.get(path)
          if (entry) {
            entry.times += 1
            if (how !== 'edited') entry.how = how
          } else changed.set(path, { path, how, times: 1 })
          lastEditSeq = e.seq
        }
        break
      }
      case 'command.finished':
        commands.push({ command: e.command, exitCode: e.exitCode, timedOut: e.timedOut })
        lastCommand = { seq: e.seq, command: e.command, exitCode: e.exitCode, timedOut: e.timedOut }
        break
      default:
        break
    }
  }

  // Verification is of a change: before any edit, a command is just a
  // command, and its exit code is on the commands line. Read this way, a
  // green suite run before the bug was touched cannot read as a fix checked.
  const verification: Checkpoint['verification'] =
    lastCommand === null || lastEditSeq < 0
      ? { status: 'none', command: null }
      : lastCommand.seq < lastEditSeq
        ? { status: 'stale', command: lastCommand.command }
        : { status: lastCommand.exitCode === 0 && !lastCommand.timedOut ? 'passed' : 'failed', command: lastCommand.command }

  return {
    throughSeq: last,
    rounds,
    read: [...read].map(([path, range]) => ({ path, range })),
    searched,
    changed: [...changed.values()],
    commands,
    verification,
    // Only what is still unresolved: a refusal answered by a later successful
    // edit of the same kind is history, and the last few are what matter.
    problems: failures.filter((f) => f.seq > lastEditSeq).slice(-3).map((f) => f.text),
    intent: intent && intent.round > rounds - INTENT_FRESH_ROUNDS ? intent : null
  }
}

/** "lines 40–120 of 312" from the call's arguments and the result's header. */
function rangeOf(args: Record<string, unknown>, header: string): string | null {
  const total = /\((\d+) lines/.exec(header)?.[1]
  const start = typeof args['start'] === 'number' ? args['start'] : 1
  const end = typeof args['end'] === 'number' ? args['end'] : null
  if (!total) return null
  if (start === 1 && (end === null || end >= Number(total))) return Number(total) <= 200 ? `all ${total} lines` : `lines 1–${Math.min(200, Number(total))} of ${total}`
  return `lines ${start}–${end ?? Math.min(start + 199, Number(total))} of ${total}`
}

/**
 * The notes as the model reads them: prose from a fixed template, so the
 * record's shape is chosen for checking and the prompt's for reading.
 */
export function renderCheckpoint(c: Checkpoint): string {
  const lines: string[] = [
    `Notes on this run so far, after ${c.rounds} round${c.rounds === 1 ? '' : 's'}. The output of earlier tool calls is no longer shown; read a file again if you need what is in it.`,
    ''
  ]
  lines.push(c.read.length ? `Files read: ${c.read.map((r) => (r.range ? `${r.path} (${r.range})` : r.path)).join('; ')}.` : 'No files read yet.')
  if (c.searched.length) lines.push(`Searches: ${c.searched.map((s) => `"${s.query}" → ${s.result}`).join('; ')}.`)
  lines.push(
    c.changed.length
      ? `Changes made so far, in the copy: ${c.changed.map((f) => `${f.path} (${f.how}${f.times > 1 ? ` ${f.times} times` : ''})`).join('; ')}.`
      : 'No files changed yet.'
  )
  if (c.commands.length) {
    lines.push(`Commands run: ${c.commands.map((k) => `\`${k.command}\` → ${k.timedOut ? 'timed out' : `exit ${k.exitCode ?? '?'}`}`).join('; ')}.`)
  }
  const v = c.verification
  lines.push(
    v.status === 'passed'
      ? `Verification: \`${v.command}\` passed after the last edit.`
      : v.status === 'failed'
        ? `Verification: \`${v.command}\` failed after the last edit; its output is not kept here, so run it again to see why.`
        : v.status === 'stale'
          ? 'Verification: nothing has been run since the last edit.'
          : c.changed.length
            ? 'Verification: nothing has been run since the change was made.'
            : ''
  )
  if (c.problems.length) lines.push(`Unresolved: ${c.problems.join('; ')}.`)
  // Last, because it is the most recent thing and the one the next round
  // continues from. In the model's own words, quoted, not paraphrased.
  if (c.intent) lines.push(`On round ${c.intent.round} you said: "${c.intent.text}"`)
  return lines.filter((l, i) => l !== '' || i === 1).join('\n')
}

/**
 * What a write run is told, once, when it has spent half its rounds without
 * changing anything.
 *
 * Measured before this existed: in the crossover family about four runs in
 * ten never called an edit tool, and none of those answered in prose — every
 * one called a tool each round to the limit, the file with the bug among
 * the ones it had read. A reminder at answer time had been tried and never
 * fired; this one fires mid-run. It is rendered from the record, not
 * written by the model, so what it says the run has done is what the
 * journal shows.
 */
export function renderReminder(c: Checkpoint, roundsLeft: number): string {
  const lines: string[] = [
    `You have used ${c.rounds} round${c.rounds === 1 ? '' : 's'} and changed nothing yet; ${roundsLeft} remain${roundsLeft === 1 ? 's' : ''}.`
  ]
  lines.push(c.read.length ? `Files read: ${c.read.map((r) => (r.range ? `${r.path} (${r.range})` : r.path)).join('; ')}.` : 'No files read yet.')
  if (c.searched.length) lines.push(`Searches: ${c.searched.map((s) => `"${s.query}" → ${s.result}`).join('; ')}.`)
  if (c.commands.length) {
    lines.push(`Commands run: ${c.commands.map((k) => `\`${k.command}\` → ${k.timedOut ? 'timed out' : `exit ${k.exitCode ?? '?'}`}`).join('; ')}.`)
  }
  if (c.problems.length) lines.push(`Unresolved: ${c.problems.join('; ')}.`)
  lines.push(
    'If the cause is in a file you have read, change it now with edit_file: read the passage once more if you need its exact text, then replace it. ' +
      'If it is not, name the one file you still need and read that. The task is a change to the code, and it is not done until a file has changed.'
  )
  return lines.join('\n')
}

/**
 * Every claim in a record must be something the journal recorded up to the
 * sequence the record covers. Returns the claims it could not find. Empty
 * for a record this module built — the check is for records that came from
 * anywhere else, a model included, and for tests of this module.
 */
export function verifyCheckpoint(c: Checkpoint, events: JournalEvent[]): string[] {
  const covered = events.filter((e) => e.seq <= c.throughSeq)
  type Call = Extract<JournalEvent, { type: 'tool.call' }>
  const calls = new Map<string, Call>()
  for (const e of covered) if (e.type === 'tool.call') calls.set(e.callId, e)
  const okCalls: Call[] = []
  for (const e of covered) {
    if (e.type !== 'tool.result' || !e.ok) continue
    const call = calls.get(e.callId)
    if (call) okCalls.push(call)
  }
  const finished = covered.filter((e): e is Extract<JournalEvent, { type: 'command.finished' }> => e.type === 'command.finished')
  const unsupported: string[] = []
  for (const r of c.read) {
    if (!okCalls.some((k) => k.name === 'read' && k.args['path'] === r.path)) unsupported.push(`read ${r.path}`)
  }
  for (const s of c.searched) {
    if (!okCalls.some((k) => k.name === 'search' && k.args['query'] === s.query)) unsupported.push(`search "${s.query}"`)
  }
  for (const f of c.changed) {
    if (!okCalls.some((k) => (k.name === 'edit_file' || k.name === 'write_file') && k.args['path'] === f.path)) unsupported.push(`changed ${f.path}`)
  }
  for (const k of c.commands) {
    if (!finished.some((e) => e.command === k.command && e.exitCode === k.exitCode)) unsupported.push(`command ${k.command} → ${k.exitCode}`)
  }
  if (c.verification.command !== null && !finished.some((e) => e.command === c.verification.command)) {
    unsupported.push(`verification by ${c.verification.command}`)
  }
  if (c.intent && !covered.some((e) => e.type === 'model.response' && e.say === c.intent!.text && e.round === c.intent!.round)) {
    unsupported.push(`said on round ${c.intent.round}`)
  }
  return unsupported
}

/**
 * The turns a run continues with after compaction: the policy and the task
 * exactly as they were (the first two turns, whose prefix the server still
 * has cached), the notes, and the newest round whole — unless even that
 * round is too much, in which case its results go to their first line as
 * well and the model reads again what it needs. An earlier notes turn is
 * dropped: the new record covers everything the old one did.
 */
export function compactWorkingSet(turns: ChatTurn[], notes: string, foldNewest: boolean): ChatTurn[] {
  let lastRound = -1
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.role === 'assistant' && turns[i]!.toolCalls?.length) lastRound = i
  }
  const tail = lastRound < 0 ? [] : turns.slice(lastRound)
  const folded = foldNewest
    ? tail.map((t) => {
        if (t.role !== 'tool') return t
        const firstLine = t.content.split('\n')[0] ?? ''
        return t.content.length <= firstLine.length + 1 ? t : { ...t, content: `${firstLine}\n(result folded — ask again to see it in full)` }
      })
    : tail
  return [...turns.slice(0, 2), { role: 'system', content: notes }, ...folded]
}
