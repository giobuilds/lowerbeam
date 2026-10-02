#!/usr/bin/env node
/**
 * The changelog side of a release.
 *
 *   node scripts/release.mjs suggest            what the Unreleased entries call for
 *   node scripts/release.mjs prepare [bump]     move them under a new version and set it
 *                                               (bump: patch | minor | major | x.y.z; default: suggested)
 *   node scripts/release.mjs notes <version>    that version's section, for the release page
 *
 * The bump follows the sections in CHANGELOG.md: Breaking is major from 1.0
 * and minor before it, Added is minor, Changed, Fixed and Security are patch.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(root, 'CHANGELOG.md')

/** The text under `## [name]`, up to the next version heading; null if there is no such heading. */
export function section(changelog, name) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${name}]`))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

/** The `### Kind` headings in a section that have at least one entry under them. */
export function kinds(body) {
  const found = new Set()
  let current = null
  for (const line of body.split('\n')) {
    const heading = line.match(/^### (.+?)\s*$/)
    if (heading) current = heading[1]
    else if (current && /^\s*[-*] \S/.test(line)) found.add(current)
  }
  return found
}

/** The bump the entries call for, and why; null when there is nothing to release. */
export function suggest(body, version) {
  const found = kinds(body ?? '')
  if (found.size === 0) return null
  const major = Number(version.split('.')[0])
  if (found.has('Breaking')) {
    return major >= 1
      ? { bump: 'major', why: 'Breaking entries, from 1.0 on' }
      : { bump: 'minor', why: 'Breaking entries, and before 1.0 a breaking change is a minor bump' }
  }
  if (found.has('Added')) return { bump: 'minor', why: 'Added entries: something new a user can do' }
  return { bump: 'patch', why: `only ${[...found].join(', ')} entries` }
}

export function bumped(version, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump
  const [a, b, c] = version.split('.').map(Number)
  if (bump === 'major') return `${a + 1}.0.0`
  if (bump === 'minor') return `${a}.${b + 1}.0`
  if (bump === 'patch') return `${a}.${b}.${c + 1}`
  throw new Error(`Not a bump: ${bump}`)
}

/** The changelog with Unreleased's entries moved under `## [next] - date`, and Unreleased left empty. */
export function prepared(changelog, next, date) {
  const body = section(changelog, 'Unreleased')
  if (!body || kinds(body).size === 0) throw new Error('Nothing under Unreleased to release.')
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end < 0) end = lines.length
  return [...lines.slice(0, start + 1), '', `## [${next}] - ${date}`, '', body, '', ...lines.slice(end)].join('\n')
}

function main() {
  const [command, arg] = process.argv.slice(2)
  const changelog = readFileSync(CHANGELOG, 'utf8')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

  if (command === 'suggest') {
    const s = suggest(section(changelog, 'Unreleased'), version)
    if (!s) return console.log(`Nothing under Unreleased: ${version} is current.`)
    console.log(`${s.bump}: ${version} → ${bumped(version, s.bump)} (${s.why})`)
  } else if (command === 'prepare') {
    const s = suggest(section(changelog, 'Unreleased'), version)
    const bump = arg ?? s?.bump
    if (!bump) throw new Error('Nothing under Unreleased to release.')
    const next = bumped(version, bump)
    writeFileSync(CHANGELOG, prepared(changelog, next, new Date().toISOString().slice(0, 10)))
    execFileSync('npm', ['version', next, '--no-git-tag-version'], { cwd: root, stdio: 'ignore' })
    console.log(`${version} → ${next}. CHANGELOG.md and package.json updated.`)
    console.log(`Next: merge this as "Release ${next}", then on main:`)
    console.log(`  git switch main && git pull && git tag -a v${next} -m "Lowerbeam ${next}" && git push origin v${next}`)
  } else if (command === 'notes') {
    const body = section(changelog, arg)
    if (!body) throw new Error(`CHANGELOG.md has no entries for ${arg}.`)
    console.log(body)
  } else {
    console.error('usage: release.mjs suggest | prepare [patch|minor|major|x.y.z] | notes <version>')
    process.exit(2)
  }
}

// Run as a command, not when a test bundles it and imports the functions.
if (/scripts[\\/]release\.mjs$/.test(process.argv[1] ?? '')) {
  try {
    main()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
