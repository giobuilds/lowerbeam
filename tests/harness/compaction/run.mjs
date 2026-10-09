#!/usr/bin/env node
/**
 * Bundles and runs the compaction answerability harness.
 *
 *   node tests/harness/compaction/run.mjs
 *   node tests/harness/compaction/run.mjs --base-url http://127.0.0.1:8990
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const out = join(here, '..', '..', '.build', 'compaction.mjs')

await mkdir(dirname(out), { recursive: true })
await build({
  entryPoints: [join(here, 'run.ts')],
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
