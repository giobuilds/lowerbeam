import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_TERMS, sameTerms, type ChangeSet, type CodingRunSummary, type GrantTerms, type JournalEvent } from '@shared/coding.js'
import { useCodingStore } from '../state/codingStore.js'
import { verdictFor, type CapabilityStatus } from '@shared/capability.js'
import { isTestPath, type CommandEvidence } from '@shared/evidence.js'
import { useServerStore } from '../state/serverStore.js'
import { renderMarkdown } from '../api/markdown.js'

/**
 * The Coding tab, Stage 1: one project, one question, and the journal of what
 * the model did to answer it.
 *
 * Everything shown here is a rendering of the run's journal — the same record
 * that survives a reload and a crash. The access mode is fixed at "inspect"
 * because that is all Stage 1 can do: list, search and read, inside the
 * project, nothing else.
 */
export function Coding(): React.JSX.Element {
  const init = useCodingStore((s) => s.init)
  const project = useCodingStore((s) => s.project)
  const pickProject = useCodingStore((s) => s.pickProject)
  const runs = useCodingStore((s) => s.runs)
  const activeRunId = useCodingStore((s) => s.activeRunId)
  const open = useCodingStore((s) => s.open)
  const error = useCodingStore((s) => s.error)
  const clearError = useCodingStore((s) => s.clearError)
  const status = useServerStore((s) => s.status)
  const loadCapability = useCodingStore((s) => s.loadCapability)

  useEffect(() => {
    void init()
  }, [init])

  const active = runs.find((r) => r.id === activeRunId) ?? null
  const modelPath = status?.phase === 'ready' ? (status.config?.modelPath ?? null) : null
  const modelName = modelPath?.split('/').pop() ?? null
  // Whenever a different model is ready, ask the record about it.
  useEffect(() => {
    void loadCapability()
  }, [loadCapability, modelPath])

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-panel">
        <div className="border-b border-edge p-3">
          <p className="text-[11px] font-medium text-muted">Project</p>
          <button
            type="button"
            onClick={() => void pickProject()}
            title={project ?? 'Choose a project folder'}
            className="mt-1 w-full truncate rounded border border-edge px-2 py-1 text-left text-xs text-slate-200 hover:border-accent"
          >
            {project ? project.split('/').slice(-2).join('/') : 'Choose a folder…'}
          </button>
          <ModeBadge />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.length === 0 && <p className="p-3 text-[11px] text-muted">No runs yet.</p>}
          {[...runs].reverse().map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => void open(run.id)}
              className={`block w-full border-b border-edge px-3 py-2 text-left hover:bg-ink/60 ${
                run.id === activeRunId ? 'bg-ink' : ''
              }`}
            >
              <p className="truncate text-xs text-slate-200">{run.task}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                <Outcome outcome={run.outcome} /> · {run.model}
              </p>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <Composer disabled={!project || !modelName} modelName={modelName ?? null} />
        {error && (
          <p
            onClick={clearError}
            className="cursor-pointer border-b border-rose-900 bg-rose-950/40 px-4 py-2 text-xs text-rose-200"
          >
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {active ? <Run run={active} /> : <Empty hasProject={Boolean(project)} hasModel={Boolean(modelName)} />}
        </div>
      </section>
    </div>
  )
}

