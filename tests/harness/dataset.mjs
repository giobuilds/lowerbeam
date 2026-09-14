#!/usr/bin/env node
/**
 * Bundles and runs the dataset extractor the way run.mjs runs the harness.
 *
 *   node tests/harness/dataset.mjs                 # every results directory
 *   node tests/harness/dataset.mjs --dirs 2026-09-14T09-54-54-218Z
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const out = join(here, '..', '.build', 'dataset.mjs')

await mkdir(dirname(out), { recursive: true })
await build({
  entryPoints: [join(here, 'dataset.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  // The extractor bundles each commit's own tools at run time, with esbuild from the repository.
  external: ['esbuild'],
  alias: {
    '@shared': join(repo, 'src/shared'),
    '@context': join(repo, 'src/context'),
    electron: join(here, '..', 'stubs/electron.ts')
  },
  logLevel: 'silent'
})

const child = spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit', cwd: repo })
child.on('exit', (code) => process.exit(code ?? 1))
