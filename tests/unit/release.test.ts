import assert from 'node:assert/strict'
// @ts-expect-error a plain .mjs script, without type declarations
import { section, kinds, suggest, bumped, prepared } from '../../scripts/release.mjs'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

const log = (unreleased: string): string => `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n${unreleased}\n\n## [0.9.25] - 2026-10-02\n\n### Fixed\n\n- an old fix\n`

console.log('a section is the text under its heading, to the next version')
{
  assert.equal(section(log('### Fixed\n\n- a'), 'Unreleased'), '### Fixed\n\n- a'); ok('Unreleased')
  assert.equal(section(log(''), '0.9.25'), '### Fixed\n\n- an old fix'); ok('a released version, the last one in the file')
  assert.equal(section(log(''), '1.0.0'), null); ok('a version with no heading is null')
  assert.deepEqual([...kinds('### Added\n\n### Fixed\n\n- x')], ['Fixed']); ok('a heading with no entries does not count')
}

console.log('\nthe bump follows the kinds of entries')
{
  assert.equal(suggest('### Fixed\n\n- a\n\n### Security\n\n- b', '0.9.25').bump, 'patch'); ok('fixes and security: patch')
  assert.equal(suggest('### Changed\n\n- a', '0.9.25').bump, 'patch'); ok('changed: patch')
  assert.equal(suggest('### Fixed\n\n- a\n\n### Added\n\n- b', '0.9.25').bump, 'minor'); ok('anything added: minor')
  assert.equal(suggest('### Breaking\n\n- a', '0.9.25').bump, 'minor'); ok('breaking before 1.0: minor')
  assert.equal(suggest('### Breaking\n\n- a', '1.2.3').bump, 'major'); ok('breaking from 1.0: major')
  assert.equal(suggest('### Added\n', '0.9.25'), null); ok('no entries: nothing to release')
  assert.deepEqual([bumped('0.9.25', 'patch'), bumped('0.9.25', 'minor'), bumped('0.9.25', 'major'), bumped('0.9.25', '0.11.0')], ['0.9.26', '0.10.0', '1.0.0', '0.11.0']); ok('and the next version is computed from it')
}

console.log('\npreparing a release moves Unreleased under the new version')
{
  const out = prepared(log('### Fixed\n\n- a new fix'), '0.9.26', '2026-10-03')
  assert.equal(section(out, 'Unreleased'), ''); ok('Unreleased is left empty')
  assert.equal(section(out, '0.9.26'), '### Fixed\n\n- a new fix'); ok('the entries are under the new version')
  assert.ok(out.includes('## [0.9.26] - 2026-10-03') && out.indexOf('[0.9.26]') < out.indexOf('[0.9.25]')); ok('dated, above the previous release')
  assert.throws(() => prepared(log('### Fixed\n'), '0.9.26', '2026-10-03'), /Nothing under Unreleased/); ok('and with nothing to release it refuses')
}

console.log(`\n${n} assertions passed`)