function Composer({ disabled, modelName }: { disabled: boolean; modelName: string | null }): React.JSX.Element {
  const task = useCodingStore((s) => s.task)
  const setTask = useCodingStore((s) => s.setTask)
  const start = useCodingStore((s) => s.start)
  const cancel = useCodingStore((s) => s.cancel)
  const mode = useCodingStore((s) => s.mode)
  const running = useCodingStore((s) => s.runs.some((r) => r.outcome === 'running'))

  return (
    <div className="border-b border-edge px-4 py-3">
      <div className="flex gap-2">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void start()
            }
          }}
          disabled={disabled || running}
          placeholder={
            modelName
              ? 'Ask something about this project — where is…, why does…'
              : 'Start a model on the Server tab first'
          }
          rows={2}
          className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-ink px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        {running ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-md border border-edge px-4 text-sm text-amber-200 hover:border-amber-300"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled || !task.trim()}
            className="rounded-md bg-accent px-4 text-sm font-medium text-ink disabled:opacity-40"
          >
            Ask
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <ModeToggle disabled={running} />
        <TermsRow disabled={running} />
        {modelName && (
          <p className="text-[11px] text-muted">
            Using <span className="text-slate-300">{modelName}</span>. <Measured />{' '}
            {mode === 'run'
              ? 'Edits go to a copy; the model can run commands there in a sandbox with no network, and you apply the result, or not.'
              : mode === 'edit'
                ? 'Edits go to a copy of the project; you apply them, or not, from the Changes panel.'
                : 'The model can list, search and read files in the project; it cannot change anything.'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The terms of the next run's grant beyond its mode, set here and nowhere
 * else: folders it may also read, and for a run that executes commands,
 * the network and installs. Each is a visible change, recorded in the run,
 * and never a prompt in the middle of one.
 */
function TermsRow({ disabled }: { disabled: boolean }): React.JSX.Element {
  const mode = useCodingStore((s) => s.mode)
  const terms = useCodingStore((s) => s.terms)
  const setTerms = useCodingStore((s) => s.setTerms)
  const addReadRoot = useCodingStore((s) => s.addReadRoot)
  const removeReadRoot = useCodingStore((s) => s.removeReadRoot)
  const sandbox = useCodingStore((s) => s.sandbox)
  const boxed = mode === 'run' && sandbox?.ok === true
  const toggle = (key: 'network' | 'install', label: string, title: string): React.JSX.Element => (
    <label className={`flex items-center gap-1 text-[11px] ${boxed ? 'text-muted' : 'text-muted/50'}`} title={boxed ? title : 'Only a run that executes commands can use this.'}>
      <input type="checkbox" disabled={disabled || !boxed} checked={boxed && terms[key]} onChange={(e) => setTerms({ [key]: e.target.checked })} className="accent-amber-300" />
      {label}
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted">Grant:</span>
      {terms.alsoRead.map((dir) => (
        <span key={dir} className="flex items-center gap-1 rounded bg-ink px-1.5 py-0.5 font-mono text-[10px] text-amber-200" title={`${dir} — readable, never written`}>
          reads {dir.split('/').slice(-2).join('/')}
          <button type="button" disabled={disabled} onClick={() => removeReadRoot(dir)} className="text-muted hover:text-rose-300" title="Remove from the grant">×</button>
        </span>
      ))}
      <button type="button" disabled={disabled} onClick={() => void addReadRoot()} className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:text-slate-200 disabled:opacity-50" title="A folder outside the project the run may also read, never write.">
        + folder to read
      </button>
      {toggle('network', 'network', 'Commands in the sandbox may reach the network. Off, nothing outside the box is reachable.')}
      {toggle('install', 'install', 'Commands may install dependencies into the copy, which gets its own empty node_modules instead of the project\u2019s lent read-only. Usually needs the network too.')}
    </div>
  )
}

function ModeToggle({ disabled }: { disabled: boolean }): React.JSX.Element {
  const mode = useCodingStore((s) => s.mode)
  const setMode = useCodingStore((s) => s.setMode)
  const sandbox = useCodingStore((s) => s.sandbox)
  const capability = useCodingStore((s) => s.capability)
  const refused = (value: 'inspect' | 'edit' | 'run'): string | null => {
    const v = verdictFor(capability, value)
    return v.verdict === 'refused' ? v.evidence : null
  }
  const option = (value: 'inspect' | 'edit' | 'run', label: string, off = false, why = ''): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled || off}
      title={why}
      onClick={() => setMode(value)}
      className={`rounded px-2 py-0.5 text-[11px] ${
        mode === value ? 'bg-ink text-slate-100' : 'text-muted hover:text-slate-200'
      } disabled:opacity-50`}
    >
      {label}
    </button>
  )
  // The third mode is offered only where the box exists. Without it the
  // button says why, and a run is refused by the main process as well.
  // A mode the capability record refuses for this model is off, with the
  // measurement as the reason; the main process refuses it as well.
  const runOff = refused('run') ?? (sandbox !== null && !sandbox.ok ? (sandbox.reason ?? 'Commands cannot be contained here.') : null)
  return (
    <div className="flex items-center gap-1 rounded border border-edge p-0.5">
      {option('inspect', 'Inspect', refused('inspect') !== null, refused('inspect') ?? '')}
      {option('edit', 'Edit in a copy', refused('edit') !== null, refused('edit') ?? '')}
      {option('run', 'Edit and run', runOff !== null, runOff ?? (sandbox === null ? 'Checking whether commands can be contained…' : ''))}
    </div>
  )
}

/**
 * What the capability record says about the loaded model, in a line: the
 * measurement behind the mode that is selected, or that there is none.
 */
function Measured(): React.JSX.Element | null {
  const capability = useCodingStore((s) => s.capability)
  const mode = useCodingStore((s) => s.mode)
  if (capability === null) return <span>Identifying the model…</span>
  if (capability.state === 'none') return null
  if (capability.state === 'unmeasured') {
    return (
      <span title={`sha256 ${capability.sha256}`}>
        <span className="text-amber-200/80">Not measured:</span> no record for this file, so nothing here is known to work; the journal is the evidence.
      </span>
    )
  }
  const v = capability.record.modes[mode]
  return (
    <span title={summary(capability)}>
      <span className={v.verdict === 'cleared' ? 'text-emerald-300/80' : v.verdict === 'refused' ? 'text-rose-300' : 'text-amber-200/80'}>
        {v.verdict === 'cleared' ? 'Measured:' : v.verdict === 'refused' ? 'Refused:' : 'Not measured for this:'}
      </span>{' '}
      {v.evidence}
      {capability.record.limits.length > 0 && mode !== 'inspect' && <> Known limit: {capability.record.limits[0]}</>}
    </span>
  )
}

function summary(c: Extract<CapabilityStatus, { state: 'measured' }>): string {
  const families = c.record.families.map((f) => `${f.family} ${f.passed}/${f.of} ${f.unit}`).join(', ')
  return `${c.record.name}, measured ${c.record.measured.on} under ${c.record.measured.build}, ${c.record.measured.launch.join(' ')}: ${families}. See ${c.record.measured.results}.`
}

function ModeBadge(): React.JSX.Element {
  const mode = useCodingStore((s) => s.mode)
  return mode === 'run' ? (
    <p className="mt-2 text-[11px] text-muted">
      <span className="rounded bg-ink px-1.5 py-0.5 text-rose-200">run</span> in a copy, in a sandbox —
      no network, nothing reaches the project until you apply it
    </p>
  ) : mode === 'edit' ? (
    <p className="mt-2 text-[11px] text-muted">
      <span className="rounded bg-ink px-1.5 py-0.5 text-amber-200">edit</span> in a copy — nothing
      reaches the project until you apply it
    </p>
  ) : (
    <p className="mt-2 text-[11px] text-muted">
      <span className="rounded bg-ink px-1.5 py-0.5 text-emerald-200">inspect</span> read-only, inside
      this folder
    </p>
  )
}

function Empty({ hasProject, hasModel }: { hasProject: boolean; hasModel: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="max-w-md text-center text-xs leading-relaxed text-muted">
        {!hasProject
          ? 'Choose a project folder on the left. The model will only be able to see inside it.'
          : !hasModel
            ? 'Start a model on the Server tab. A coding run uses whichever model is loaded.'
            : 'Ask a question about the code. Every file the model reads, and every reply, is recorded below as it happens.'}
      </p>
    </div>
  )
}

const NO_EVENTS: JournalEvent[] = []

/** What a run could reach beyond its mode, as recorded. Nothing shown for the defaults. */
function TermsHeld({ terms }: { terms: GrantTerms }): React.JSX.Element | null {
  if (sameTerms(terms, DEFAULT_TERMS)) return null
  return (
    <p className="mb-2 flex flex-wrap gap-1 text-[11px] text-muted">
      <span>Granted beyond the project:</span>
      {terms.alsoRead.map((d) => (
        <span key={d} className="rounded bg-ink px-1.5 font-mono text-[10px] text-amber-200" title={d}>reads {d}</span>
      ))}
      {terms.network && <span className="rounded bg-ink px-1.5 text-[10px] text-amber-200">network</span>}
      {terms.install && <span className="rounded bg-ink px-1.5 text-[10px] text-amber-200">install</span>}
    </p>
  )
}

/**
 * What the run asked for and was refused, each a reach outside the grant.
 * Listed so the person can see what the model wanted and change the grant
 * for the next run if that is right — a change here, not a prompt there.
 */
function Refused({ run, events }: { run: CodingRunSummary; events: JournalEvent[] }): React.JSX.Element | null {
  const refused = events.filter((e): e is Extract<JournalEvent, { type: 'tool.result' }> => e.type === 'tool.result' && e.denied)
  if (refused.length === 0 || run.outcome === 'running') return null
  return (
    <div className="mb-2 rounded border border-amber-900/60 bg-amber-950/20 p-2 text-[11px]">
      <p className="text-amber-200">Refused by the grant:</p>
      <ul className="pl-3 font-mono text-muted">
        {refused.slice(0, 8).map((e) => (
          <li key={e.seq} className="truncate">{e.summary}</li>
        ))}
        {refused.length > 8 && <li>… {refused.length - 8} more</li>}
      </ul>
      <p className="mt-1 text-muted">If the task needs one of these, add the folder to the grant above and run again. Nothing is granted mid-run.</p>
    </div>
  )
}

/** One run: its journal as a readable log, and its answer when it has one. */
function Run({ run }: { run: CodingRunSummary }): React.JSX.Element {
  // The default lives outside the selector: `?? []` inside it would hand the
  // store a new array on every call, which it reads as a change, forever.
  const events = useCodingStore((s) => s.events[run.id]) ?? NO_EVENTS
  const answerHtml = useMemo(() => (run.answer ? renderMarkdown(run.answer) : ''), [run.answer])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-slate-100">{run.task}</h2>
        <span className="ml-auto text-[11px] text-muted">
          <Outcome outcome={run.outcome} />
          {run.finishedAt && ` · ${Math.round((run.finishedAt - run.startedAt) / 1000)}s · ${run.rounds} rounds`}
          {run.denials > 0 && (
            <span className="ml-2 text-amber-300">{run.denials} reach{run.denials === 1 ? '' : 'es'} outside the grant refused</span>
          )}
        </span>
      </div>
      <TermsHeld terms={run.grant} />
      <Refused run={run} events={events} />

      <ol className="space-y-1 rounded border border-edge bg-panel p-3 font-mono text-[11px] leading-snug">
        {events.map((e) => (
          <Line key={e.seq} event={e} />
        ))}
        {run.outcome === 'running' && (
          <li className="text-muted">
            <span className="inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" /> working…
          </li>
        )}
      </ol>

      {run.answer && run.outcome !== 'running' && (
        <div className="mt-4">
          <p className="mb-1 text-[11px] font-medium text-muted">
            {run.outcome === 'answered' ? 'Answer' : 'Stopped'}
          </p>
          <div
            className="prose prose-invert prose-sm max-w-none rounded border border-edge bg-panel p-4 text-sm"
            dangerouslySetInnerHTML={{ __html: answerHtml }}
          />
        </div>
      )}

      {run.mode === 'run' && run.outcome !== 'running' && <EvidencePanel run={run} />}
      {run.mode !== 'inspect' && run.outcome !== 'running' && <Changes run={run} />}
    </div>
  )
}

/**
 * What an edit run changed, against the baseline its copy was taken from,
 * and the three things a person can do about it. Apply writes each file back
 * only if the project still holds what the baseline held; anything edited
 * since is a conflict, listed and left alone.
 */
function Changes({ run }: { run: CodingRunSummary }): React.JSX.Element {
  const changes = useCodingStore((s) => s.changes[run.id])
  const result = useCodingStore((s) => s.applyResults[run.id])
  const busy = useCodingStore((s) => Boolean(s.busy[run.id]))
  const loadChanges = useCodingStore((s) => s.loadChanges)
  const apply = useCodingStore((s) => s.apply)
  const undo = useCodingStore((s) => s.undo)
  const discard = useCodingStore((s) => s.discard)

  useEffect(() => {
    if (!changes) void loadChanges(run.id)
  }, [changes, loadChanges, run.id])

  if (!changes) return <p className="mt-4 text-[11px] text-muted">Comparing with the baseline…</p>

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline gap-3">
        <p className="text-[11px] font-medium text-muted">
          Changes{changes.files.length ? ` · ${changes.files.length} file${changes.files.length === 1 ? '' : 's'}` : ''}
        </p>
        {run.appliedAt && <span className="text-[11px] text-emerald-300">applied to the project</span>}
        <span className="ml-auto flex gap-2">
          {run.appliedAt ? (
            <button type="button" disabled={busy} onClick={() => void undo(run.id)} className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-slate-200 disabled:opacity-50">
              Undo
            </button>
          ) : (
            changes.files.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void apply(run.id)} className="rounded bg-accent px-2.5 py-0.5 text-[11px] font-medium text-ink disabled:opacity-50">
                Apply to project
              </button>
            )
          )}
          <button type="button" disabled={busy || Boolean(run.appliedAt)} onClick={() => void discard(run.id)} className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-rose-300 disabled:opacity-50">
            Discard copy
          </button>
        </span>
      </div>

      {changes.files.length === 0 && <p className="text-[11px] text-muted">The run changed nothing.</p>}

      {result && (
        <div className="mb-2 rounded border border-edge bg-panel p-2 text-[11px]">
          {result.applied.length > 0 && <p className="text-emerald-300">{result.applied.length} file{result.applied.length === 1 ? '' : 's'}: {result.applied.join(', ')}</p>}
          {result.conflicts.map((c) => (
            <p key={c.path} className="text-amber-300">
              {c.path} left alone — {c.reason}
            </p>
          ))}
        </div>
      )}

      <ul className="space-y-2">
        {changes.files.map((f) => (
          <FileDiff key={f.path} change={f} />
        ))}
      </ul>
    </div>
  )
}

