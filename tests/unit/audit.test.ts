import assert from 'node:assert/strict'
// @ts-expect-error a plain .mjs script, without type declarations
import { verdict } from '../../scripts/audit.mjs'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// #95: `npm audit --omit=dev` never saw Electron, a devDependency that ships.
type Vuln = { severity: string; fixAvailable: unknown }
const report = (vulnerabilities: Record<string, Vuln>): { vulnerabilities: Record<string, Vuln> } => ({ vulnerabilities })
const blocking = (full: ReturnType<typeof report>, shipped = report({})): string[] =>
  (verdict(full, shipped) as Array<{ name: string; blocks: boolean }>).filter((f) => f.blocks).map((f) => f.name)

console.log('what blocks')
{
  // The shape `npm audit --json` gave at ffe2900, Electron 38.8.6: high
  // advisories on electron, none in the shipped tree.
  const old = report({ electron: { severity: 'high', fixAvailable: { name: 'electron', version: '44.5.1', isSemVerMajor: true } } })
  assert.deepEqual(blocking(old), ['electron']); ok('Electron at high, even when the fix is a major bump')
  const shippedVuln = report({ dompurify: { severity: 'high', fixAvailable: false } })
  assert.deepEqual(blocking(shippedVuln, shippedVuln), ['dompurify']); ok('anything high in the shipped tree, fix or not')
  assert.deepEqual(blocking(report({ 'http-cache-semantics': { severity: 'high', fixAvailable: true } })), ['http-cache-semantics']); ok('build tooling at high with a fix npm audit fix takes')
  assert.deepEqual(blocking(report({ x: { severity: 'critical', fixAvailable: { name: 'y', version: '2.0.1', isSemVerMajor: false } } })), ['x']); ok('and a fix through a parent, in range')
}

console.log('\nwhat passes')
{
  assert.deepEqual(blocking(report({ tool: { severity: 'high', fixAvailable: false } })), []); ok('build tooling with no fix')
  assert.deepEqual(blocking(report({ tool: { severity: 'high', fixAvailable: { name: 'tool', version: '9.0.0', isSemVerMajor: true } } })), []); ok('build tooling whose fix is a major bump')
  assert.deepEqual(blocking(report({ electron: { severity: 'moderate', fixAvailable: true } })), []); ok('anything below high, Electron included')
  const listed = verdict(report({ tool: { severity: 'high', fixAvailable: false }, electron: { severity: 'low', fixAvailable: true } }), report({}))
  assert.deepEqual(listed.map((f: { name: string; why: string }) => [f.name, f.why]), [['tool', 'build tooling, no fix yet']]); ok('a passing serious advisory is still listed, with why; low ones are not')
}

console.log(`\n${n} assertions passed`)
