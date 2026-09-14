import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TERMS, describeTerms, sameTerms } from '@shared/coding.js'
import { checkTerms } from '../../src/main/coding/supervisor.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('the terms are described to the model only where they say something')
{
  assert.equal(describeTerms(DEFAULT_TERMS, 'run'), ''); ok('the defaults add nothing to the instructions')
  const t = { alsoRead: ['/srv/lib'], network: true, install: true }
  const run = describeTerms(t, 'run')
  assert.ok(run.includes('also read, but not change, `/srv/lib`') && run.includes('use the network') && run.includes('install dependencies')); ok('every term granted is stated, with the extra root by its full path')
  const edit = describeTerms(t, 'edit')
  assert.ok(edit.includes('/srv/lib') && !edit.includes('network') && !edit.includes('install')); ok('outside run mode the network and installs are not mentioned, since no command runs')
  assert.ok(sameTerms(DEFAULT_TERMS, { alsoRead: [], network: false, install: false }) && !sameTerms(DEFAULT_TERMS, t)); ok('equal terms compare equal')
}

console.log('\nthe terms are checked where they are enforced')
{
  const base = await mkdtemp(join(tmpdir(), 'terms-'))
  const own = join(base, 'userData')
  await mkdir(join(own, 'coding'), { recursive: true })
  const lib = join(base, 'lib')
  await mkdir(lib)
  await writeFile(join(base, 'file.txt'), 'x')
  const fine = await checkTerms({ alsoRead: [lib, lib], network: true, install: true }, 'run', own)
  assert.deepEqual(fine, { alsoRead: [lib], network: true, install: true }); ok('a real folder is kept once; network and install stand in run mode')
  const edit = await checkTerms({ alsoRead: [lib], network: true, install: true }, 'edit', own)
  assert.deepEqual(edit, { alsoRead: [lib], network: false, install: false }); ok('outside run mode the network and install are dropped, so the record never claims them')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: [join(base, 'missing')] }, 'run', own), /does not exist/); ok('a folder that is not there is refused')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: [join(base, 'file.txt')] }, 'run', own), /not a folder/); ok('a file is refused')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: ['/'] }, 'run', own), /whole filesystem/); ok('the filesystem is refused')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: [homedir()] }, 'run', own), /whole home directory/); ok('the home directory is refused')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: [own] }, 'run', own), /own state/); ok('the app\u2019s own state is refused')
  await assert.rejects(checkTerms({ ...DEFAULT_TERMS, alsoRead: [base] }, 'run', own), /own state/); ok('and so is any folder that contains it')
  await rm(base, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
