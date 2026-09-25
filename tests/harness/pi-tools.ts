/**
 * Pi's agent loop on Lowerbeam's tools: the one combination the engine
 * comparison left open.
 *
 * Pi runs in this process through its SDK, the way the app would embed it,
 * with every built-in tool off. The only tools it has are the reference's
 * own — list_files, search, read, and in an edit run edit_file and
 * write_file — executed by `runAgentTool` against the run's grant. So the
 * grant is the boundary, as it is for the reference, and no box is needed:
 * nothing Pi does reaches the filesystem except through a tool the grant
 * answers.
 *
 * What stays Pi's: its system prompt (listing these tools), its loop with no
 * round cap, and its compaction, with the reserve sized to the window as in
 * the comparison. What is Lowerbeam's: the tools, their bounds (a read is at
 * most a third of the window), their refusals, and the grant.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_TOOLS, WRITE_TOOLS, runAgentTool } from '../../src/agent/tools.js'
import type { Grant } from '../../src/agent/grant.js'
import { parsePi, type EngineRun, type ToolCall } from './engines.js'

const MODULES = join(process.cwd(), 'tests/harness/engines/node_modules')

export interface PiOnToolsOptions {
  grant: Grant
  cwd: string
  base: string
  prompt: string
  mode: 'inspect' | 'edit'
  contextLimit: number
  timeoutMs: number
  port: number
  model: string
  transcript: string
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Pi is loaded at run time from the engines folder, untyped here */
export async function runPiOnTools(o: PiOnToolsOptions): Promise<EngineRun> {
  process.env.PI_OFFLINE = '1'
  process.env.PI_TELEMETRY = '0'
  const pi: any = await import(pathToFileURL(join(MODULES, '@mariozechner/pi-coding-agent/dist/index.js')).href)
  const typebox: any = await import(pathToFileURL(join(MODULES, 'typebox/build/index.mjs')).href)

  const agentDir = join(o.base, 'engine', 'pi')
  await mkdir(agentDir, { recursive: true })
  const modelsPath = join(agentDir, 'models.json')
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        lowerbeam: {
          baseUrl: `http://127.0.0.1:${o.port}/v1`,
          api: 'openai-completions',
          apiKey: 'none',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: o.model, reasoning: true, contextWindow: o.contextLimit, maxTokens: 4096 }]
        }
      }
    })
  )
  const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'))
  const modelRegistry = pi.ModelRegistry.create(authStorage, modelsPath)
  const model = modelRegistry.find('lowerbeam', o.model)
  if (!model) throw new Error('pi: the lowerbeam model is not in the registry')
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 6000 } })
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: o.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  })
  await resourceLoader.reload()

  const calls: ToolCall[] = []
  let denials = 0
  const declared = o.mode === 'edit' ? [...AGENT_TOOLS, ...WRITE_TOOLS] : AGENT_TOOLS
  const customTools = declared.map((t) =>
    pi.defineTool({
      name: t.name,
      label: t.label ?? t.name,
      description: t.description,
      // Pi lists a custom tool in its system prompt only with a snippet.
      promptSnippet: t.description.split('. ')[0],
      parameters: typebox.Unsafe(t.parameters),
      // One at a time, as the reference runs them: two edits to one file in
      // parallel is how a precondition goes stale.
      executionMode: 'sequential',
      execute: async (_id: string, params: Record<string, unknown>) => {
        const r = await runAgentTool(o.grant, t.name, params ?? {}, { contextLimit: o.contextLimit })
        if (r.denied) denials += 1
        calls.push({ name: t.name, args: JSON.stringify(params ?? {}), ok: r.ok, result: r.content })
        // A refusal or a failed precondition is the tool's answer, not an
        // error the loop should retry: the model reads it and decides.
        return { content: [{ type: 'text', text: r.content }], details: {} }
      }
    })
  )

  const { session } = await pi.createAgentSession({
    cwd: o.cwd,
    agentDir,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(o.cwd),
    noTools: 'builtin',
    customTools
  })

  // The same event stream the RPC comparison scored, kept the same way.
  const lines: string[] = []
  let ended = false
  let compacting = false
  let owed = false
  session.subscribe((e: any) => {
    lines.push(JSON.stringify(e))
    if (e.type === 'agent_start') owed = false
    else if (e.type === 'agent_end') ended = true
    else if (e.type === 'compaction_start') compacting = true
    else if (e.type === 'compaction_end') {
      compacting = false
      if (e.willRetry) owed = true
    }
  })

  const started = Date.now()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    void session.abort()
  }, o.timeoutMs)
  try {
    await session.prompt(o.prompt).catch((err: Error) => lines.push(JSON.stringify({ type: 'harness_error', message: err.message })))
    // Pi compacts after the turn ends and retries from there; the run is
    // over when it is idle with nothing owed, on two checks a second apart.
    let idle = 0
    while (!timedOut && idle < 2) {
      await new Promise((r) => setTimeout(r, 1000))
      idle = ended && !owed && !compacting && !session.isStreaming && !session.isCompacting ? idle + 1 : 0
    }
  } finally {
    clearTimeout(deadline)
    session.dispose()
  }
  const ms = Date.now() - started
  await writeFile(o.transcript, lines.join('\n') + '\n')

  const parsed = parsePi(lines.join('\n'))
  const outcome: EngineRun['outcome'] = timedOut ? 'timeout' : parsed.error ? 'error' : parsed.answer.trim() ? 'answered' : 'no answer'
  return { ...parsed, calls, denials, outcome, ms }
}
