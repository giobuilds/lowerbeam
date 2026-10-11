import type { ServedModel, ServerStatus } from './types.js'

/**
 * Which model a request uses, whatever kind of launch is running.
 *
 * Everything that sends a request — chat, compaction, a coding run, a
 * measurement — asks here for the model it picked, and takes its context,
 * tools, modalities and file from the answer rather than from the launch.
 * With one model there is one answer; in router mode each model has its own
 * and the request has to name it.
 */

/** The name a model goes by in requests: its file name without the extension. */
export function modelIdOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.gguf$/i, '')
}

/** Every model the running server answers for. Empty when nothing is running. */
export function servedModels(status: ServerStatus | null | undefined): ServedModel[] {
  if (!status || status.phase === 'stopped' || status.phase === 'crashed') return []
  if (status.router) return status.router.models
  if (!status.config) return []
  return [
    {
      id: status.config.alias || modelIdOf(status.config.modelPath),
      modelPath: status.config.modelPath,
      state: status.phase === 'ready' || status.phase === 'degraded' ? 'loaded' : 'loading',
      contextPerSlot: status.contextPerSlot,
      supportsTools: status.supportsTools,
      modalities: status.modalities,
      embed: Boolean(status.config.embed)
    }
  ]
}

/** Models that chat or code. An embedding model is not one of them. */
export function generationModels(status: ServerStatus | null | undefined): ServedModel[] {
  return servedModels(status).filter((m) => !m.embed)
}

/**
 * The first embedding model on a router, when one was marked. Two marked
 * models use the earliest in the router's list. Null when there is none.
 */
export function embeddingModel(status: ServerStatus | null | undefined): ServedModel | null {
  return servedModels(status).find((m) => m.embed) ?? null
}

/**
 * The model a request would use: the one asked for if the server has it,
 * otherwise a generation model that is loaded, otherwise the first of those.
 * An embedding model is used only when it was named. Asking for nothing must
 * not land on it. Null when nothing runs.
 */
export function servedModel(status: ServerStatus | null | undefined, wanted?: string | null): ServedModel | null {
  const models = servedModels(status)
  if (wanted) {
    const named = models.find((m) => m.id === wanted)
    if (named) return named
  }
  const generation = models.filter((m) => !m.embed)
  return generation.find((m) => m.state === 'loaded') ?? generation[0] ?? null
}

/** Unique request names for a router's models, from their file names. */
export function routerIds(paths: string[]): string[] {
  const seen = new Map<string, number>()
  return paths.map((p) => {
    const base = modelIdOf(p)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}
