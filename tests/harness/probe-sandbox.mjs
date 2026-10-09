#!/usr/bin/env node
/**
 * Stage 0 sandbox probe.
 *
 * Says whether this machine can run a command in the same box the app uses
 * (`probeSandbox` in src/main/coding/sandbox.ts). Meant to be run on the
 * packaging target — a clean Fedora install of the RPM — not only on the
 * development machine. If it says no, Coding launches read-only and shows
 * the same reason; it never runs unsandboxed and calls that a sandbox.
 *
 *   node tests/harness/probe-sandbox.mjs
 *
 * Landlock is reported and not required. The app records it and does not
 * gate run mode on it: the box is bubblewrap, and a kernel without landlock
 * still gets a box.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'

const SEE = 'See Requirements in the README: https://github.com/giobuilds/lowerbeam#requirements'

const checks = []
const check = (name, fn, required) => {
  try {
    const value = fn()
    checks.push({ name, ok: Boolean(value), value: String(value), required })
  } catch (err) {
    checks.push({ name, ok: false, value: err.message.split('\n')[0], required })
  }
}

const read = (path) => readFileSync(path, 'utf8').trim()

check('kernel', () => release(), false)

check('bubblewrap', () => execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim(), true)

check('unprivileged user namespaces', () => {
  const max = Number(read('/proc/sys/user/max_user_namespaces'))
  if (!(max > 0)) throw new Error('max_user_namespaces is 0')
  return `max ${max}`
}, true)

check('landlock in the LSM list', () => {
  const lsm = read('/sys/kernel/security/lsm')
  if (!lsm.split(',').map((s) => s.trim()).includes('landlock')) throw new Error(`lsm=${lsm}`)
  return lsm
}, false)

check('seccomp', () => {
  const status = read('/proc/self/status')
  const m = status.match(/^Seccomp:\s*(\d)/m)
  return m ? `mode ${m[1]} available` : 'unknown'
}, false)

// The settings above can all look right and a box still not start: Ubuntu
// 23.10 and later leave user namespaces on but have AppArmor refuse them to
// unconfined programs. So a box is started once, empty, to know. Same argv
// as trialBox() in sandbox.ts.
function trialBox() {
  try {
    execFileSync(
      'bwrap',
      ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--', 'true'],
      { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return 'started'
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n')[0] ?? ''
    let apparmor = false
    try {
      apparmor = read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1'
    } catch {
      /* no such sysctl */
    }
    if (apparmor) {
      throw new Error(
        `AppArmor is refusing user namespaces to unconfined programs (kernel.apparmor_restrict_unprivileged_userns = 1, as on Ubuntu 23.10 and later), so bubblewrap cannot start. ${SEE}`
      )
    }
    throw new Error(`bubblewrap could not start a box here (${detail.slice(0, 160)}), so commands cannot be contained. ${SEE}`)
  }
}

const bwrapOk = checks.find((c) => c.name === 'bubblewrap')?.ok
const usernsOk = checks.find((c) => c.name === 'unprivileged user namespaces')?.ok
if (bwrapOk && usernsOk) check('trial box', trialBox, true)
else check('trial box', () => { throw new Error('not started') }, true)

const width = Math.max(...checks.map((c) => c.name.length))
for (const c of checks) {
  const mark = c.ok ? 'ok  ' : c.required ? 'MISSING' : 'n/a '
  console.log(`  ${mark.padEnd(7)} ${c.name.padEnd(width)}  ${c.value}`)
}
const missing = checks.filter((c) => c.required && !c.ok)
console.log()
if (missing.length) {
  console.log(`Coding would launch read-only here: ${missing.map((c) => c.name).join(', ')} not available.`)
  process.exit(1)
}
console.log('Execution containment is available on this machine.')
