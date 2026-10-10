/**
 * M2: fill the speech-act form on the M0 chats and score the spellings it kept.
 *
 * This does not ask the questions back to the model. Retained is the same
 * check as the M0 column: a fact hits when the record contains one of its
 * spellings. Mechanical is the M1 scan of the same turns. A chat stores both.
 *
 *   node tests/harness/compaction/speech.mjs
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

function report(chats: ChatScore[]): string {
  const lines = [
    '# Compaction M2 record',
    '',
    'Spellings present in the form. Combined adds the M1 mechanical scan of the same turns.',
    'A chat stores the combined record in place of a prose summary.',
    '',
    '| chat | speech | speech + mechanical |',
    '|---|---|---|',
    ...chats.map((chat) => `| ${chat.id} | ${chat.speechRetained} | ${chat.combinedRetained} |`)
  ]
  const all = chats.flatMap((chat) => chat.questions)
  lines.push(
    `| total | ${all.filter((q) => q.speech).length}/${all.length} | ${all.filter((q) => q.combined).length}/${all.length} |`,
    ''
  )
  for (const chat of chats) {
    lines.push(`## ${chat.id}`, '', '```json', JSON.stringify(chat.speech, null, 2), '```', '')
    for (const question of chat.questions) {
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(process.cwd(), 'tests/harness/results', stamp)
    await mkdir(dir, { recursive: true })
    const chats: ChatScore[] = []
    for (const { corpus, key } of pairs) {
      chats.push(await scoreChat(`http://127.0.0.1:${PORT}`, corpus, key))
      const text = report(chats)
      await writeFile(join(dir, 'speech.md'), text)
      await writeFile(join(dir, 'speech.json'), JSON.stringify({ build, model: MODEL, launch: LAUNCH, chats }, null, 2) + '\n')
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
