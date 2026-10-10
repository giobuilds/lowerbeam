import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { driveAgent, type DriveOptions } from './agentSession.js'
import type { AgentPort } from './agentProtocol.js'
import type { RunResult } from '../../agent/loop.js'

/**
 * Run the loop in a utility process and return its result.
 *
 * The process is not a sandbox. It only holds the loop, so a fault there
 * stops the run and not the app. Commands are still executed by `execute`,
 * which the caller runs here.
 */
export async function runLoopInUtilityProcess(opts: DriveOptions): Promise<RunResult> {
  const script = agentScript()
  const { utilityProcess } = await import('electron')
  const child = utilityProcess.fork(script, [], { serviceName: 'coding-run' })
  const port: AgentPort = {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', listener)
    },
    kill: () => {
      child.kill()
    }
  }
  try {
    return await driveAgent(port, opts)
  } finally {
    try {
      child.kill()
    } catch {
      // The process has already gone.
    }
  }
}

/** The built entry beside this process's own file. Dev and a package both emit it there. */
function agentScript(): string {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  for (const name of ['agentProcess.js', 'agentProcess.mjs']) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  throw new Error('The coding run process is missing from this copy of the app.')
}
