/**
 * M0: score today's prose compaction on the real chats.
 *
 *   node tests/harness/compaction/run.mjs
 *   node tests/harness/compaction/run.mjs --base-url http://127.0.0.1:8990
 *
 * The server, when this starts it, is Ornith-1.5-9B at 16,384 tokens with the
 * daily reasoning budget. The summary request is the older transcript plus
 * the reply, and that does not fit in the 7,424-token slot the app would
 * actually give the chat. The slot size is still what the budgets see: how
 * much summary to ask for, which turns to replace, which of the user's lines
 * to keep verbatim. summarise() turns thinking off on its own request, so the
 * 700-token cap is the paragraph even while this server is thinking.
 *
 * Each question is asked twice. Projected is what the app would send next
 * (summary, verbatim user lines, recent turns). Summary is the paragraph
 * alone, so a fact that survived only because the user's words were copied
 * across is visible as a gap.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { missingFacts } from '@context/answerability.js'
import { compactableMessages, summarise, verbatimUserMessages } from '@context/compact.js'
import { projectConversation } from '@context/project.js'
import { streamChat, type ChatTurn } from '@shared/chatClient.js'
import type { ConversationView } from '@shared/types.js'
import { loadPairs, toConversation, type AnswerKey, type Corpus, type KeyQuestion } from './load.js'

const PORT = 8990
const LLAMA = join(homedir(), '.local/bin/llama')
const MODEL = join(
  homedir(),
  '.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-GGUF/snapshots/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q4_K_M.gguf'
)
// The daily Ornith launch. summarise() sends enable_thinking: false on the
// summary request, so this budget applies to the answer calls and not to the
// paragraph. Starting the server with --reasoning off hid the case where the
// summary cap was spent before any content existed.
const LAUNCH = ['--gpu-layers', '999', '--ctx-size', '16384', '--reasoning-budget', '1024']

const ANSWER = {
  temperature: 0,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  // Above the server's reasoning budget. A thinking model spends the start of
  // the reply in reasoning, and a cap under that budget ends the turn before
  // any answer is written. The app's own chat cap is unset.
  maxTokens: 2048
}

interface ViewScore {
  hit: boolean
  missing: string[]
  answer: string
  /** Set when the reply's content was empty and the model only thought. Not scored. */
  reasoning?: string
}

interface QuestionScore {
  id: string
  ask: string
  projected: ViewScore
  summaryOnly: ViewScore
  /** The summary paragraph itself contains every spelling, whether or not the reply quoted it. */
  retained: boolean
}

interface ChatScore {
  id: string
  contextPerSlot: number
  summarisedMessages: number
  /** How many times the summary was requested. A thinking model can spend the whole budget before writing one. */
  summaryAttempts: number
  keptMessages: number
  verbatimUserMessages: string[]
  summary: string
  questions: QuestionScore[]
  projected: string
  summaryOnly: string
  retained: string
}

function questionText(ask: string): string {
  return (
    `${ask}\n\n` +
    'Reply from the notes only. Quote the names, commands and sentences they already use. ' +
    'If the notes do not say, reply with the single word unknown.'
  )
}

async function complete(
  baseUrl: string,
  turns: ChatTurn[],
  signal: AbortSignal
): Promise<{ answer: string; reasoning: string }> {
  let answer = ''
  let reasoning = ''
  let failure: string | null = null
  await streamChat(baseUrl, turns, ANSWER, signal, {
    onDelta: (text) => {
      answer += text
    },
    onReasoning: (text) => {
      reasoning += text
    },
    onError: (message) => {
      failure = message
    },
    onDone: () => {}
  })
  if (failure) throw new Error(failure)
  return { answer: answer.trim(), reasoning: reasoning.trim() }
}

function scoreView(question: KeyQuestion, answer: string, reasoning: string): ViewScore {
  const missing = missingFacts(answer, question.facts)
  return {
    hit: missing.length === 0,
    missing: missing.map((fact) => fact.id),
    answer,
    ...(answer ? {} : { reasoning })
  }
}