/**
 * What the run's commands show, read against the record: the command after
 * its last edit, the same command before any edit, and their failure lines
 * compared. A test file among the changes is named here too, because a
 * pass that came from editing the tests is not a pass.
 */
function EvidencePanel({ run }: { run: CodingRunSummary }): React.JSX.Element {
  const evidence = useCodingStore((s) => s.evidence[run.id])
  const busy = useCodingStore((s) => Boolean(s.busy[run.id]))
  const loadEvidence = useCodingStore((s) => s.loadEvidence)
  const checkBaseline = useCodingStore((s) => s.checkBaseline)

  useEffect(() => {
    if (!evidence) void loadEvidence(run.id)
  }, [evidence, loadEvidence, run.id])

  if (!evidence) return <p className="mt-4 text-[11px] text-muted">Reading the run's commands…</p>
  const v = evidence.verification
  const b = evidence.baseline
  const passed = v !== null && v.exitCode === 0 && !v.timedOut
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline gap-3">
        <p className="text-[11px] font-medium text-muted">Evidence</p>
        {v && (
          <button type="button" disabled={busy} onClick={() => void checkBaseline(run.id)} className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-slate-200 disabled:opacity-50" title="Run the same command once on a fresh copy of the project as it was when the run began.">
            {busy ? 'Running on the baseline…' : b?.source === 'rerun' ? 'Run on the baseline again' : 'Run on the baseline'}
          </button>
        )}
      </div>
      <div className="space-y-1 rounded border border-edge bg-panel p-3 text-[11px]">
        {!v ? (
          <p className="text-amber-200">Nothing was run after the last edit, so the change is unverified.</p>
        ) : (
          <>
            <CommandLine label="after the edit" c={v} />
            {b ? (
              <CommandLine label={b.source === 'record' ? 'before any edit, from the run' : 'on the baseline, rerun'} c={b} />
            ) : (
              <p className="text-muted">The run did not make this command before editing, so the record has no baseline for it.</p>
            )}
            {b && v.outputAvailable && b.outputAvailable && (
              <div className="pt-1">
                {evidence.newFailures.length > 0 && <FailureList label="new since the change" lines={evidence.newFailures} colour="text-rose-300" />}
                {evidence.preexisting.length > 0 && <FailureList label="already failing before the run" lines={evidence.preexisting} colour="text-amber-200" />}
                {evidence.fixed.length > 0 && <FailureList label="failing before, not now" lines={evidence.fixed} colour="text-emerald-300" />}
                {evidence.newFailures.length === 0 && evidence.preexisting.length === 0 && evidence.fixed.length === 0 && (
                  <p className="text-muted">{passed ? 'No failure lines either side.' : 'No failure lines recognised either side; the exit codes are what there is.'}</p>
                )}
              </div>
            )}
            {(!v.outputAvailable || (b && !b.outputAvailable)) && <p className="text-muted">Output was not kept for this run, so only the exit codes can be compared.</p>}
            {evidence.drifted.length > 0 && (
              <p className="text-amber-200">
                The project has changed since the run's baseline in {evidence.drifted.length} file{evidence.drifted.length === 1 ? '' : 's'} ({evidence.drifted.slice(0, 3).join(', ')}
                {evidence.drifted.length > 3 ? ', …' : ''}), so the rerun was against the project as it is now.
              </p>
            )}
          </>
        )}
        {evidence.testFilesChanged.length > 0 && (
          <p className="text-amber-200">
            The run changed {evidence.testFilesChanged.length} test file{evidence.testFilesChanged.length === 1 ? '' : 's'} ({evidence.testFilesChanged.join(', ')}). {passed ? 'The pass is not proof the change is right: read those diffs first.' : 'Those are changes to review, not proof of anything.'}
          </p>
        )}
      </div>
    </div>
  )
}

