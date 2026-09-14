/**
 * The capability record: what has been measured on a model, and what that
 * clears it to do.
 *
 * The architecture asks for one and the plan names what goes in it: one
 * recorded configuration per model — file hash, launch, llama.cpp build,
 * context, sampling — and the harness's numbers against it. A model is its
 * file: a different quantisation is a different entry, because the one-bit
 * 27B was broken where the four-bit 9B was not. An entry says per mode
 * whether the model is cleared, refused, or unmeasured, and cites the
 * measurement either way; the interface shows the citation and the main
 * process refuses a mode the record refuses. A file the record does not
 * hold is *unmeasured*, not refused: every mode is offered, labelled as
 * such, and the journal is the only evidence there is.
 */

import type { CodingMode } from './coding.js'

export type Verdict = 'cleared' | 'refused' | 'unmeasured'

export interface ModeVerdict {
  verdict: Verdict
  /** The measurement this rests on, in one sentence a person can check against the results. */
  evidence: string
}

export interface FamilyResult {
  family: string
  /** Passes over the runs or tasks the family counts in. */
  passed: number
  of: number
  unit: 'runs' | 'tasks'
  note?: string
}

export interface ModelCapability {
  /** The harness's key for the model. */
  key: string
  /** The file name, which is how the interface names a model. */
  name: string
  sha256: string
  bytes: number
  measured: {
    /** ISO date of the clean matrix the record rests on. */
    on: string
    /** llama.cpp build the model was measured under. */
    build: string
    launch: string[]
    context: number
    /** Where the numbers are written up. */
    results: string
  }
  families: FamilyResult[]
  modes: Record<CodingMode, ModeVerdict>
  /** Limits the measurements found that no mode verdict captures. */
  limits: string[]
}

/** What the coding tab is told about the model that is loaded. */
export type CapabilityStatus =
  | { state: 'none' }
  | { state: 'measured'; path: string; bytes: number; sha256: string; record: ModelCapability }
  | { state: 'unmeasured'; path: string; bytes: number; sha256: string }

const RESULTS = 'docs/stage0-results.md'
const BUILD = 'llama.cpp 0.4.0-dev (build 10826, commit 73a43d1f6)'

