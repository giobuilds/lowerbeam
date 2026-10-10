/**
 * The command line in front of the window.
 *
 * `lowerbeam` with no subcommand is the app. `lowerbeam run` is one coding
 * run, printed as it happens, and then the process exits. Parsing lives here
 * so a test can refuse a bad invocation without starting Electron.
 */
import type { CodingMode, JournalEvent, RunOutcome } from './coding.js'

const MODES: readonly CodingMode[] = ['inspect', 'edit', 'run']

export interface RunCommand {
  kind: 'run'
  /** Null means the project the Coding tab last had open. */
  project: string | null
  task: string
  mode: CodingMode
  /** A saved model name, or a router model id. Null is the last launch. */
  model: string | null
}

export type CliCommand = { kind: 'app' } | { kind: 'help' } | { kind: 'error'; message: string } | RunCommand

export function cliHelp(): string {
  return [
    'lowerbeam run --task TEXT [--project DIR] [--mode inspect|edit|run] [--model NAME]',
    '',
    'Ask the model to work on a project without opening the window. Quit the app',
    'first if it is open. The model is the one last launched there, or a server',
    'that session left running, and it is stopped when the run ends.',
    'The default mode is inspect: list, search and read. edit and run work on a',
    'copy and do not change the project; apply the copy from the Coding tab.',
    '',
    '--project DIR   Project folder. Defaults to the Coding tab\'s last project.',
    '--task TEXT     What to ask. Required.',
    '--mode MODE     inspect (default), edit, or run.',
    '--model NAME    Which saved model to launch, or which router model to use.',
    '',
    'Exits 0 when the run answers. Any other outcome exits 1.'
  ].join('\n')
}

/**
 * Read our arguments out of Electron's argv.
 *
 * Everything before the `run` token belongs to Electron or to the path of the
 * app, and is ignored. No `run` token means open the window.
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const runAt = argv.findIndex((arg, index) => arg === 'run' && index > 0)
  if (runAt < 0) return { kind: 'app' }
  const rest = argv.slice(runAt + 1)
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help' }

  let project: string | null = null
  let task: string | null = null
  let mode: CodingMode = 'inspect'
  let model: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--project' || arg === '--task' || arg === '--mode' || arg === '--model') {
      const value = rest[++i]
      if (!value || value.startsWith('--')) return { kind: 'error', message: `${arg} needs a value.` }
      if (arg === '--project') project = value
      else if (arg === '--task') task = value
      else if (arg === '--model') model = value
      else if (!isMode(value)) return { kind: 'error', message: '--mode must be inspect, edit, or run.' }
      else mode = value
      continue
    }
    if (arg.startsWith('--')) return { kind: 'error', message: `Unknown option ${arg}.` }
    return { kind: 'error', message: `Unexpected argument ${arg}.` }
  }
  if (!task?.trim()) return { kind: 'error', message: '--task is required.' }
  return { kind: 'run', project, task: task.trim(), mode, model }
}

function isMode(value: string): value is CodingMode {
  return (MODES as readonly string[]).includes(value)
}

/** One line for the terminal. The answer itself is printed once, at the end. */
export function formatEvent(event: JournalEvent): string | null {
  switch (event.type) {
    case 'run.started':
      return `started ${event.mode ?? 'inspect'} on ${event.model}`
    case 'project.facts':
      return event.files.length ? `notes ${event.files.map((file) => file.path).join(', ')}` : null
    case 'model.request':
      return `round ${event.round}`
    case 'model.response':
      return event.say ? `say ${oneLine(event.say)}` : null
    case 'tool.call':
      return `tool ${event.name}`
    case 'tool.result':
      return `${event.denied ? 'denied' : event.ok ? 'ok' : 'failed'} ${oneLine(event.summary)}`
    case 'command.finished':
      return `command ${event.exitCode ?? 'no exit'} ${oneLine(event.command)}`
    case 'checkpoint':
      return `checkpoint ${event.reason}`
    case 'reminder':
      return `reminder before round ${event.round}`
    case 'applied':
    case 'undone':
    case 'run.finished':
      return null
    default:
      return null
  }
}

export function exitCodeFor(outcome: RunOutcome): number {
  return outcome === 'answered' ? 0 : 1
}

/** The saved launch to start when nothing is already running. The latest one, unless a name is given. */
export function pickProfile<T extends { modelName: string; modelPath: string; lastUsedAt: number }>(
  profiles: readonly T[],
  model: string | null
): T | null {
  if (profiles.length === 0) return null
  const latest = [...profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  if (!model) return latest[0] ?? null
  const needle = model.toLowerCase()
  return (
    latest.find((profile) => {
      const name = profile.modelName.toLowerCase()
      return name === needle || profile.modelPath === model || profile.modelPath.toLowerCase().endsWith(`/${needle}`)
    }) ?? null
  )
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}
