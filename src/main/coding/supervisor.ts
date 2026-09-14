import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpath, stat } from 'node:fs/promises'
import { DEFAULT_TERMS, type CodingRunSummary, type CodingStartRequest, type GrantTerms, type JournalEvent } from '@shared/coding.js'
import { Grant } from '../../agent/grant.js'
import { runTask } from '../../agent/loop.js'
import type { ServerSupervisor } from '../supervisor.js'
import { Journal } from './journal.js'
import { Workspace } from './workspace.js'
import { probeSandbox, runInSandbox } from './sandbox.js'
import { ModelIdentifier } from './capability.js'
import { verdictFor, type CapabilityStatus } from '@shared/capability.js'
import { evidenceFrom, withRerun, type Evidence } from '@shared/evidence.js'
import { hashFile } from './workspace.js'
import { writeFile } from 'node:fs/promises'
import type { ApplyResult, ChangeSet } from '@shared/coding.js'

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
}> {
  private readonly runs = new Map<string, CodingRunSummary>()
  private readonly live = new Map<string, { abort: AbortController; journal: Journal }>()
  private readonly workspaces = new Map<string, Workspace>()
  private readonly identifier: ModelIdentifier

  constructor(
    private readonly dir: string,
    private readonly inference: () => ServerSupervisor | null
  ) {
    super()
    this.identifier = new ModelIdentifier(join(dir, 'model-hashes.json'))
  }

  /** Rebuild the list from what is on disk, oldest first. */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
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
    const id = randomUUID()
    // Grant.open resolves the root and throws if it does not exist, which is
    // the right time to find out — not on the first tool call. An edit run's
    // grant is on a copy of the project, never the project.
    let grant: Grant
    let workspace: Workspace | null = null
    // A mode the record refuses for this model is refused here, with the
    // measurement, whatever the interface offered. An unmeasured model is
    // offered every mode; the record says so and the journal is the evidence.
    const verdict = verdictFor(await this.identifier.status(status.config?.modelPath), req.mode)
    if (verdict.verdict === 'refused') throw new Error(`This model is not cleared to ${describe(req.mode)}: ${verdict.evidence}`)
    // The terms are checked here, where they are enforced, whatever the
    // interface offered: an extra root must be a real directory, narrow
    // enough to mean something, and never this app's own state.
    const terms = await this.checkTerms(req.grant ?? DEFAULT_TERMS, req.mode, req.projectRoot)
    if (req.mode === 'run') {
      // No box, no run mode: it is refused here, with the reason, rather than
      // running anything unsandboxed and calling that a sandbox.
      const probe = await probeSandbox()
      if (!probe.ok) throw new Error(`Commands cannot be run on this machine: ${probe.reason}`)
    }
    if (req.mode === 'edit' || req.mode === 'run') {
      workspace = await Workspace.create((await Grant.open(req.projectRoot)).root, this.workspaceDir(id))
      this.workspaces.set(id, workspace)
      grant = await Grant.open(workspace.root, req.mode, terms.alsoRead)
    } else {
      grant = await Grant.open(req.projectRoot, 'inspect', terms.alsoRead)
    }
    const model = status.config?.modelPath?.split('/').pop() ?? 'unknown model'
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
      grant: terms
    }
    this.runs.set(id, summary)
    this.emit('runs', this.list())

    // Not awaited: the caller gets the summary at once and follows events.
    void this.drive(id, summary, grant, journal, abort, `http://127.0.0.1:${status.port}`, req.task, status.contextPerSlot, req.mode, terms)
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
    terms: GrantTerms
  ): Promise<void> {
    // Each command's full output is kept beside the journal, numbered in the
    // order the journal has them, so the evidence can find the output of the
    // k-th command from the k-th command.finished event.
    let commands = 0
    try {
      const result = await runTask({
        baseUrl,
        model: summary.model,
        task,
        grant,
        settings: { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 },
        maxRounds: 12,
        timeoutMs: 6 * 60_000,
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
                await writeFile(join(this.dir, `${id}.cmd-${commands}.txt`), `$ ${command}\n${output}`)
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
        }
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

  /** What the record says about a model file that is not running: for a launch being prepared. */
  capabilityOf(path: string): Promise<CapabilityStatus> {
    return this.identifier.status(path)
  }

  /** What the capability record says about the model that is loaded now, and the context it is running with. */
  async capability(): Promise<CapabilityStatus> {
    const status = this.inference()?.status
    const found = await this.identifier.status(status?.phase === 'ready' ? status.config?.modelPath : null)
    return found.state === 'measured' ? { ...found, contextPerSlot: status?.contextPerSlot ?? null } : found
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
      await writeFile(join(this.dir, `${id}.baseline.json`), JSON.stringify(rerun))
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

  async apply(id: string): Promise<ApplyResult> {
    const ws = await this.workspace(id)
    if (!ws) throw new Error('This run has no workspace to apply.')
    if (this.live.has(id)) throw new Error('Wait for the run to finish, or stop it, before applying.')
    const result = await ws.apply()
    const summary = this.runs.get(id)
    if (summary && result.applied.length) {
      summary.appliedAt = Date.now()
      this.emit('runs', this.list())
    }
    return result
  }

  async undo(id: string): Promise<ApplyResult> {
    const ws = await this.workspace(id)
    if (!ws) throw new Error('This run has no workspace.')
    const result = await ws.undo()
    const summary = this.runs.get(id)
    if (summary && result.conflicts.length === 0) {
      summary.appliedAt = null
      this.emit('runs', this.list())
    }
    return result
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
export async function checkTerms(terms: GrantTerms, mode: CodingStartRequest['mode'], own: string, projectRoot?: string): Promise<GrantTerms> {
  const home = homedir()
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
    if (abs === '/' || abs === home) throw new Error(`The grant cannot name ${abs === '/' ? 'the whole filesystem' : 'the whole home directory'}; choose the folder the task needs.`)
    if (abs === own || own.startsWith(abs + '/')) throw new Error(`The grant cannot name ${dir}: Lowerbeam\u2019s own state lives there.`)
    if (!alsoRead.includes(abs)) alsoRead.push(abs)
  }
  return { alsoRead, network: mode === 'run' && terms.network, install: mode === 'run' && terms.install }
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
  if (finished && finished.type === 'run.finished') {
    return {
      id: started.run,
      task: started.task,
      projectRoot: started.grantRoot,
      mode,
      appliedAt: null,
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
    appliedAt: null,
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