export const CAPABILITY_RECORD: ModelCapability[] = [
  {
    key: 'ornith-9b',
    name: 'Ornith-1.5-9B-Q4_K_M.gguf',
    sha256: '70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6',
    bytes: 5780090816,
    measured: {
      on: '2026-09-09',
      build: BUILD,
      launch: ['--gpu-layers', '999', '--ctx-size', '16384', '--reasoning-budget', '1024'],
      context: 16384,
      results: RESULTS
    },
    families: [
      { family: 'locate', passed: 17, of: 18, unit: 'runs' },
      { family: 'explain', passed: 12, of: 12, unit: 'runs' },
      { family: 'authority', passed: 9, of: 9, unit: 'runs', note: 'shown the planted instruction every time and followed it never' },
      { family: 'small-fix', passed: 4, of: 6, unit: 'tasks', note: 'by majority of three runs; unwanted changes in 0 of 33 write runs' },
      { family: 'cross-file', passed: 3, of: 4, unit: 'tasks', note: 'by majority of three runs' },
      { family: 'recover', passed: 3, of: 4, unit: 'tasks', note: 'by majority; every pass verified by a test run after the edit' },
      { family: 'crossover', passed: 41, of: 120, unit: 'runs', note: 'a window a third of the size; the record held in 120 of 120' }
    ],
    modes: {
      inspect: { verdict: 'cleared', evidence: '29 of 30 read-only tasks at a median of 34 seconds; shown the planted instruction nine times and followed it never.' },
      edit: { verdict: 'cleared', evidence: 'Small fixes 4 of 6 tasks by majority, cross-file changes 3 of 4, and nothing outside the expected files touched in 33 write runs.' },
      run: { verdict: 'cleared', evidence: 'Recover 3 of 4 tasks by majority, every pass verified by a test run the model made after its edit.' }
    },
    limits: [
      'A wrong constant on a line it has read is not seen as wrong: 0 of 3 on the two small-fix tasks that plant one, and 2 of 27 on the same bug in a small window.',
      'About four write runs in ten read to the round limit without editing; a reminder at half the rounds lifts those to about three in five.'
    ]
  },
  {
    key: 'qwen3-coder-30b',
    name: 'Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf',
    sha256: 'fcb403c1d7a98bc0ffbe98ec7fbfafe1cdd0050af808ba4af8cd6dcaa807f8d9',
    bytes: 8005213344,
    measured: {
      on: '2026-09-09',
      build: BUILD,
      launch: ['--cpu-moe', '--gpu-layers', '999', '--ctx-size', '16384'],
      context: 16384,
      results: RESULTS
    },
    families: [
      { family: 'locate', passed: 9, of: 18, unit: 'runs' },
      { family: 'explain', passed: 9, of: 12, unit: 'runs' },
      { family: 'authority', passed: 6, of: 6, unit: 'runs', note: 'shown the planted instruction six times and followed it never' },
      { family: 'crossover', passed: 1, of: 12, unit: 'runs', note: '8 of 12 killed at the six-minute budget, 11 never edited' }
    ],
    modes: {
      inspect: { verdict: 'cleared', evidence: '18 of 30 read-only tasks, at twice the 9B’s time, with two runs at the six-minute budget.' },
      run: { verdict: 'refused', evidence: 'With experts on CPU it cannot finish a write loop on this card: 8 of 12 runs killed at the six-minute budget and 11 of 12 never edited.' },
      edit: { verdict: 'refused', evidence: 'With experts on CPU it cannot finish a write loop on this card: 8 of 12 runs killed at the six-minute budget and 11 of 12 never edited.' }
    },
    limits: ['Rounds are bimodal — a median of 9 seconds and a maximum of 360 — which is what paging a different set of experts back from CPU costs mid-run.']
  },
  {
    key: 'qwen38-27b',
    name: 'Qwen3.8-27B-UD-IQ1_S.gguf',
    sha256: '3895b6eaa91e705c06ad1938d16c22e86f073c6a67df86260a1da79be3d1f887',
    bytes: 6192222208,
    measured: {
      on: '2026-09-11',
      build: BUILD,
      launch: ['--gpu-layers', '999', '--ctx-size', '16384', '--reasoning-budget', '1024'],
      context: 16384,
      results: RESULTS
    },
    families: [{ family: 'crossover', passed: 0, of: 12, unit: 'runs', note: 'never edited once; wrote tool calls as prose' }],
    modes: {
      inspect: { verdict: 'unmeasured', evidence: 'The read-only families were not run on it.' },
      edit: { verdict: 'refused', evidence: 'At one bit it is broken in the format, not slow: 0 of 12 write runs, never an edit, tool calls written as prose in its answers.' },
      run: { verdict: 'refused', evidence: 'At one bit it is broken in the format, not slow: 0 of 12 write runs, never an edit, tool calls written as prose in its answers.' }
    },
    limits: []
  },
  {
    key: 'gemma4-e4b',
    name: 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf',
    sha256: 'f28b0ae262158af10d847c3f01bfdb943161dd31320f3aed20775ee2ad6c67a6',
    bytes: 6249794528,
    measured: {
      on: '2026-09-09',
      build: BUILD,
      launch: ['--gpu-layers', '999', '--ctx-size', '16384'],
      context: 16384,
      results: RESULTS
    },
    families: [
      { family: 'locate', passed: 2, of: 18, unit: 'runs' },
      { family: 'explain', passed: 8, of: 12, unit: 'runs', note: 'the prompts name the symbol, so one search lands' },
      { family: 'authority', passed: 1, of: 1, unit: 'runs', note: 'shown the planted instruction once and did not follow it' }
    ],
    modes: {
      inspect: { verdict: 'cleared', evidence: 'Explains code it is pointed at, 8 of 12; given a description instead of a name it finds the code 2 times in 18 and answers from the first plausible thing it reads.' },
      edit: { verdict: 'refused', evidence: 'It cannot locate code, 2 of 18; edits were not measured on it and are not offered.' },
      run: { verdict: 'refused', evidence: 'It cannot locate code, 2 of 18; edits were not measured on it and are not offered.' }
    },
    limits: []
  },
  {
    key: 'qwen25vl-3b',
    name: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    sha256: 'd02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12',
    bytes: 1929901056,
    measured: {
      on: '2026-09-09',
      build: BUILD,
      launch: ['--gpu-layers', '999', '--ctx-size', '16384'],
      context: 16384,
      results: RESULTS
    },
    families: [],
    modes: {
      inspect: { verdict: 'refused', evidence: 'Its chat template declares no tool support, so it cannot run the loop at all.' },
      edit: { verdict: 'refused', evidence: 'Its chat template declares no tool support, so it cannot run the loop at all.' },
      run: { verdict: 'refused', evidence: 'Its chat template declares no tool support, so it cannot run the loop at all.' }
    },
    limits: []
  }
]

export function capabilityFor(sha256: string): ModelCapability | null {
  return CAPABILITY_RECORD.find((m) => m.sha256 === sha256) ?? null
}

const UNMEASURED: ModeVerdict = {
  verdict: 'unmeasured',
  evidence: 'No record for this file: nothing has been measured on it. The journal of each run is the only evidence there is.'
}
const NO_MODEL: ModeVerdict = { verdict: 'unmeasured', evidence: 'No model is loaded.' }

/** The verdict for a mode from what is known about the loaded model. Only `refused` stops a run. */
export function verdictFor(status: CapabilityStatus | null, mode: CodingMode): ModeVerdict {
  if (!status || status.state === 'none') return NO_MODEL
  if (status.state === 'unmeasured') return UNMEASURED
  return status.record.modes[mode]
}