function CommandLine({ label, c }: { label: string; c: CommandEvidence }): React.JSX.Element {
  const state = c.timedOut ? 'timed out' : c.exitCode === 0 ? 'exit 0' : `exit ${c.exitCode ?? '?'}`
  return (
    <p className={c.timedOut ? 'text-amber-300' : c.exitCode === 0 ? 'text-slate-300' : 'text-rose-300'}>
      <span className="text-muted">{label} · </span>
      <span className="font-mono">$ {c.command}</span> → {state}
      {c.outputAvailable && c.failures.length > 0 && <span className="text-muted"> · {c.failures.length} failure line{c.failures.length === 1 ? '' : 's'}</span>}
    </p>
  )
}

function FailureList({ label, lines, colour }: { label: string; lines: string[]; colour: string }): React.JSX.Element {
  return (
    <div>
      <p className={colour}>{label}</p>
      <ul className="pl-3 font-mono text-muted">
        {lines.slice(0, 12).map((l) => (
          <li key={l} className="truncate">{l}</li>
        ))}
        {lines.length > 12 && <li>… {lines.length - 12} more</li>}
      </ul>
    </div>
  )
}

function FileDiff({ change }: { change: ChangeSet['files'][number] }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const colour = change.kind === 'created' ? 'text-emerald-300' : change.kind === 'deleted' ? 'text-rose-300' : 'text-amber-200'
  const test = isTestPath(change.path)
  return (
    <li className="rounded border border-edge bg-panel">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs">
        <span className={`w-16 shrink-0 text-[11px] ${colour}`}>{change.kind}</span>
        <span className="truncate font-mono text-slate-200">{change.path}</span>
        {test && <span className="shrink-0 rounded bg-ink px-1.5 text-[10px] text-amber-200" title="A test file: a change here is a change to review, not proof the code is right.">test</span>}
        <span className="ml-auto text-[11px] text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && change.diff && (
        <pre className="max-h-96 overflow-auto border-t border-edge px-3 py-2 font-mono text-[11px] leading-snug">
          {change.diff.split('\n').map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'text-emerald-300'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-rose-300'
                    : line.startsWith('@@')
                      ? 'text-accent'
                      : 'text-muted'
              }
            >
              {line}
            </div>
          ))}
        </pre>
      )}
    </li>
  )
}

