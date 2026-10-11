/**
 * What a compaction record is allowed to keep once it no longer fits.
 *
 * Age is not the order. A constraint, a decision and a rejected option stay,
 * because losing one is how a later turn contradicts the thread. An artifact
 * stays while the turns still mention it, and a mention in three places
 * outranks a mention in one. A function body is a derivation: the signature
 * is what a later turn reuses, and the statements can be written again.
 * An open question stays until a later decision answers it.
 *
 * The notes already kept are not part of `source`. A fact that survives only
 * inside those notes is no longer referenced, and this is what stops a long
 * chat from appending the same path forever.
 */
import { summaryBudget } from './compact.js'
import { mechanicalText, type MechanicalRecord } from './extract.js'
import { compactionRecord, speechText, type Decision, type SpeechRecord } from './speech.js'

const SIGNATURE =
  /^(?:(?:static|extern|inline|const|unsigned|signed|struct|enum)\s+)*(?:void|int|char|long|short|float|double|size_t|bool|[A-Za-z_]\w*)\s+\**[A-Za-z_]\w*\s*\([^;{}]*\)\s*$/

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'does', 'did', 'will',
  'would', 'could', 'should', 'what', 'when', 'where', 'which', 'that', 'this', 'with', 'from',
  'about', 'into', 'than', 'then', 'them', 'they', 'their', 'there', 'your', 'how', 'why', 'who',
  'not', 'but', 'its', 'our'
])

export interface EvictionInput {
  speech: SpeechRecord
  mechanical: MechanicalRecord
  /** The turns being compacted, and not the notes an earlier compaction stored. */
  source: string
  budgetChars: number
}

export interface EvictionResult {
  speech: SpeechRecord
  mechanical: MechanicalRecord
  /** Spellings removed. A body reduced to its signature records the body. */
  dropped: string[]
}

interface Candidate {
  bucket: 'artifact' | 'command' | 'path' | 'flag' | 'interface' | 'error'
  text: string
  refs: number
  /** First appearance in the source. Equal counts drop the earlier one. */
  index: number
}

/** Characters the stored record may use, from the same window share as a summary. */
export function evictionBudgetChars(contextPerSlot: number | null): number {
  return summaryBudget(contextPerSlot).tokens * 4
}

/**
 * The signature, without the body.
 *
 * A line that is not a declaration is kept. Statements inside a body are
 * dropped, including a body written on the signature's own line.
 */
export function interfaceOnly(text: string): string {
  // Prose, paths and commands have no body. A brace means code, and then only
  // a declaration is reusable; the statements under it are a derivation.
  if (!text.includes('{')) return text.trim()
  const kept: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#\s*(?:include|define)\b/.test(line)) {
      kept.push(line)
      continue
    }
    const head = line.slice(0, line.indexOf('{') >= 0 ? line.indexOf('{') : line.length).trim()
    if (SIGNATURE.test(head)) kept.push(head)
  }
  return kept.join('\n')
}

