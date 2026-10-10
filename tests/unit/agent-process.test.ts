import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TERMS, type JournalEvent } from '@shared/coding.js'
import type { RunRequest, RunResult } from '../../src/agent/loop.js'
import { driveAgent, serveAgent } from '../../src/main/coding/agentSession.js'
import type { AgentJob, AgentPort, ChildPort, ChildToParent, ParentToChild } from '../../src/main/coding/agentProtocol.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

const settings = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }
const runId = '11111111-2222-4333-8444-0000000000aa'

function answered(over: Partial<RunResult> = {}): RunResult {
  return {
    run: runId,
    outcome: 'answered',
    answer: 'done',
    rounds: 1,
    ms: 5,
    tokens: { promptTokens: 1, predictedTokens: 2 },
    denials: 0,
    reads: [],
    compactions: 0,
    ...over
  }
}

function link(): { parent: AgentPort; child: ChildPort; exit: (code: number) => void } {
  let toChild: ((message: ParentToChild) => void) | null = null
  let toParent: ((message: ChildToParent) => void) | null = null
  const forChild: ParentToChild[] = []
  const forParent: ChildToParent[] = []
  let onExit: ((code: number) => void) | null = null
  const send = <T>(listener: ((message: T) => void) | null, queued: T[], message: T): void => {
    if (listener) queueMicrotask(() => listener(message))
    else queued.push(message)
  }
  return {
    parent: {
      postMessage: (message) => send(toChild, forChild, message),
      onMessage: (listener) => {
        toParent = listener
        for (const message of forParent.splice(0)) queueMicrotask(() => listener(message))
      },
      onExit: (listener) => {
        onExit = listener
      },
      kill: () => {}
    },
    child: {
      postMessage: (message) => send(toParent, forParent, message),
      onMessage: (listener) => {
        toChild = listener
        for (const message of forChild.splice(0)) queueMicrotask(() => listener(message))
      }
    },
    exit: (code) => onExit?.(code)
  }
}

const base = await mkdtemp(join(tmpdir(), 'agent-process-'))
const project = join(base, 'project')
const extra = join(base, 'notes')
await mkdir(project)
await mkdir(extra)

function job(mode: AgentJob['mode']): AgentJob {
  return {
    baseUrl: 'http://127.0.0.1:9',
    apiKey: null,
    model: 'm',
    requestModel: 'm',
    task: 'where is it',
    grantRoot: project,
    mode,
    alsoRead: [extra],
    settings,
    maxRounds: 12,
    timeoutMs: 1000,
    runId,
    contextLimit: 4096,
    terms: DEFAULT_TERMS
  }
}

console.log('a run’s loop is the other side of the messages')
{
  const events: JournalEvent[] = []
  const kept: Array<{ round: number; content: string }> = []
  const commands: string[] = []
  const { parent, child } = link()
  const event = { v: 1, run: runId, seq: 0, ts: 1, type: 'run.started', task: 'where is it', model: 'm', grantRoot: project } as JournalEvent
  const fake = async (req: RunRequest): Promise<RunResult> => {
    assert.equal(req.runId, runId); assert.equal(req.grant.mode, 'run'); ok('the run id and the mode cross')
    assert.equal(req.grant.realRoot, await realpath(project)); ok('the grant is opened on the copy, in that process')
    assert.equal(req.grant.alsoRead[0]?.realRoot, await realpath(extra)); ok('an extra read root is opened there too')
    assert.equal(req.maxRounds, 12); assert.equal(req.contextLimit, 4096); ok('the round cap and the window cross')
    req.onEvent(event)
    const done = await req.execute!('npm test', req.signal!)
    assert.equal(done.output, 'ok'); ok('a command’s output comes back from the main process')
    await req.keep!(1, { reasoning: 'think', content: 'say' })
    return answered()
  }
  const served = serveAgent(child, fake)
  const result = await driveAgent(parent, {
    job: job('run'),
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    keep: (round, words) => {
      kept.push({ round, content: words.content })
    },
    execute: async (command) => {
      commands.push(command)
      return { exitCode: 0, output: 'ok', truncated: false, timedOut: false, ms: 4 }
    }
  })
  await served
  assert.equal(result.answer, 'done'); assert.equal(result.outcome, 'answered'); ok('the result comes back')
  assert.deepEqual(events.map((e) => e.type), ['run.started']); ok('an event comes back, and the page is not involved')
  assert.deepEqual(commands, ['npm test']); ok('the command is run by the caller, not by the loop’s process')
  assert.deepEqual(kept, [{ round: 1, content: 'say' }]); ok('the model’s words come back for the journal')
}

console.log('\na command that fails is the loop’s error')
{
  const { parent, child } = link()
  const served = serveAgent(child, async (req) => {
    await req.execute!('npm test', req.signal!)
    return answered()
  })
  await assert.rejects(
    driveAgent(parent, {
      job: job('run'),
      signal: new AbortController().signal,
      onEvent: () => {},
      keep: () => {},
      execute: async () => {
        throw new Error('box failed')
      }
    }),
    /box failed/
  )
  await served
  ok('the sandbox error reaches the run')
}

console.log('\ncancelling aborts the loop and it can still finish')
{
  const { parent, child } = link()
  const abort = new AbortController()
  const served = serveAgent(child, async (req) => {
    if (!req.signal?.aborted) await new Promise<void>((resolve) => req.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return answered({ outcome: 'cancelled', answer: '' })
  })
  const pending = driveAgent(parent, {
    job: job('inspect'),
    signal: abort.signal,
    onEvent: () => {},
    keep: () => {}
  })
  setTimeout(() => abort.abort(), 20)
  const result = await pending
  await served
  assert.equal(result.outcome, 'cancelled'); ok('a cancel lets the loop finish as cancelled')
}

console.log('\nthe process exiting without a result is a stopped run')
{
  const { parent, exit } = link()
  const pending = driveAgent(parent, {
    job: job('inspect'),
    signal: new AbortController().signal,
    onEvent: () => {},
    keep: () => {}
  })
  exit(1)
  await assert.rejects(pending, /The run process stopped \(1\)/)
  ok('an exit with no result is refused')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
