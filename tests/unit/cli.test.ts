import assert from 'node:assert/strict'
import { cliHelp, exitCodeFor, formatEvent, parseCli, pickProfile } from '@shared/cli.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const event = (partial: Omit<JournalEvent, 'seq' | 'at' | 'run'>): JournalEvent =>
  ({ seq: 1, at: 1, run: 'r', ...partial }) as JournalEvent

console.log('parsing lowerbeam run')
{
  assert.equal(parseCli(['lowerbeam']).kind, 'app')
  assert.equal(parseCli(['electron', '/app/out/main/index.js']).kind, 'app')
  ok('no run token opens the window')

  assert.equal(parseCli(['electron', '.', 'run', '--help']).kind, 'help')
  assert.equal(parseCli(['lowerbeam', 'run', '-h']).kind, 'help')
  assert.equal(cliHelp().includes('--task'), true)
  ok('run --help explains the command')

  const command = parseCli(['lowerbeam', 'run', '--project', '/work/demo', '--task', 'Where is the grant?', '--mode', 'edit', '--model', 'Ornith.gguf'])
  assert.deepEqual(command, {
    kind: 'run',
    project: '/work/demo',
    task: 'Where is the grant?',
    mode: 'edit',
    model: 'Ornith.gguf'
  })
  ok('project, task, mode and model are kept')

  const defaults = parseCli(['electron', '.', 'run', '--task', '  look around  '])
  assert.equal(defaults.kind, 'run')
  if (defaults.kind === 'run') {
    assert.equal(defaults.mode, 'inspect')
    assert.equal(defaults.project, null)
    assert.equal(defaults.task, 'look around')
  }
  ok('the default mode is inspect, and the task is trimmed')

  assert.equal(parseCli(['lowerbeam', 'run']).kind, 'error')
  assert.equal(parseCli(['lowerbeam', 'run', '--mode', 'yolo', '--task', 'x']).kind, 'error')
  assert.equal(parseCli(['lowerbeam', 'run', '--task']).kind, 'error')
  assert.equal(parseCli(['lowerbeam', 'run', '--task', 'x', '--nope']).kind, 'error')
  assert.equal(parseCli(['lowerbeam', 'run', '--task', 'x', 'extra']).kind, 'error')
  ok('a missing task, a bad mode, or an unknown argument is refused')
}

console.log('\nwhat the terminal shows')
{
  assert.equal(formatEvent(event({ type: 'tool.call', callId: 'c', name: 'read_file', args: { path: 'a.ts' } })), 'tool read_file')
  assert.equal(
    formatEvent(event({ type: 'tool.result', callId: 'c', ok: false, denied: true, summary: 'outside\nthe grant', chars: 1 })),
    'denied outside the grant'
  )
  assert.equal(
    formatEvent(event({ type: 'run.finished', outcome: 'answered', answer: 'done', rounds: 1, ms: 1, tokens: { promptTokens: 1, predictedTokens: 1 }, denials: 0 })),
    null
  )
  assert.equal(exitCodeFor('answered'), 0)
  assert.equal(exitCodeFor('error'), 1)
  assert.equal(exitCodeFor('rounds'), 1)
  ok('a tool call is one line, and only an answer exits 0')
}

console.log('\nwhich saved launch to start')
{
  const older = profile('old.gguf', '/models/old.gguf', 1)
  const newer = profile('Ornith-1.5-9B-Q4_K_M.gguf', '/models/Ornith-1.5-9B-Q4_K_M.gguf', 2)
  assert.equal(pickProfile([older, newer], null), newer)
  assert.equal(pickProfile([older, newer], 'old.gguf'), older)
  assert.equal(pickProfile([older, newer], 'missing'), null)
  assert.equal(pickProfile([], null), null)
  ok('no name means the latest launch, and a name has to match one')
}

function profile(modelName: string, modelPath: string, lastUsedAt: number): { modelName: string; modelPath: string; lastUsedAt: number } {
  return { modelName, modelPath, lastUsedAt }
}

console.log(`\n${n} assertions passed`)