/** How many times `fact` occurs in `source`, as its own spelling. */
export function referenceCount(fact: string, source: string): number {
  const needle = fact.trim()
  if (!needle) return 0
  let count = 0
  let from = 0
  while (from <= source.length) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

/**
 * The record that fits, with the policy applied.
 *
 * Constraints, decisions and rejections are kept even when they alone exceed
 * the budget. Everything else is kept only while it still fits, highest
 * reference count first.
 */
export function evictRecord(input: EvictionInput): EvictionResult {
  const dropped: string[] = []
  const questions = input.speech.openQuestions.filter((question) => {
    if (!questionAnswered(question, input.source, input.speech.decisions)) return true
    dropped.push(question)
    return false
  })
  const speech: SpeechRecord = { ...input.speech, openQuestions: questions, artifacts: [] }
  const mechanical: MechanicalRecord = { commands: [], paths: [], flags: [], interfaces: [], errors: [] }
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  const consider = (bucket: Candidate['bucket'], raw: string) => {
    const reduced = interfaceOnly(raw)
    if (reduced && reduced !== raw.trim()) dropped.push(raw.trim())
    for (const text of reduced.split('\n')) {
      const spelling = text.trim()
      if (!spelling || seen.has(spelling)) continue
      seen.add(spelling)
      const refs = referenceCount(spelling, input.source)
      if (refs === 0) {
        dropped.push(spelling)
        continue
      }
      candidates.push({ bucket, text: spelling, refs, index: input.source.indexOf(spelling) })
    }
  }
  for (const artifact of input.speech.artifacts) consider('artifact', artifact)
  for (const command of input.mechanical.commands) consider('command', command)
  for (const path of input.mechanical.paths) consider('path', path)
  for (const flag of input.mechanical.flags) consider('flag', flag)
  for (const iface of input.mechanical.interfaces) consider('interface', iface)
  for (const error of input.mechanical.errors) consider('error', error)

  const byPriority = [...candidates].sort((a, b) => b.refs - a.refs || b.index - a.index)
  const accepted = new Set<string>()
  if (rendered(speech, mechanical).length <= input.budgetChars) {
    const chosen: Candidate[] = []
    for (const candidate of byPriority) {
      chosen.push(candidate)
      const trial = appliedPair(speech, mechanical, chosen)
      if (rendered(trial.speech, trial.mechanical).length > input.budgetChars) {
        chosen.pop()
        dropped.push(candidate.text)
        continue
      }
      accepted.add(candidate.text)
    }
  } else {
    for (const candidate of candidates) dropped.push(candidate.text)
  }
  // Stored in the order they were extracted, which is the order they were said.
  for (const candidate of candidates) if (accepted.has(candidate.text)) add(speech, mechanical, candidate)
  return { speech, mechanical, dropped }
}

/** Protected text plus these spellings, without mutating the record being built. */
function appliedPair(
  speech: SpeechRecord,
  mechanical: MechanicalRecord,
  chosen: Candidate[]
): { speech: SpeechRecord; mechanical: MechanicalRecord } {
  const nextSpeech: SpeechRecord = { ...speech, artifacts: [...speech.artifacts] }
  const nextMechanical: MechanicalRecord = {
    commands: [...mechanical.commands],
    paths: [...mechanical.paths],
    flags: [...mechanical.flags],
    interfaces: [...mechanical.interfaces],
    errors: [...mechanical.errors]
  }
  for (const candidate of chosen) add(nextSpeech, nextMechanical, candidate)
  return { speech: nextSpeech, mechanical: nextMechanical }
}

function add(speech: SpeechRecord, mechanical: MechanicalRecord, candidate: Candidate): void {
  if (candidate.bucket === 'artifact') speech.artifacts.push(candidate.text)
  else if (candidate.bucket === 'command') mechanical.commands.push(candidate.text)
  else if (candidate.bucket === 'path') mechanical.paths.push(candidate.text)
  else if (candidate.bucket === 'flag') mechanical.flags.push(candidate.text)
  else if (candidate.bucket === 'interface') mechanical.interfaces.push(candidate.text)
  else mechanical.errors.push(candidate.text)
}

function rendered(speech: SpeechRecord, mechanical: MechanicalRecord): string {
  return compactionRecord(speechText(speech), mechanicalText(mechanical))
}

function questionAnswered(question: string, source: string, decisions: Decision[]): boolean {
  const asked = question.trim()
  const at = source.indexOf(asked)
  if (at < 0) return false
  const after = source.slice(at + asked.length)
  const askedWords = words(asked)
  for (const decision of decisions) {
    const present = [decision.chose, decision.because].map((part) => part.trim()).filter(Boolean)
    if (!present.some((part) => after.includes(part))) continue
    const span = present.join('\n')
    for (const word of words(span)) if (askedWords.has(word)) return true
  }
  return false
}

function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP.has(raw)) out.add(raw)
  }
  return out
}

