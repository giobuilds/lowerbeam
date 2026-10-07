import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpath, stat } from 'node:fs/promises'
import { DEFAULT_TERMS, JOURNAL_VERSION, type CodingRunSummary, type CodingStartRequest, type GrantTerms, type JournalEvent } from '@shared/coding.js'
import { Grant, secretReason } from '../../agent/grant.js'
import { runTask } from '../../agent/loop.js'
import type { ServerSupervisor } from '../supervisor.js'
import { Journal } from './journal.js'
import { Workspace } from './workspace.js'
import { findNode, maskedFor, probeSandbox, runInSandbox } from './sandbox.js'
import { LocalRecord, ModelIdentifier } from './capability.js'
import { verdictFor, type CapabilityStatus, type MeasureProgress } from '@shared/capability.js'
import { servedModel } from '@shared/served.js'
import { MEASURE_TASKS, entryFrom, measureTask, noToolsEntry, type MeasureBox, type TaskOutcome } from './measure.js'
import type { LaunchConfig } from '@shared/types.js'
import { evidenceFrom, withRerun, type Evidence } from '@shared/evidence.js'
import { hashFile } from './workspace.js'
import { appendFile, writeFile } from 'node:fs/promises'
import { RUN_FILE } from '../appData.js'
import type { ApplyOptions, ApplyResult, ChangeSet, GitState } from '@shared/coding.js'
import { checkNewBranch, checkRevertable, commitInfo, commitPaths, gitState, revertMessage, switchToNewBranch, uncommitted } from './git.js'
import { PRIVATE_DIR, PRIVATE_FILE } from '../private.js'

/** What every coding run is given, and so what a measurement measures. */
const RUN_SETTINGS = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }
const MAX_ROUNDS = 12
const RUN_TIMEOUT_MS = 6 * 60_000

/**
 * Owns coding runs the way the llama.cpp supervisor owns model processes.
 *
 * The two have different jobs and this one never touches the other's process:
 * it asks whether a model is ready and which, records that in the run, and
 * runs the loop against it. A run is a grant, a journal and an abort
 * controller. The journal is written before anything is sent to the renderer,
 * so a reload can rebuild exactly what the interface had, and a crash leaves
 * a record that says "in progress" rather than one that claims a result.
 *
 * Stage 1: the loop runs in this process. It has no Electron in it and takes
 * nothing from here but a grant and a callback, so moving it to a utility
 * process is a transport change, not a redesign — and it is read-only, so
 * what it can do from here is list, search and read inside one directory.
 */
