/**
 * M2: fill the speech-act form on the M0 chats and score the spellings it kept.
 *
 * This does not ask the questions back to the model. Retained is the same
 * check as the M0 column: a fact hits when the record contains one of its
 * spellings. Mechanical is the M1 scan of the same turns. A chat stores both.
 *
 *   node tests/harness/compaction/speech.mjs
 *   node tests/harness/compaction/speech.mjs --draws=1
 *
 * The default is three draws. The table is the median hit count, and the
 * range when the draws disagree. Thinking stays off, because that is how
 * the app asks for the record: a thinking trace would spend the cap before
 * the form is written.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { missingFacts } from '@context/answerability.js'
import { compactableMessages } from '@context/compact.js'
import { extractMechanics, mechanicalText } from '@context/extract.js'
import { extractSpeech, speechText, type SpeechRecord } from '@context/speech.js'
import { loadPairs, toConversation, type AnswerKey, type Corpus } from './load.js'
import { formatSpread } from './stats.js'

/** How many times each chat is recorded. One draw is a single roll of the model. */
function drawCount(): number {
  const flag = process.argv.find((arg) => arg.startsWith('--draws='))
  if (!flag) return 3
  const count = Number(flag.slice('--draws='.length))
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error('--draws needs a whole number from 1 to 10')
  }
  return count
}

const PORT = 8990
const LLAMA = join(homedir(), '.local/bin/llama')
const MODEL = join(
  homedir(),
  '.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-GGUF/snapshots/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q4_K_M.gguf'
)
const LAUNCH = ['--gpu-layers', '999', '--ctx-size', '16384', '--reasoning-budget', '1024']

interface ChatScore {
  id: string
  turns: number
  speech: SpeechRecord
  speechRetained: string
  combinedRetained: string
  questions: Array<{ id: string; speech: boolean; combined: boolean; missingSpeech: string[] }>
}

async function scoreChat(baseUrl: string, corpus: Corpus, key: AnswerKey): Promise<ChatScore> {
  const conversation = toConversation(corpus)
  const older = compactableMessages(conversation, key.contextPerSlot)
  if (older.length === 0) throw new Error(`${corpus.id} has nothing to record at ${key.contextPerSlot}`)
  console.log(`recording ${corpus.id} (${older.length} turns)`)
  const speech = await extractSpeech(baseUrl, conversation, older, key.contextPerSlot, AbortSignal.timeout(180_000))
  const spoken = speechText(speech)
  const mechanical = mechanicalText(extractMechanics(older.map((m) => m.content).join('\n')))
  const combined = `${spoken}\n${mechanical}`
  const questions = key.questions.map((question) => {
    const missingSpeech = missingFacts(spoken, question.facts).map((fact) => fact.id)
    const missingCombined = missingFacts(combined, question.facts)
    return {
      id: question.id,
      speech: missingSpeech.length === 0,
      combined: missingCombined.length === 0,
      missingSpeech
    }
  })
  const count = (hit: (q: (typeof questions)[number]) => boolean) =>
    `${questions.filter(hit).length}/${questions.length}`
  return {
    id: corpus.id,
    turns: older.length,
    speech,
    speechRetained: count((q) => q.speech),
    combinedRetained: count((q) => q.combined),
    questions
  }
}

interface ChatDraws {
  id: string
  questions: number
  /** Questions whose facts were all present, one number per draw. */
  speechHits: number[]
  combinedHits: number[]
  /** The last draw, kept so a reader can see one record in full. */
  last: ChatScore
}

function hitCount(chat: ChatScore, which: 'speech' | 'combined'): number {
  return chat.questions.filter((question) => question[which]).length
}

function report(chats: ChatDraws[], draws: number): string {
  const lines = [
    '# Compaction record',
    '',
    `Spellings present in the form, across ${draws} ${draws === 1 ? 'draw' : 'draws'}.`,
    'Combined adds the mechanical scan of the same turns. A chat stores that combined record.',
    'Each cell is the median number of questions held. A range is the lowest and highest draw.',
    'Thinking is off, which is how the app asks for the record.',
    '',
    '| chat | questions | speech | speech + mechanical |',
    '|---|---|---|---|',
    ...chats.map(
      (chat) =>
        `| ${chat.id} | ${chat.questions} | ${formatSpread(chat.speechHits)} | ${formatSpread(chat.combinedHits)} |`
    ),
    ''
  ]
  for (const chat of chats) {
    lines.push(`## ${chat.id}`, '', '```json', JSON.stringify(chat.last.speech, null, 2), '```', '')
    lines.push(`Speech draws: ${chat.speechHits.join(', ')}. Combined draws: ${chat.combinedHits.join(', ')}.`, '')
    for (const question of chat.last.questions) {
      lines.push(
        `- ${question.id}: speech ${question.speech ? 'yes' : `no (${question.missingSpeech.join(', ')})`}; combined ${question.combined ? 'yes' : 'no'}`
      )
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

async function main(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) throw new Error(`port ${PORT} is already serving`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('port ')) throw err
  }
  console.log(`starting Ornith-1.5-9B on :${PORT}`)
  const child = await startServer()
  try {
    const build = execFileSync(LLAMA, ['--version']).toString().split('\n')[0]?.trim() ?? ''
    const pairs = await loadPairs()
    const draws = drawCount()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(process.cwd(), 'tests/harness/results', stamp)
    await mkdir(dir, { recursive: true })
    const chats: ChatDraws[] = []
    for (const { corpus, key } of pairs) {
      const speechHits: number[] = []
      const combinedHits: number[] = []
      let last: ChatScore | null = null
      for (let draw = 1; draw <= draws; draw++) {
        console.log(`${corpus.id} draw ${draw}/${draws}`)
        last = await scoreChat(`http://127.0.0.1:${PORT}`, corpus, key)
        speechHits.push(hitCount(last, 'speech'))
        combinedHits.push(hitCount(last, 'combined'))
      }
      chats.push({ id: corpus.id, questions: last!.questions.length, speechHits, combinedHits, last: last! })
      const text = report(chats, draws)
      await writeFile(join(dir, 'speech.md'), text)
      await writeFile(
        join(dir, 'speech.json'),
        JSON.stringify({ build, model: MODEL, launch: LAUNCH, draws, chats }, null, 2) + '\n'
      )
      console.log(text)
    }
    console.log(`wrote ${dir}`)
  } finally {
    await stopServer(child)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
