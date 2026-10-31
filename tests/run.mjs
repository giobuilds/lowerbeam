#!/usr/bin/env node
/**
 * Test runner.
 *
 * Suites are TypeScript that imports the app's own modules, so each is bundled
 * with esbuild (resolving the @shared alias) and run as a script. There is no
 * test framework: assertions come from node:assert and each suite prints what it
 * checked, which keeps the output readable as a description of the behaviour
 * rather than a wall of dots.
 *
 * Two tiers, because they need different things:
 *   unit         nothing but this repo — always runnable, safe in CI
 *   integration  a real llama.cpp binary, a model on disk, or network access
 */
import { build } from 'esbuild'
import { readdir, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const outDir = join(here, '.build')

const args = process.argv.slice(2)
const wantAll = args.includes('--all') || args.includes('--integration')
const only = args.find((a) => !a.startsWith('-'))

async function suitesIn(tier) {
  try {
    return (await readdir(join(here, tier)))
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => ({ tier, file: join(here, tier, f), name: basename(f, '.test.ts') }))
  } catch {
    return []
  }
}

async function run(suite) {
  const out = join(outDir, `${suite.tier}-${suite.name}.mjs`)
  await build({
    entryPoints: [suite.file],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    // Main-process modules can be exercised here as long as what they use of
    // Electron is stubbed; anything needing a real window is a UI drive instead.
    alias: {
      '@shared': join(repo, 'src/shared'),
      '@context': join(repo, 'src/context'),
      electron: join(here, 'stubs/electron.ts')
    },
    // web-tree-sitter loads its wasm with a runtime require. Bundling it
    // removes that require, so the package stays outside the test bundle.
    external: ['web-tree-sitter'],
    logLevel: 'silent'
  })

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [out], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (c) => (output += c))
    child.stderr.on('data', (c) => (output += c))
    child.on('exit', (code) => {
      const passed = Number(/(\d+) assertions passed/.exec(output)?.[1] ?? 0)
      resolve({ ...suite, code, passed, output })
    })
  })
}

const suites = [
  ...(await suitesIn('unit')),
  ...(wantAll ? await suitesIn('integration') : [])
].filter((s) => !only || s.name.includes(only))

if (suites.length === 0) {
  console.error('No suites matched.')
  process.exit(1)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let total = 0
const failures = []
for (const suite of suites) {
  const result = await run(suite)
  total += result.passed
  const ok = result.code === 0
  if (!ok) failures.push(result)
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${suite.tier}/${suite.name}` +
      (result.passed ? `  ${result.passed} assertions` : '')
  )
}

await rm(outDir, { recursive: true, force: true })

if (failures.length > 0) {
  for (const f of failures) {
    console.log(`\n--- ${f.tier}/${f.name} ---\n${f.output.trimEnd()}`)
  }
  console.log(`\n${failures.length} suite(s) failed, ${total} assertions passed`)
  process.exit(1)
}

console.log(`\n${suites.length} suites, ${total} assertions passed`)
if (!wantAll) {
  console.log('Integration suites were skipped; run `npm run test:all` for those.')
}