export class CodingSupervisor extends EventEmitter<{
  event: [JournalEvent]
  runs: [CodingRunSummary[]]
  measure: [MeasureProgress]
}> {
  private readonly runs = new Map<string, CodingRunSummary>()
  private readonly live = new Map<string, { abort: AbortController; journal: Journal }>()
  private readonly workspaces = new Map<string, Workspace>()
  private readonly identifier: ModelIdentifier
  private readonly local: LocalRecord
  private measuring: { progress: MeasureProgress; abort: AbortController } | null = null
  private lastMeasure: MeasureProgress | null = null

  constructor(
    private readonly dir: string,
    private readonly inference: () => ServerSupervisor | null,
    /** The project "Measure this model" runs on, shipped with the app; null where it is not. */
    private readonly corpus: string | null = null
  ) {
    super()
    this.local = new LocalRecord(join(dir, 'local-capability.json'))
    this.identifier = new ModelIdentifier(join(dir, 'model-hashes.json'), this.local)
  }

  /** Rebuild the list from what is on disk, oldest first. */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR })
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.jsonl')) continue
      const summary = summarise(await Journal.read(join(this.dir, name)))
      if (summary) this.runs.set(summary.id, summary)
    }
    this.emit('runs', this.list())
  }

  list(): CodingRunSummary[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  async events(id: string): Promise<JournalEvent[]> {
    if (!this.runs.has(id)) return []
    const running = this.live.get(id)
    return running ? running.journal.read() : Journal.read(this.file(id))
  }

  async start(req: CodingStartRequest): Promise<CodingRunSummary> {
    const server = this.inference()
    const status = server?.status
    if (!server || !status || status.phase !== 'ready' || !status.port) {
      throw new Error('Start a model on the Server tab first: a coding run needs one loaded.')
    }
    if (this.measuring) throw new Error('The model is being measured. Wait for it to finish, or stop it, before starting a run.')
    const id = randomUUID()
    // Grant.open resolves the root and throws if it does not exist, which is
    // the right time to find out — not on the first tool call. An edit run's
    // grant is on a copy of the project, never the project.
    let grant: Grant
    let workspace: Workspace | null = null
    // A mode the record refuses for this model is refused here, with the
    // measurement, whatever the interface offered. An unmeasured model is
    // offered every mode; the record says so and the journal is the evidence.
    // The model this run uses, loaded and read: in a router, the one asked for.
    const served = await server.ensureLoaded(req.model)
    const verdict = verdictFor(await this.identifier.status(served.modelPath), req.mode)
    if (verdict.verdict === 'refused') throw new Error(`This model is not cleared to ${describe(req.mode)}: ${verdict.evidence}`)
    // The terms are checked here, where they are enforced, whatever the
    // interface offered: an extra root must be a real directory, narrow
    // enough to mean something, and never this app's own state.
    await checkProjectRoot(req.projectRoot, dirname(this.dir))
    const terms = await this.checkTerms(req.grant ?? DEFAULT_TERMS, req.mode, req.projectRoot)
    if (req.mode === 'run') {
      // No box, no run mode: it is refused here, with the reason, rather than
      // running anything unsandboxed and calling that a sandbox.
      const probe = await probeSandbox()
      if (!probe.ok) throw new Error(`Commands cannot be run on this machine: ${probe.reason}`)
    }
    // What the box will hide, walked now so a folder too large to check
    // refuses the run before it starts, and the header can say so.
    const masked = req.mode === 'run' ? await maskedFor(req.projectRoot, terms) : []
    if (req.mode === 'edit' || req.mode === 'run') {
      workspace = await Workspace.create((await Grant.open(req.projectRoot)).root, this.workspaceDir(id))
      this.workspaces.set(id, workspace)
      grant = await Grant.open(workspace.root, req.mode, terms.alsoRead)
    } else {
      grant = await Grant.open(req.projectRoot, 'inspect', terms.alsoRead)
    }
    const model = served.modelPath.split('/').pop() ?? 'unknown model'
    const journal = new Journal(this.file(id))
    const abort = new AbortController()
    this.live.set(id, { abort, journal })

    const summary: CodingRunSummary = {
      id,
      task: req.task,
      projectRoot: workspace ? workspace.manifest.projectRoot : grant.root,
      mode: req.mode,
      appliedAt: null,
      model,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: 'running',
      answer: '',
      rounds: 0,
      denials: 0,
      grant: terms,
      ...(masked.length ? { masked } : {})
    }
    this.runs.set(id, summary)
    this.emit('runs', this.list())

    // Not awaited: the caller gets the summary at once and follows events.
    void this.drive(id, summary, grant, journal, abort, `http://127.0.0.1:${status.port}`, req.task, served.contextPerSlot, req.mode, terms, served.id)
    return summary
  }

  private checkTerms(terms: GrantTerms, mode: CodingStartRequest['mode'], projectRoot: string): Promise<GrantTerms> {
    return checkTerms(terms, mode, dirname(this.dir), projectRoot)
  }

  cancel(id: string): boolean {
    const running = this.live.get(id)
    if (!running) return false
    running.abort.abort()
    return true
  }

  /** The app is closing. Every run ends as cancelled, in its journal. */
  shutdown(): void {
    for (const { abort } of this.live.values()) abort.abort()
    this.measuring?.abort.abort()
  }

  private async drive(
    id: string,
    summary: CodingRunSummary,
    grant: Grant,
    journal: Journal,
    abort: AbortController,
    baseUrl: string,
    task: string,
    contextLimit: number | null,
    mode: CodingRunSummary['mode'],
    terms: GrantTerms,
    requestModel: string
  ): Promise<void> {
    // Each command's full output is kept beside the journal, numbered in the
    // order the journal has them, so the evidence can find the output of the
    // k-th command from the k-th command.finished event.
    let commands = 0
    try {
      const result = await runTask({
        baseUrl,
        apiKey: this.inference()?.status.apiKey ?? null,
        model: summary.model,
        requestModel,
        task,
        grant,
        settings: RUN_SETTINGS,
        maxRounds: MAX_ROUNDS,
        timeoutMs: RUN_TIMEOUT_MS,
        signal: abort.signal,
        runId: id,
        contextLimit,
        mode,
        terms,
        execute:
          mode === 'run'
            ? async (command, signal) => {
                const ws = this.workspaces.get(id)
                if (!ws) throw new Error('no workspace')
                const r = await runInSandbox({
                  workspace: ws.root,
                  projectRoot: ws.manifest.projectRoot,
                  command,
                  timeoutMs: 120_000,
                  maxOutputBytes: 512 * 1024,
                  signal,
                  terms
                })
                // Full output beside the journal: the model sees a tail, a
                // person can see all of it.
                const output = r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')
                commands += 1
                await writeFile(join(this.dir, `${id}.cmd-${commands}.txt`), `$ ${command}\n${output}`, { mode: PRIVATE_FILE })
                return {
                  exitCode: r.exitCode,
                  output,
                  truncated: r.stdoutTruncated || r.stderrTruncated,
                  timedOut: r.timedOut,
                  ms: r.ms
                }
              }
            : undefined,
        onEvent: (event) => {
          // Journal first. The renderer is a view of the record, not the
          // other way round.
          void journal.append(event).then(() => this.emit('event', event))
        },
        // The model's own words, beside the journal: what a run rebuilt as
        // a training example needs and the record only measures.
        keep: (round, words) => appendFile(join(this.dir, `${id}.words.jsonl`), JSON.stringify({ round, ...words }) + '\n', { mode: PRIVATE_FILE })
      })
      Object.assign(summary, {
        finishedAt: Date.now(),
        outcome: result.outcome,
        answer: result.answer,
        rounds: result.rounds,
        denials: result.denials
      })
    } catch (err) {
      Object.assign(summary, {
        finishedAt: Date.now(),
        outcome: 'error',
        answer: err instanceof Error ? err.message : String(err)
      })
    } finally {
      await journal.read() // let the last append land before anyone reads the file
      this.live.delete(id)
      this.emit('runs', this.list())
    }
  }

  /** Whether commands can be run on this machine, and if not, why. */
  sandbox(): ReturnType<typeof probeSandbox> {
    return probeSandbox()
  }

  /** Where a measurement stands: the one running, else the last one this session, else null. */
  measureState(): MeasureProgress | null {
    return this.measuring?.progress ?? this.lastMeasure
  }

  /**
   * Measure the loaded model on the corpus the app ships with, the way a
   * coding run would use it, and keep the result as an indicative entry for
   * the file. Not awaited by the caller: progress comes as events.
   */
  async measure(wanted?: string | null): Promise<MeasureProgress> {
    const server = this.inference()
    const status = server?.status
    if (!server || !status || status.phase !== 'ready' || !status.port) {
      throw new Error('Start a model on the Server tab first: a measurement needs one loaded.')
    }
    if (!this.corpus) throw new Error('The measurement corpus is missing from this copy of the app.')
    if (this.measuring) throw new Error('A measurement is already running.')
    if (this.live.size > 0) throw new Error('Wait for the coding run to finish: a measurement needs the model to itself.')
    const served = await server.ensureLoaded(wanted)
    const config = server.launchFor(served.modelPath)
    if (!config) throw new Error('The launch this model runs under is not known.')
    const found = await this.identifier.status(served.modelPath)
    if (found.state === 'none') throw new Error('No model is loaded.')
    if (found.state === 'measured' && !found.record.indicative) {
      throw new Error('This file is in the curated record already; a short measurement would not add to it.')
    }

    const model = served.modelPath.split('/').pop() ?? 'model'
    const progress: MeasureProgress = {
      state: 'running',
      sha256: found.sha256,
      model,
      done: 0,
      total: served.supportsTools ? MEASURE_TASKS.length : 0,
      current: null,
      tasks: [],
      startedAt: Date.now(),
      error: null
    }
    const abort = new AbortController()
    this.measuring = { progress, abort }
    this.emit('measure', { ...progress })
    void this.runMeasure(progress, abort, {
      baseUrl: `http://127.0.0.1:${status.port}`,
      apiKey: status.apiKey,
      contextLimit: served.contextPerSlot,
      supportsTools: served.supportsTools,
      requestModel: served.id,
      build: server.binaryInfo.version,
      config,
      bytes: found.bytes,
      corpus: this.corpus
    })
    return { ...progress }
  }

  cancelMeasure(): boolean {
    if (!this.measuring) return false
    this.measuring.abort.abort()
    return true
  }

  private async runMeasure(
    progress: MeasureProgress,
    abort: AbortController,
    on: { baseUrl: string; apiKey: string | null; contextLimit: number | null; supportsTools: boolean; requestModel: string; build: string; config: LaunchConfig; bytes: number; corpus: string }
  ): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    const outDir = join(this.dir, 'measure', `${progress.sha256.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    const entryArgs = {
      name: progress.model,
      sha256: progress.sha256,
      bytes: on.bytes,
      on: day,
      build: on.build,
      launch: launchOf(on.config),
      context: on.contextLimit ?? on.config.contextSize,
      results: outDir
    }
    const emit = (): void => {
      this.emit('measure', { ...progress, tasks: [...progress.tasks] })
    }
    try {
      await mkdir(outDir, { recursive: true, mode: PRIVATE_DIR })
      if (!on.supportsTools) {
        await this.local.put(noToolsEntry(entryArgs))
      } else {
        const box = await measureBox()
        const outcomes: TaskOutcome[] = []
        for (const task of MEASURE_TASKS) {
          if (abort.signal.aborted) break
          progress.current = { id: task.id, family: task.family }
          emit()
          const outcome = await measureTask(task, {
            corpus: on.corpus,
            outDir,
            box,
            request: {
              baseUrl: on.baseUrl,
              apiKey: on.apiKey,
              model: progress.model,
              requestModel: on.requestModel,
              settings: RUN_SETTINGS,
              maxRounds: MAX_ROUNDS,
              timeoutMs: RUN_TIMEOUT_MS,
              contextLimit: on.contextLimit
            },
            signal: abort.signal
          })
          // A task cut short by the stop button measured nothing; it is not kept.
          if (abort.signal.aborted) break
          outcomes.push(outcome)
          const { leaked: _l, exercised: _e, edited: _d, unwanted: _u, ...kept } = outcome
          progress.tasks.push(kept)
          progress.done += 1
          emit()
        }
        if (abort.signal.aborted) {
          progress.state = 'cancelled'
          return
        }
        await this.local.put(entryFrom({ ...entryArgs, outcomes, box }))
      }
      progress.state = 'done'
    } catch (err) {
      progress.state = 'error'
      progress.error = err instanceof Error ? err.message : String(err)
    } finally {
      progress.current = null
      this.lastMeasure = { ...progress, tasks: [...progress.tasks] }
      this.measuring = null
      emit()
    }
  }

  /** What the record says about a model file that is not running: for a launch being prepared. */
  capabilityOf(path: string): Promise<CapabilityStatus> {
    return this.identifier.status(path)
  }

  /** What the capability record says about the model that is loaded now, and the context it is running with. */
  async capability(wanted?: string | null): Promise<CapabilityStatus> {
    const status = this.inference()?.status
    // In a router, the model the tab has picked; its file is known before it
    // is loaded, so its record is too, and its window once it has been.
    const served = status?.phase === 'ready' ? servedModel(status, wanted) : null
    const found = await this.identifier.status(served?.modelPath)
    return found.state === 'measured' ? { ...found, contextPerSlot: served?.contextPerSlot ?? null } : found
  }

  /**
   * What the run's commands show: the verification after its last edit, the
   * same command before any edit, and the failure lines of each compared.
   * From the record, plus a baseline rerun if one was asked for.
   */
  async evidence(id: string): Promise<Evidence | null> {
    if (!this.runs.has(id)) return null
    const events = await this.events(id)
    const changes = await this.changes(id)
    const outputs: Record<number, string | null> = {}
    const count = events.filter((e) => e.type === 'command.finished').length
    for (let k = 1; k <= count; k++) {
      try {
        // The first line is the command echoed; the output follows.
        outputs[k] = (await readFile(join(this.dir, `${id}.cmd-${k}.txt`), 'utf8')).replace(/^[^\n]*\n?/, '')
      } catch {
        outputs[k] = null
      }
    }
    const evidence = evidenceFrom(events, outputs, changes?.files.map((f) => f.path) ?? [])
    try {
      const rerun = JSON.parse(await readFile(join(this.dir, `${id}.baseline.json`), 'utf8')) as Rerun
      return withRerun(evidence, rerun)
    } catch {
      return evidence
    }
  }

  /**
   * Run the verification command once on the project as it was: a fresh copy,
   * checked file by file against the run's baseline manifest — anything the
   * project has changed since is named, since the rerun is then against the
   * project as it is now. The copy is removed afterwards; the output is kept.
   */
  async checkBaseline(id: string): Promise<Evidence | null> {
    const ws = await this.workspace(id)
    const evidence = await this.evidence(id)
    if (!ws || !evidence) throw new Error('This run has no workspace to check against.')
    if (!evidence.verification) throw new Error('The run ran nothing after its last edit, so there is nothing to compare.')
    if (this.live.has(id)) throw new Error('Wait for the run to finish, or stop it, before checking.')
    const dir = join(this.dir, 'workspaces', `${id}-baseline`)
    await rm(dir, { recursive: true, force: true })
    const copy = await Workspace.create(ws.manifest.projectRoot, dir)
    try {
      const drifted: string[] = []
      for (const [path, hash] of Object.entries(ws.manifest.files)) if (copy.manifest.files[path] !== hash) drifted.push(path)
      for (const path of Object.keys(copy.manifest.files)) if (!(path in ws.manifest.files)) drifted.push(path)
      const command = evidence.verification.command
      // Under the same terms the run had: a baseline that could not reach what the run could would not be the same test.
      const r = await runInSandbox({ workspace: copy.root, projectRoot: ws.manifest.projectRoot, command, timeoutMs: 120_000, maxOutputBytes: 512 * 1024, terms: this.runs.get(id)?.grant ?? DEFAULT_TERMS })
      const output = r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')
      const rerun: Rerun = { command, exitCode: r.exitCode, timedOut: r.timedOut, output, drifted: drifted.sort(), at: Date.now() }
      await writeFile(join(this.dir, `${id}.baseline.json`), JSON.stringify(rerun), { mode: PRIVATE_FILE })
      return withRerun(evidence, rerun)
    } finally {
      await copy.discard()
    }
  }

  /** The run's changes against the baseline its workspace was taken from. */
  async changes(id: string): Promise<ChangeSet | null> {
    const ws = await this.workspace(id)
    return ws ? ws.changes() : null
  }

  /** The project's git: branch and what is uncommitted, for the Changes panel. */
  async git(id: string): Promise<GitState | null> {
    const ws = await this.workspace(id)
    return ws ? gitState(ws.manifest.projectRoot) : null
  }

  async apply(id: string, options: ApplyOptions = {}): Promise<ApplyResult> {
    const ws = await this.workspace(id)
    if (!ws) throw new Error('This run has no workspace to apply.')
    if (this.live.has(id)) throw new Error('Wait for the run to finish, or stop it, before applying.')
    const project = ws.manifest.projectRoot
    const commit = options.commit
    if (commit) {
      // Checked before anything is written, so a refusal changes nothing.
      if (!commit.message.trim()) throw new Error('A commit needs a message.')
      if (!(await gitState(project)).repo) throw new Error('The project is not a git repository, so there is nothing to commit to.')
      const paths = (await ws.changes()).files.filter((f) => f.kind !== 'symlink').map((f) => f.path)
      // The commit is to hold the run's changes and nothing of the person's:
      // a file they have edited and not committed would go in with it.
      const theirs = await uncommitted(project, paths)
      if (theirs.length) {
        throw new Error(
          `These files have changes in the project that are not committed, and a commit would include them: ${theirs.join(', ')}. Commit or stash them first, or apply without a commit.`
        )
      }
      if (commit.branch) {
        const bad = await checkNewBranch(project, commit.branch)
        if (bad) throw new Error(bad)
        await switchToNewBranch(project, commit.branch)
      }
    }
    const result: ApplyResult = await ws.apply()
    if (commit && result.applied.length) {
      try {
        result.commit = await commitPaths(project, result.applied, commit.message.trim())
      } catch (err) {
        // The files are written either way, and undo restores them by file.
        result.commit = { error: `the files were applied but not committed: ${(err as Error).message.split('\n')[0]}` }
      }
    }
    // The journal is the run's record, and writing into the project is the
    // most consequential thing a run leads to: it is recorded there, with
    // what was written, so a restart and an audit both see it.
    if (result.applied.length || result.conflicts.length) {
      const files = await Promise.all(
        result.applied.map(async (path) => ({ path, sha256: await hashFile(join(ws.root, path)).catch(() => null) }))
      )
      const made = result.commit && 'sha' in result.commit ? result.commit : null
      const event = await this.record(id, { type: 'applied', files, conflicts: result.conflicts, ...(made ? { commit: made } : {}) })
      const summary = this.runs.get(id)
      if (summary && result.applied.length) {
        summary.appliedAt = event.ts
        this.emit('runs', this.list())
      }
    }
    return result
  }

  async undo(id: string): Promise<ApplyResult> {
    const ws = await this.workspace(id)
    if (!ws) throw new Error('This run has no workspace.')
    // Commits the applies made are undone with a commit of their own: their
    // files restored by the undo below, then committed alone, as a revert.
    // Each must be on the branch the project is on now, or nothing is done.
    const project = ws.manifest.projectRoot
    const commits = pendingCommits(await this.events(id))
    for (const sha of commits) {
      const reason = await checkRevertable(project, sha)
      if (reason) return { applied: [], conflicts: [{ path: '(commit)', reason }] }
    }
    const infos = await Promise.all(commits.map(async (sha) => ({ sha, ...(await commitInfo(project, sha)) })))
    const result: ApplyResult = await ws.undo()
    const restored = new Set(result.applied)
    // A commit is reverted when every file it holds came back; one with a
    // file left alone stays pending, and the commit says only what it undid.
    const done = infos.filter((c) => c.paths.every((p) => restored.has(p) || !result.conflicts.some((x) => x.path === p)))
    const paths = [...new Set(done.flatMap((c) => c.paths))].filter((p) => restored.has(p))
    if (done.length && paths.length) {
      try {
        await commitPaths(project, paths, revertMessage(done))
        result.reverted = done.map((c) => c.sha)
      } catch (err) {
        result.conflicts.push({ path: '(commit)', reason: `the files were restored, but the revert was not committed: ${(err as Error).message.split('\n')[0]}` })
      }
    }
    if (result.applied.length || result.conflicts.length || result.reverted?.length) {
      await this.record(id, { type: 'undone', files: result.applied, conflicts: result.conflicts, ...(result.reverted?.length ? { reverted: result.reverted } : {}) })
    }
    const summary = this.runs.get(id)
    if (summary && result.conflicts.length === 0) {
      summary.appliedAt = null
      this.emit('runs', this.list())
    }
    return result
  }

  /** Append an event to a finished run's journal, after its last, and pass it on as the loop's events are. */
  private async record(id: string, event: { type: 'applied' | 'undone' } & Record<string, unknown>): Promise<JournalEvent> {
    const journal = new Journal(this.file(id))
    const last = (await journal.read()).at(-1)
    const full = { v: JOURNAL_VERSION, run: id, seq: (last?.seq ?? -1) + 1, ts: Date.now(), ...event } as JournalEvent
    await journal.append(full)
    this.emit('event', full)
    return full
  }

  /**
   * Every coding run gone: journals, the model's words, command outputs,
   * baselines, measurements' journals and every workspace copy. The record
   * of what was measured on a model, and the cache of model hashes, are not
   * runs and stay. Refused while a run or a measurement is going.
   */
  async deleteAllRuns(): Promise<number> {
    if (this.live.size > 0 || this.measuring) throw new Error('Stop the running coding run or measurement first.')
    const count = this.runs.size
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (RUN_FILE.test(name)) await rm(join(this.dir, name), { force: true })
    }
    await rm(join(this.dir, 'workspaces'), { recursive: true, force: true })
    await rm(join(this.dir, 'measure'), { recursive: true, force: true })
    this.runs.clear()
    this.workspaces.clear()
    this.lastMeasure = null
    this.emit('runs', this.list())
    return count
  }

  /**
   * Retention: the workspace copy and command outputs of each run that
   * finished more than `days` ago, removed. Both hold the project's source
   * and what commands printed from it. The journal stays, as the record of
   * what the run did; Changes, Apply and Undo go with the copy.
   */
  async pruneOlderThan(days: number, now = Date.now()): Promise<number> {
    const cutoff = now - days * 24 * 60 * 60 * 1000
    let pruned = 0
    for (const run of this.runs.values()) {
      if (this.live.has(run.id) || run.finishedAt === null || run.finishedAt > cutoff) continue
      const dir = this.workspaceDir(run.id)
      const had = await stat(dir).then(() => true, () => false)
      await rm(dir, { recursive: true, force: true })
      this.workspaces.delete(run.id)
      for (const name of await readdir(this.dir).catch(() => [] as string[])) {
        if (name.startsWith(`${run.id}.cmd-`)) await rm(join(this.dir, name), { force: true })
      }
      if (had) pruned += 1
    }
    return pruned
  }

  async discard(id: string): Promise<void> {
    const ws = await this.workspace(id)
    if (!ws) return
    if (this.live.has(id)) this.cancel(id)
    await ws.discard()
    this.workspaces.delete(id)
  }

  private async workspace(id: string): Promise<Workspace | null> {
    const held = this.workspaces.get(id)
    if (held) return held
    try {
      const ws = await Workspace.open(this.workspaceDir(id))
      this.workspaces.set(id, ws)
      return ws
    } catch {
      return null
    }
  }

  private workspaceDir(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid run id')
    return join(this.dir, 'workspaces', id)
  }

  private file(id: string): string {
    // ids are our own UUIDs, but they cross IPC on the way back in.
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid run id')
    return join(this.dir, `${id}.jsonl`)
  }
}

/**
 * The terms as they will be enforced. An extra root must be a real
 * directory, narrow enough to mean something — not the filesystem, not the
 * home directory — and never this app's own state. Network and install mean
 * nothing outside run mode and are dropped there, so the record never
 * claims a term the run could not have used. A folder that is the project,
 * or inside it, is already granted and is dropped rather than recorded as
 * something beyond the project.
 */
/**
 * Whether the corpus's tests can be run in the box: the box itself, and a
 * node to lend it. Without either, write tasks are checked by the fixed line
 * and recovering from a failing test is not measured.
 */
async function measureBox(): Promise<MeasureBox> {
  const probe = await probeSandbox()
  if (!probe.ok) return { ok: false, reason: probe.reason }
  const found = await findNode()
  return found.node ? { ok: true, reason: null } : { ok: false, reason: found.note }
}

/** The launch, as the record writes one: what decides how the model ran, without ports or paths. */
export function launchOf(config: LaunchConfig): string[] {
  const out = config.autoFit ? ['--fit', 'on'] : ['--gpu-layers', String(config.gpuLayers), '--ctx-size', String(config.contextSize)]
  if (config.cpuMoeLayers === -1) out.push('--cpu-moe')
  else if (config.cpuMoeLayers > 0) out.push('--n-cpu-moe', String(config.cpuMoeLayers))
  out.push('--parallel', String(config.parallel))
  if (config.cacheTypeK !== 'f16' || config.cacheTypeV !== 'f16') out.push('--cache-type-k', config.cacheTypeK, '--cache-type-v', config.cacheTypeV)
  const extra = config.extraArgs.trim()
  return extra ? [...out, ...extra.split(/\s+/).filter((a, i, all) => a !== '--api-key' && all[i - 1] !== '--api-key')] : out
}

export async function checkTerms(terms: GrantTerms, mode: CodingStartRequest['mode'], own: string, projectRoot?: string): Promise<GrantTerms> {
  const project = projectRoot ? await realpath(projectRoot).catch(() => resolve(projectRoot)) : null
  const alsoRead: string[] = []
  for (const dir of terms.alsoRead) {
    const abs = resolve(dir)
    const real = await realpath(abs).catch(() => abs)
    if (project && (real === project || real.startsWith(project + '/'))) continue
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new Error(`The grant names a folder that does not exist: ${dir}`)
    }
    if (!info.isDirectory()) throw new Error(`The grant names something that is not a folder: ${dir}`)
    const broad = await tooBroad(abs, own)
    if (broad === 'own') throw new Error(`The grant cannot name ${dir}: Lowerbeam\u2019s own state lives there.`)
    if (broad) throw new Error(`The grant cannot name ${broad}; choose the folder the task needs.`)
    if (secretReason(real, real)) throw new Error(`The grant cannot name ${dir}: it is a folder of credentials.`)
    if (!alsoRead.includes(abs)) alsoRead.push(abs)
  }
  return { alsoRead, network: mode === 'run' && terms.network, install: mode === 'run' && terms.install }
}

/**
 * The project a run is granted, checked where it is enforced: a real folder,
 * and not one so broad that granting it means granting everything — the
 * filesystem, the home directory or a folder above it, Lowerbeam's own state,
 * or a folder of credentials. Picked in the interface, but a path is a path.
 */
export async function checkProjectRoot(projectRoot: string, own: string): Promise<void> {
  const abs = resolve(projectRoot)
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new Error(`The project folder does not exist: ${projectRoot}`)
  }
  if (!info.isDirectory()) throw new Error(`The project is not a folder: ${projectRoot}`)
  const broad = await tooBroad(abs, own)
  if (broad === 'own') throw new Error(`${projectRoot} cannot be a project: Lowerbeam\u2019s own state lives there.`)
  if (broad) throw new Error(`A project cannot be ${broad}; choose the project\u2019s own folder.`)
  const real = await realpath(abs).catch(() => abs)
  if (secretReason(real, real)) throw new Error(`${projectRoot} cannot be a project: it is a folder of credentials.`)
}

/**
 * Why a folder is too broad to grant whole, or null: the filesystem, the home
 * directory, a folder that holds the home directory, a dot-folder directly in
 * it (`~/.config`, `~/.local`: every program's settings), or anything that holds
 * or sits inside Lowerbeam's own state (`'own'`). Checked as spelled and as
 * resolved, since either can be the one that names home.
 */
async function tooBroad(abs: string, own: string): Promise<string | null> {
  const real = await realpath(abs).catch(() => abs)
  const home = homedir()
  const homes = [home, await realpath(home).catch(() => home)]
  const owns = [own, await realpath(own).catch(() => own)]
  for (const p of [abs, real]) {
    if (p === '/') return 'the whole filesystem'
    if (homes.includes(p)) return 'the whole home directory'
    if (homes.some((h) => h.startsWith(p + '/'))) return `${p}, which holds the home directory`
    if (homes.includes(dirname(p)) && basename(p).startsWith('.')) return `${p}, a settings folder directly in the home directory`
    if (owns.some((o) => o === p || o.startsWith(p + '/') || p.startsWith(o + '/'))) return 'own'
  }
  return null
}

interface Rerun {
  command: string
  exitCode: number | null
  timedOut: boolean
  output: string
  drifted: string[]
  at: number
}

function describe(mode: CodingStartRequest['mode']): string {
  return mode === 'run' ? 'edit and run commands' : mode === 'edit' ? 'edit' : 'inspect'
}

/** Commits applies of this run made that no undo has reverted yet, oldest first. */
export function pendingCommits(events: JournalEvent[]): string[] {
  const pending: string[] = []
  for (const e of events) {
    if (e.type === 'applied' && e.commit) pending.push(e.commit.sha)
    else if (e.type === 'undone') {
      for (const sha of e.reverted ?? []) {
        const at = pending.indexOf(sha)
        if (at >= 0) pending.splice(at, 1)
      }
    }
  }
  return pending
}

/** When the run's changes were last applied and not taken back, from the journal; null if they are not in the project. */
export function appliedFrom(events: JournalEvent[]): number | null {
  let at: number | null = null
  for (const e of events) {
    if (e.type === 'applied' && e.files.length > 0) at = e.ts
    else if (e.type === 'undone' && e.conflicts.length === 0) at = null
  }
  return at
}

/**
 * A summary from a journal alone. A run with a start and no finish was cut
 * off — by a crash or a quit — and is reported as exactly that, never as a
 * result.
 */
export function summarise(events: JournalEvent[]): CodingRunSummary | null {
  const started = events.find((e) => e.type === 'run.started')
  if (!started || started.type !== 'run.started') return null
  const finished = events.find((e) => e.type === 'run.finished')
  const denials = events.filter((e) => e.type === 'tool.result' && e.denied).length
  const mode = started.mode ?? 'inspect'
  const appliedAt = appliedFrom(events)
  if (finished && finished.type === 'run.finished') {
    return {
      id: started.run,
      task: started.task,
      projectRoot: started.grantRoot,
      mode,
      appliedAt,
      model: started.model,
      startedAt: started.ts,
      finishedAt: finished.ts,
      outcome: finished.outcome,
      answer: finished.answer,
      rounds: finished.rounds,
      denials,
      grant: started.grant ?? DEFAULT_TERMS
    }
  }
  const rounds = events.filter((e) => e.type === 'model.request').length
  // A command that was started and never recorded as finished is uncertain:
  // it may have run to completion, or not at all, and it is never re-run on
  // the run's behalf. Whatever it did is in the workspace.
  const lastCommand = [...events].reverse().find((e) => e.type === 'tool.call' && e.name === 'run_command')
  const commandFinished = lastCommand ? events.some((e) => e.type === 'command.finished' && e.seq > lastCommand.seq) : true
  const command = !commandFinished && lastCommand?.type === 'tool.call' ? String(lastCommand.args['command'] ?? '') : null
  return {
    id: started.run,
    task: started.task,
    projectRoot: started.grantRoot,
    mode,
    appliedAt,
    model: started.model,
    startedAt: started.ts,
    finishedAt: events[events.length - 1]?.ts ?? started.ts,
    outcome: 'error',
    answer:
      command !== null
        ? `The app closed while this run was in progress, with a command started and not finished: \`${command}\`. Whether it ran to completion is unknown, and it was not run again. What it had read is in the journal; it produced no answer.`
        : 'The app closed while this run was in progress. What it had read is in the journal; it produced no answer.',
    rounds,
    denials,
    grant: started.grant ?? DEFAULT_TERMS
  }
}