async function scoreChat(baseUrl: string, corpus: Corpus, key: AnswerKey): Promise<ChatScore> {
  const conversation = toConversation(corpus)
  const older = compactableMessages(conversation, key.contextPerSlot)
  if (older.length === 0) throw new Error(`${corpus.id} has nothing to summarise at ${key.contextPerSlot}`)
  // The summary budget is 700 tokens. Ornith thinks inside that budget, and
  // some draws finish with no content. The app reports that as a failed
  // compaction and leaves the transcript unchanged; the harness asks again
  // so the score is of a summary that was actually produced.
  let summary = ''
  let summaryAttempts = 0
  for (;;) {
    summaryAttempts += 1
    console.log(`summarising ${corpus.id} (${older.length} turns, attempt ${summaryAttempts})`)
    try {
      summary = await summarise(
        baseUrl,
        conversation,
        older,
        null,
        key.contextPerSlot,
        AbortSignal.timeout(180_000)
      )
      break
    } catch (err) {
      const message = (err as Error).message
      if (!message.includes('empty summary') || summaryAttempts >= 3) throw err
    }
  }
  const userMessages = verbatimUserMessages(older, key.contextPerSlot)
  const compacted: ConversationView = {
    ...conversation,
    compaction: {
      summary,
      throughMessageId: older[older.length - 1]!.id,
      userMessages,
      messageCount: older.length,
      at: Date.now()
    }
  }
  const projected = projectConversation(compacted)
  const summaryTurns: ChatTurn[] = [{ role: 'system', content: summary }]
  const questions: QuestionScore[] = []
  for (const question of key.questions) {
    const ask = questionText(question.ask)
    console.log(`asking ${corpus.id}/${question.id}`)
    const projectedAnswer = await complete(
      baseUrl,
      [...projected, { role: 'user', content: ask }],
      AbortSignal.timeout(120_000)
    )
    const summaryAnswer = await complete(
      baseUrl,
      [...summaryTurns, { role: 'user', content: ask }],
      AbortSignal.timeout(120_000)
    )
    questions.push({
      id: question.id,
      ask: question.ask,
      projected: scoreView(question, projectedAnswer.answer, projectedAnswer.reasoning),
      summaryOnly: scoreView(question, summaryAnswer.answer, summaryAnswer.reasoning),
      retained: missingFacts(summary, question.facts).length === 0
    })
  }
  const count = (view: 'projected' | 'summaryOnly') =>
    `${questions.filter((question) => question[view].hit).length}/${questions.length}`
  return {
    id: corpus.id,
    contextPerSlot: key.contextPerSlot,
    summarisedMessages: older.length,
    summaryAttempts,
    keptMessages: conversation.messages.length - older.length,
    verbatimUserMessages: userMessages,
    summary,
    questions,
    projected: count('projected'),
    summaryOnly: count('summaryOnly'),
    retained: `${questions.filter((question) => question.retained).length}/${questions.length}`
  }
}

function report(chats: ChatScore[]): string {
  const lines = [
    '# Compaction M0',
    '',
    'Prose compaction as the app does it today. A hit keeps every fact\'s spelling.',
    'Retained counts spellings present in the summary paragraph, whether or not the reply quoted them.',
    '',
    '| chat | projected | summary only | retained |',
    '|---|---|---|---|',
    ...chats.map((chat) => `| ${chat.id} | ${chat.projected} | ${chat.summaryOnly} | ${chat.retained} |`)
  ]
  const totals = (view: 'projected' | 'summaryOnly') => {
    const questions = chats.flatMap((chat) => chat.questions)
    return `${questions.filter((question) => question[view].hit).length}/${questions.length}`
  }
  const retained = chats.flatMap((chat) => chat.questions)
  lines.push(
    `| total | ${totals('projected')} | ${totals('summaryOnly')} | ${retained.filter((question) => question.retained).length}/${retained.length} |`,
    ''
  )
  for (const chat of chats) {
    lines.push(`## ${chat.id}`, '', `Summary attempts: ${chat.summaryAttempts}.`, '', chat.summary, '')
    for (const question of chat.questions) {
      const mark = (view: ViewScore) => (view.hit ? 'hit' : `miss ${view.missing.join(', ')}`)
      lines.push(
        `- ${question.id}: projected ${mark(question.projected)}; summary ${mark(question.summaryOnly)}; retained ${question.retained ? 'yes' : 'no'}`
      )
      lines.push(`  - projected: ${question.projected.answer.replace(/\n/g, ' ')}`)
      lines.push(`  - summary: ${question.summaryOnly.answer.replace(/\n/g, ' ')}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(
    LLAMA,
    ['serve', '-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '--parallel', '1',
      '--flash-attn', 'on', '--jinja', '--slots', '--props', ...LAUNCH],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr.slice(-500)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return child
    } catch {
      /* not up yet */
    }
  }
  child.kill('SIGKILL')
  throw new Error(`server did not become ready: ${stderr.slice(-500)}`)
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (child.exitCode === null) child.kill('SIGKILL')
}

function baseUrlFrom(argv: string[]): string | null {
  const index = argv.indexOf('--base-url')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value ?? null
}

async function main(): Promise<void> {
  const given = baseUrlFrom(process.argv.slice(2))
  let child: ChildProcess | null = null
  let baseUrl = given
  if (!baseUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        throw new Error(`port ${PORT} is already serving; pass --base-url or stop it first`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('port ')) throw err
    }
    console.log(`starting Ornith-1.5-9B on :${PORT}`)
    child = await startServer()
    baseUrl = `http://127.0.0.1:${PORT}`
  }
  try {
    const build = execFileSync(LLAMA, ['--version']).toString().split('\n')[0]?.trim() ?? ''
    const pairs = await loadPairs()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(process.cwd(), 'tests/harness/results', stamp)
    await mkdir(dir, { recursive: true })
    const chats: ChatScore[] = []
    for (const { corpus, key } of pairs) {
      chats.push(await scoreChat(baseUrl, corpus, key))
      await writeFile(join(dir, 'report.md'), report(chats))
      await writeFile(
        join(dir, 'scores.json'),
        JSON.stringify({ build, model: MODEL, launch: LAUNCH, chats }, null, 2) + '\n'
      )
      const done = chats[chats.length - 1]!
      console.log(`${corpus.id}: projected ${done.projected}, summary ${done.summaryOnly}, retained ${done.retained}`)
    }
    console.log(report(chats))
    console.log(`wrote ${dir}`)
  } finally {
    if (child) await stopServer(child)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
