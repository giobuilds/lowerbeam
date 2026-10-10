import { randomUUID } from 'node:crypto'
import { Grant } from '../../agent/grant.js'
import { runTask, type RunRequest, type RunResult } from '../../agent/loop.js'
import {
  CANCEL_GRACE_MS,
  type AgentJob,
  type AgentPort,
  type ChildPort,
  type ChildToParent,
  type ParentToChild
} from './agentProtocol.js'

export interface DriveOptions {
  job: AgentJob
  signal: AbortSignal
  onEvent: RunRequest['onEvent']
  keep: NonNullable<RunRequest['keep']>
  /** Present for a run that may execute commands. The sandbox stays in this process. */
  execute?: RunRequest['execute']
}

/**
 * Drive one loop running in another process. Settles with the loop's result,
 * or rejects when the process reports an error or exits without one.
 */
export function driveAgent(port: AgentPort, opts: DriveOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const execAborts = new Map<string, AbortController>()
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (grace) clearTimeout(grace)
      fn()
    }

    port.onMessage((msg: ChildToParent) => {
      if (msg.type === 'event') {
        opts.onEvent(msg.event)
      } else if (msg.type === 'keep') {
        Promise.resolve(opts.keep(msg.round, msg.words)).then(
          () => port.postMessage({ type: 'kept', round: msg.round }),
          (err: unknown) => port.postMessage({ type: 'kept', round: msg.round, error: messageOf(err) })
        )
      } else if (msg.type === 'exec') {
        if (!opts.execute) {
          port.postMessage({ type: 'exec-result', id: msg.id, ok: false, error: 'This run cannot run commands.' })
          return
        }
        const commandAbort = new AbortController()
        execAborts.set(msg.id, commandAbort)
        const onRunAbort = (): void => commandAbort.abort()
        if (opts.signal.aborted) commandAbort.abort()
        else opts.signal.addEventListener('abort', onRunAbort, { once: true })
        const execute = opts.execute
        execute(msg.command, commandAbort.signal).then(
          (result) => {
            opts.signal.removeEventListener('abort', onRunAbort)
            execAborts.delete(msg.id)
            port.postMessage({ type: 'exec-result', id: msg.id, ok: true, result })
          },
          (err: unknown) => {
            opts.signal.removeEventListener('abort', onRunAbort)
            execAborts.delete(msg.id)
            port.postMessage({ type: 'exec-result', id: msg.id, ok: false, error: messageOf(err) })
          }
        )
      } else if (msg.type === 'exec-abort') {
        execAborts.get(msg.id)?.abort()
      } else if (msg.type === 'result') {
        settle(() => resolve(msg.result))
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.message)))
      }
    })

    port.onExit((code) => {
      settle(() => reject(new Error(code === 0 ? 'The run process stopped.' : `The run process stopped (${code}).`)))
    })

    const onCancel = (): void => {
      port.postMessage({ type: 'cancel' })
      grace = setTimeout(() => {
        port.kill()
        settle(() => reject(new Error('The run process stopped.')))
      }, CANCEL_GRACE_MS)
      grace.unref?.()
    }
    if (opts.signal.aborted) onCancel()
    else opts.signal.addEventListener('abort', onCancel, { once: true })

    port.postMessage({ type: 'start', job: opts.job })
  })
}

/**
 * Run one job on the utility-process side. Opens the grant here and calls the
 * loop. The default `run` is the real loop; a test can pass its own.
 */
export async function serveAgent(port: ChildPort, run: (req: RunRequest) => Promise<RunResult> = runTask): Promise<void> {
  const abort = new AbortController()
  const execWaiters = new Map<string, (msg: Extract<ParentToChild, { type: 'exec-result' }>) => void>()
  const keptWaiters = new Map<number, (msg: Extract<ParentToChild, { type: 'kept' }>) => void>()
  let job: AgentJob | null = null
  let waiting: ((job: AgentJob) => void) | null = null

  port.onMessage((msg) => {
    if (msg.type === 'start') {
      if (waiting) waiting(msg.job)
      else job = msg.job
    } else if (msg.type === 'cancel') {
      abort.abort()
    } else if (msg.type === 'exec-result') {
      execWaiters.get(msg.id)?.(msg)
    } else if (msg.type === 'kept') {
      keptWaiters.get(msg.round)?.(msg)
    }
  })

  const got = job ?? (await new Promise<AgentJob>((resolve) => {
    waiting = resolve
  }))
  try {
    const grant = await Grant.open(got.grantRoot, got.mode, got.alsoRead)
    const result = await run({
      baseUrl: got.baseUrl,
      apiKey: got.apiKey,
      model: got.model,
      requestModel: got.requestModel,
      task: got.task,
      grant,
      settings: got.settings,
      maxRounds: got.maxRounds,
      timeoutMs: got.timeoutMs,
      signal: abort.signal,
      runId: got.runId,
      contextLimit: got.contextLimit,
      mode: got.mode,
      terms: got.terms,
      execute:
        got.mode === 'run'
          ? (command, signal) => {
              const id = randomUUID()
              return new Promise((resolve, reject) => {
                const onAbort = (): void => port.postMessage({ type: 'exec-abort', id })
                signal.addEventListener('abort', onAbort, { once: true })
                execWaiters.set(id, (msg) => {
                  signal.removeEventListener('abort', onAbort)
                  execWaiters.delete(id)
                  if (msg.ok) resolve(msg.result)
                  else reject(new Error(msg.error))
                })
                port.postMessage({ type: 'exec', id, command })
              })
            }
          : undefined,
      onEvent: (event) => port.postMessage({ type: 'event', event }),
      keep: (round, words) =>
        new Promise((resolve, reject) => {
          keptWaiters.set(round, (msg) => {
            keptWaiters.delete(round)
            if (msg.error) reject(new Error(msg.error))
            else resolve()
          })
          port.postMessage({ type: 'keep', round, words })
        })
    })
    port.postMessage({ type: 'result', result })
  } catch (err) {
    port.postMessage({ type: 'error', message: messageOf(err) })
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
