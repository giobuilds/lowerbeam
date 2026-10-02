import { basename } from 'node:path'
import type { ServerStatus } from '@shared/types.js'
import type { ServerSupervisor } from './supervisor.js'
import { authHeaders } from '@shared/chatClient.js'
import { modelKey, type ProfileStore } from './profiles.js'

/**
 * Writes a launch profile once a server has actually reached `ready`.
 *
 * Recording on launch instead would save configurations that crash, which is
 * the opposite of useful — the whole point is a known-good starting position
 * for next time.
 */
export function recordSuccessfulLaunches(
  supervisor: ServerSupervisor,
  profiles: ProfileStore
): void {
  let lastPhase: ServerStatus['phase'] = 'stopped'

  supervisor.on('status', (status) => {
    const entering = status.phase === 'ready' && lastPhase !== 'ready'
    lastPhase = status.phase
    if (!entering || !status.config || status.adopted) return

    // Fire and forget: a failure to persist a convenience should never
    // interfere with a server that is now running.
    void saveProfile(profiles, status).catch(() => {})
  })
}

async function saveProfile(profiles: ProfileStore, status: ServerStatus): Promise<void> {
  const config = status.config
  if (!config) return
  const { modelPath, ...rest } = config

  // Under auto-fit the requested context is unset, so what llama.cpp actually
  // chose is only discoverable by asking the running server.
  let actualContext: number | null = null
  try {
    if (status.port) {
      const res = await fetch(`http://127.0.0.1:${status.port}/props`, {
        headers: authHeaders(status.apiKey),
        signal: AbortSignal.timeout(3000)
      })
      if (res.ok) {
        const props = (await res.json()) as {
          default_generation_settings?: { n_ctx?: number }
        }
        actualContext = props.default_generation_settings?.n_ctx ?? null
      }
    }
  } catch {
    // Telemetry only; absence is not worth failing the write for.
  }

  await profiles.put({
    key: await modelKey(modelPath),
    modelPath,
    modelName: basename(modelPath),
    config: rest,
    lastUsedAt: Date.now(),
    loadMs: status.readyAt && status.startedAt ? status.readyAt - status.startedAt : null,
    actualContext
  })
}
