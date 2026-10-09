#!/usr/bin/env node
/**
 * Scores the M2 speech record on the M0 chats, without replacing the summary.
 *
 *   node tests/harness/compaction/speech.mjs
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const out = join(here, '..', '..', '.build', 'compaction-speech.mjs')

await mkdir(dirname(out), { recursive: true })
await build({
  entryPoints: [join(here, 'speech.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  alias: {
    '@shared': join(repo, 'src/shared'),
    '@context': join(repo, 'src/context'),
    electron: join(here, '..', '..', 'stubs/electron.ts')
  },
  logLevel: 'silent'
})

const child = spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit', cwd: repo })
child.on('exit', (code) => process.exit(code ?? 1))
