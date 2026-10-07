import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BinaryInfo, LaunchConfig, SpeculationMeasure } from '@shared/types.js'
import { DEFAULT_LOCAL_API } from '@shared/types.js'
import { ServerSupervisor } from './supervisor.js'

/**
 * Speculative decoding, measured rather than promised.
 *
 * The same launch is started twice on a free port — once without
 * speculation, once with the chosen kind — and given the same two requests:
 * a code rewrite, where most of the output repeats the input and a draft is
 * usually right, and a short story, where it is right less often. The gain
 * is the generation speed of one against the other, as the server reports
 * it, with how many drafted tokens it accepted. On Ornith 9B on an RX 6600
 * the MTP head took a code rewrite from 36 to 61 tokens a second and prose
 * from 36 to 41; an n-gram lookup changed neither.
 */

const CODE = `export function parseLine(line: string): Entry | null {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return null
  const parts = text.split(',').map((p) => p.trim())
  if (parts.length !== 3) throw new Error(\`expected date, category, amount: \${line}\`)
  const [date, category, amount] = parts
  if (!isIsoDate(date)) throw new Error(\`not a date: \${date}\`)
  return { date, category: normalise(category), cents: toCents(amount) }
}

export function parseLog(text: string): Entry[] {
  return text.split('\\n').map(parseLine).filter((e): e is Entry => e !== null)
}

export function monthlyTotals(entries: Entry[]): Record<string, number> {
  const totals = new Map<string, number>()
  for (const e of entries) {
    const month = e.date.slice(0, 7)
    totals.set(month, (totals.get(month) ?? 0) + e.cents)
  }
  return Object.fromEntries([...totals].sort(([a], [b]) => (a < b ? -1 : 1)))
}`

const PROMPTS = {
  code: `Rewrite this TypeScript exactly, changing only the name of the function parseLine to readLine everywhere. Output the whole code, nothing else.\n\n${CODE}`,
  prose: 'Write a short story, about 200 words, about a lighthouse keeper who finds a message in a bottle.'
} as const

const TOKENS = 256
const READY_TIMEOUT_MS = 5 * 60_000

export async function measureSpeculation(
  binary: BinaryInfo,
  config: LaunchConfig,
  onProgress: (step: string) => void = () => {}
): Promise<SpeculationMeasure> {
  const mode = config.speculative ?? 'off'
  if (mode === 'off') throw new Error('Choose a kind of speculative decoding to measure.')
  const without = await run(binary, { ...config, speculative: 'off', parallel: 1 }, (s) => onProgress(`without speculation: ${s}`))
  const withIt = await run(binary, { ...config, parallel: 1 }, (s) => onProgress(`with ${mode}: ${s}`))
  return { mode, draftModelPath: mode === 'draft' ? (config.draftModelPath ?? null) : null, modelPath: config.modelPath, without, with: withIt, measuredAt: Date.now() }
}

async function run(binary: BinaryInfo, config: LaunchConfig, onProgress: (step: string) => void): Promise<SpeculationMeasure['with']> {
  const dir = await mkdtemp(join(tmpdir(), 'lowerbeam-spec-'))
  const server = new ServerSupervisor(binary, join(dir, 'server.json'))
  try {
    onProgress('loading the model')
    await server.start(config, DEFAULT_LOCAL_API)
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (server.status.phase !== 'ready') {
      if (server.status.phase === 'crashed') throw new Error(server.status.error ?? 'the server stopped while loading')
      if (Date.now() > deadline) throw new Error('the model did not load in five minutes')
      await new Promise((r) => setTimeout(r, 300))
    }
    const result = { code: 0, prose: 0, drafted: 0, accepted: 0 }
    for (const kind of ['code', 'prose'] as const) {
      onProgress(kind === 'code' ? 'a code rewrite' : 'a short story')
      const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: PROMPTS[kind] }],
          max_tokens: TOKENS,
          temperature: 0.2,
          top_p: 0.95,
          top_k: 40,
          min_p: 0.05,
          // A thinking model's reasoning is generation like any other, but
          // its length varies run to run; off keeps the two runs comparable.
          reasoning_budget: 0
        }),
        signal: AbortSignal.timeout(5 * 60_000)
      })
      if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`)
      const body = (await res.json()) as { timings?: { predicted_per_second?: number; draft_n?: number; draft_n_accepted?: number } }
      result[kind] = body.timings?.predicted_per_second ?? 0
      result.drafted += body.timings?.draft_n ?? 0
      result.accepted += body.timings?.draft_n_accepted ?? 0
    }
    return result
  } finally {
    await server.stop().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
}
