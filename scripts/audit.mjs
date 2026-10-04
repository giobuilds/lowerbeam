#!/usr/bin/env node
/**
 * The dependency audit CI runs.
 *
 *   npm run audit:deps        (node scripts/audit.mjs)
 *
 * `npm audit --omit=dev` alone never sees Electron: electron-builder wants it
 * among the devDependencies, yet it is the runtime every release ships. So
 * two audits, the shipped tree and the whole tree, and an advisory at high or
 * critical blocks when it is in what ships, when it is Electron itself, or
 * when it is in build tooling and a fix is available inside the ranges
 * package.json allows (`npm audit fix` takes it). Everything else is printed
 * and passes: a dev-only advisory with no fix, or one whose fix is a major
 * bump, is noise until someone chooses that bump.
 */
import { execFileSync } from 'node:child_process'

const SERIOUS = new Set(['high', 'critical'])

/** npm audit's JSON for the whole tree, or the shipped tree only. npm exits 1 when it finds anything, which is not a failure here. */
function audit(omitDev) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])]
  try {
    return JSON.parse(execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout)
    throw err
  }
}

/** Whether `npm audit fix` would take the fix: available, and not a semver-major bump. */
function fixable(v) {
  return v.fixAvailable === true || (typeof v.fixAvailable === 'object' && v.fixAvailable !== null && !v.fixAvailable.isSemVerMajor)
}

/**
 * Each serious advisory in the whole tree, with whether it blocks and why.
 * `full` and `shipped` are npm audit reports (version 2).
 */
export function verdict(full, shipped) {
  const inShipped = new Set(Object.keys(shipped.vulnerabilities ?? {}))
  const found = []
  for (const [name, v] of Object.entries(full.vulnerabilities ?? {})) {
    if (!SERIOUS.has(v.severity)) continue
    const why = inShipped.has(name)
      ? 'shipped'
      : name === 'electron'
        ? 'the Electron runtime, which ships'
        : fixable(v)
          ? 'build tooling, fixable with npm audit fix'
          : null
    found.push({ name, severity: v.severity, blocks: why !== null, why: why ?? (v.fixAvailable ? 'build tooling, fix is a major bump' : 'build tooling, no fix yet') })
  }
  return found.sort((a, b) => Number(b.blocks) - Number(a.blocks) || a.name.localeCompare(b.name))
}

function main() {
  const found = verdict(audit(false), audit(true))
  if (!found.length) {
    console.log('No high or critical advisories.')
    return
  }
  for (const f of found) console.log(`${f.blocks ? 'BLOCKS' : 'passes'}  ${f.severity.padEnd(8)} ${f.name}: ${f.why}`)
  if (found.some((f) => f.blocks)) {
    console.log('\nRun `npm audit` for the advisories.')
    process.exit(1)
  }
}

// Run as a command, not when a test bundles it and imports the functions.
if (/scripts[\\/]audit\.mjs$/.test(process.argv[1] ?? '')) main()
