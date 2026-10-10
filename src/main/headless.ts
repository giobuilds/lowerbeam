/**
 * One coding run from the command line, then exit.
 *
 * The window is not opened. The model is the one the app last launched, or a
 * server that launch left behind. An edit still lands in a copy; this command
 * does not apply it.
 */
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { ProfileStore } from './profiles.js'
import { SettingsStore } from './settings.js'
import { probeAll } from './probe.js'
import { ServerSupervisor } from './supervisor.js'
import { CodingSupervisor } from './coding/supervisor.js'
import { recordSuccessfulLaunches } from './profileRecorder.js'
import { migrateLegacyUserData } from './migrate.js'
import { launchConfigSchema } from '@shared/schema.js'
import { exitCodeFor, formatEvent, pickProfile, type RunCommand } from '@shared/cli.js'
import type { CodingRunSummary } from '@shared/coding.js'
import type { ServerStatus } from '@shared/types.js'

const READY_MS = 10 * 60_000
const dirname = fileURLToPath(new URL('.', import.meta.url))

export async function runHeadless(command: RunCommand): Promise<number> {
  const userData = app.getPath('userData')
  const migrated = await migrateLegacyUserData(userData)
  if (migrated) console.error(`carried settings across from ${migrated}`)

  const settings = new SettingsStore(join(userData, 'settings.json'))
  await settings.load()
  const project = command.project ?? settings.current.lastProject ?? null
  if (!project) throw new Error('Pass --project, or open a project in the Coding tab once so this command can reuse it.')

  const profiles = new ProfileStore(join(userData, 'profiles.json'))
  await profiles.load()
  const discovered = await probeAll(settings.current.binaryPath ?? process.env['LLAMA_SERVER_PATH'])
  const binary = discovered.find((item) => item.path === settings.current.binaryPath) ?? discovered[0]
  if (!binary?.path) throw new Error('No llama.cpp binary found. Set one in the app, or put llama on PATH.')

  const server = new ServerSupervisor(binary, join(userData, 'server.json'))
  recordSuccessfulLaunches(server, profiles)
  const corpus = app.isPackaged ? join(process.resourcesPath, 'measure', 'corpus') : join(dirname, '../../resources/measure/corpus')
  const coding = new CodingSupervisor(join(userData, 'coding'), () => server, existsSync(corpus) ? corpus : null)
  await coding.load()

  const stop = new AbortController()
  let runId = ''
  process.once('SIGINT', () => {
    console.error('\nstopping')
    stop.abort()
    if (runId) coding.cancel(runId)
  })

  try {
    await server.adoptOrReap()
    if (server.status.phase !== 'ready') {
      const profile = pickProfile(profiles.list(), command.model)
      if (!profile) {
        throw new Error(
          command.model
            ? `No saved launch matches ${command.model}. Launch that model in the app once.`
            : 'No model has been launched from the app yet. Launch one there once, then run this again.'
        )
      }
      console.error(`loading ${profile.modelName}`)
      const config = launchConfigSchema.parse({ ...profile.config, modelPath: profile.modelPath })
      await server.start(config, settings.current.localApi)
      await waitUntilReady(server, stop.signal)
    } else if (command.model && !modelMatches(server.status, command.model)) {
      const loaded = server.status.config?.modelPath ?? 'the running server'
      throw new Error(`${basename(loaded)} is already loaded. Quit and stop it before asking for ${command.model}.`)
    } else {
      console.error(`using the model already running on port ${server.status.port}`)
    }
    if (stop.signal.aborted) return 1

    console.error(`${command.mode} ${project}`)
    coding.on('event', (event) => {
      const line = formatEvent(event)
      if (line) console.log(line)
    })
    const finished = waitForFinish(coding, () => runId)
    // A router has to be told which model. A single launch has only one.
    const requestModel = server.status.router && command.model ? command.model : undefined
    const summary = await coding.start({
      projectRoot: project,
      task: command.task,
      mode: command.mode,
      ...(requestModel ? { model: requestModel } : {})
    })
    runId = summary.id
    await settings.patch({ lastProject: project })
    const result = await finished
    if (result.answer) {
      console.log('---')
      console.log(result.answer)
    }
    if (command.mode !== 'inspect') {
      const changes = await coding.changes(result.id)
      const files = changes?.files ?? []
      if (files.length) {
        console.error('copy left unapplied:')
        for (const file of files) console.error(`  ${file.kind} ${file.path}`)
      } else {
        console.error('the copy has no changes')
      }
    }
    return result.outcome === 'running' ? 1 : exitCodeFor(result.outcome)
  } finally {
    coding.shutdown()
    await server.shutdown()
  }
}

function modelMatches(status: ServerStatus, model: string): boolean {
  const path = status.config?.modelPath
  if (!path) return status.router !== null
  const needle = model.toLowerCase()
  return path === model || path.toLowerCase().endsWith(`/${needle}`) || basename(path).toLowerCase() === needle
}

function waitUntilReady(server: ServerSupervisor, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Stopped.'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The model did not become ready in time.')), READY_MS)
    const onAbort = (): void => finish(new Error('Stopped.'))
    const onStatus = (status: ServerStatus): void => {
      if (status.phase === 'ready') finish(null)
      else if (status.phase === 'crashed' || status.phase === 'stopped') {
        finish(new Error(status.error ?? 'The model stopped before it was ready.'))
      }
    }
    const finish = (err: Error | null): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.off('status', onStatus)
      if (err) reject(err)
      else resolve()
    }
    signal.addEventListener('abort', onAbort)
    server.on('status', onStatus)
    if (server.status.phase === 'ready') finish(null)
  })
}

/**
 * Resolves with the summary once the run is no longer in progress.
 *
 * The id is read when an event arrives, because the run does not exist until
 * `start` returns and the listener has to be in place before that.
 */
function waitForFinish(coding: CodingSupervisor, runId: () => string): Promise<CodingRunSummary> {
  return new Promise((resolve) => {
    const onRuns = (runs: CodingRunSummary[]): void => {
      const id = runId()
      const current = id ? runs.find((run) => run.id === id) : undefined
      if (current && current.outcome !== 'running') {
        coding.off('runs', onRuns)
        resolve(current)
      }
    }
    coding.on('runs', onRuns)
  })
}