/** A journal event as one line a person can read without decoding it. */
function Line({ event }: { event: JournalEvent }): React.JSX.Element | null {
  switch (event.type) {
    case 'run.started':
      return <li className="text-muted">started · {event.model} · {event.grantRoot}</li>
    case 'model.request':
      return <li className="text-muted">round {event.round} · asking the model</li>
    case 'model.response':
      return (
        <li className="text-muted">
          round {event.round} · {event.toolCalls ? `${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'}` : 'answered'}
          {event.usage && ` · ${event.usage.promptTokens + event.usage.predictedTokens} tok`} · {(event.ms / 1000).toFixed(1)}s
        </li>
      )
    case 'tool.call':
      return (
        <li className="text-slate-300">
          <span className="text-accent">{event.name}</span> {describeArgs(event.args)}
        </li>
      )
    case 'tool.result':
      // A command's result is carried by its own command.finished line.
      if (event.summary.startsWith('$ ')) return null
      return event.denied ? (
        <li className="text-amber-300">refused — {event.summary}</li>
      ) : event.ok ? (
        <li className="pl-4 text-muted">{event.summary}</li>
      ) : (
        <li className="pl-4 text-rose-300">{event.summary}</li>
      )
    case 'command.finished':
      return (
        <li className={event.timedOut ? 'text-amber-300' : event.exitCode === 0 ? 'text-slate-300' : 'text-rose-300'}>
          $ {event.command} → {event.timedOut ? 'timed out' : `exit ${event.exitCode ?? '?'}`} · {(event.ms / 1000).toFixed(1)}s
          {event.truncated && ' · output truncated'}
        </li>
      )
    case 'checkpoint':
      return (
        <li className="text-amber-200/80">
          notes replaced the earlier rounds · {event.reason === 'overflow' ? 'the window overflowed' : 'the window was filling'} ·{' '}
          {event.record.changed.length} file{event.record.changed.length === 1 ? '' : 's'} changed so far · verification {event.record.verification.status}
        </li>
      )
    case 'reminder':
      return (
        <li className="text-amber-200/80">
          reminded that nothing has changed · after {event.record.rounds} rounds · {event.record.read.length} file{event.record.read.length === 1 ? '' : 's'} read
        </li>
      )
    case 'run.finished':
      return (
        <li className="text-muted">
          finished · {event.outcome} · {event.rounds} rounds · {event.tokens.promptTokens + event.tokens.predictedTokens} tok
        </li>
      )
    default:
      return null
  }
}

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
}

function Outcome({ outcome }: { outcome: CodingRunSummary['outcome'] }): React.JSX.Element {
  const colour =
    outcome === 'answered'
      ? 'text-emerald-300'
      : outcome === 'running'
        ? 'text-accent'
        : outcome === 'cancelled'
          ? 'text-amber-300'
          : 'text-rose-300'
  const label =
    outcome === 'rounds' ? 'ran out of rounds' : outcome === 'timeout' ? 'timed out' : outcome
  return <span className={colour}>{label}</span>
}
