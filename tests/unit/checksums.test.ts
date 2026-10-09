import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error a plain .mjs script, without type declarations
import { RELEASE_FINGERPRINT, releaseFiles, checksumText, writeChecksums, signChecksums, verifyChecksums } from '../../scripts/checksums.mjs'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('the sums cover the AppImage, the RPM and latest-linux.yml')
{
  assert.deepEqual(releaseFiles(['notes.md', 'lowerbeam-0.13.0.x86_64.rpm', 'latest-linux.yml', 'Lowerbeam.AppImage', 'builder-debug.yml']), ['Lowerbeam.AppImage', 'latest-linux.yml', 'lowerbeam-0.13.0.x86_64.rpm']); ok('those three, sorted by name, and nothing else')
  assert.throws(() => releaseFiles(['Lowerbeam.AppImage', 'latest-linux.yml']), /an RPM/); ok('a release missing one of them is refused')
  const text = checksumText([{ name: 'b', bytes: Buffer.from('beta') }, { name: 'a', bytes: Buffer.from('alpha') }])
  assert.match(text, /^[0-9a-f]{64}  b\n[0-9a-f]{64}  a\n$/); ok('hash, two spaces, the file name, in the order given')
  const dir = mkdtempSync(join(tmpdir(), 'lowerbeam-sums-'))
  writeFileSync(join(dir, 'Lowerbeam.AppImage'), 'image')
  writeFileSync(join(dir, 'lowerbeam.rpm'), 'rpm')
  writeFileSync(join(dir, 'latest-linux.yml'), 'yml')
  writeFileSync(join(dir, 'builder-debug.yml'), 'debug')
  writeChecksums(dir)
  const written = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
  assert.equal(written, checksumText([
    { name: 'Lowerbeam.AppImage', bytes: Buffer.from('image') },
    { name: 'latest-linux.yml', bytes: Buffer.from('yml') },
    { name: 'lowerbeam.rpm', bytes: Buffer.from('rpm') }
  ])); ok('the file on disk is those hashes, and a debug file is not in it')
  rmSync(dir, { recursive: true, force: true })
}

console.log('\na signature has to be from the release key')
{
  const passphrase = 'test-passphrase'
  const make = (uid: string) => {
    const homedir = mkdtempSync(join(tmpdir(), 'lowerbeam-gpg-'))
    chmodSync(homedir, 0o700)
    const pass = join(homedir, 'pass')
    writeFileSync(pass, passphrase, { mode: 0o600 })
    execFileSync('gpg', ['--homedir', homedir, '--batch', '--pinentry-mode', 'loopback', '--passphrase-file', pass, '--quick-gen-key', uid, 'ed25519', 'sign', 'never'], { stdio: 'pipe' })
    const listed = execFileSync('gpg', ['--homedir', homedir, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8' })
    const fingerprint = listed.split('\n').find((line) => line.startsWith('fpr:'))!.split(':')[9]
    const publicKey = execFileSync('gpg', ['--homedir', homedir, '--armor', '--export', fingerprint], { encoding: 'utf8' })
    return { homedir, fingerprint, publicKey }
  }
  const release = make('Lowerbeam test <test@example.com>')
  const other = make('Someone else <other@example.com>')
  const dir = mkdtempSync(join(tmpdir(), 'lowerbeam-signed-'))
  const sums = join(dir, 'SHA256SUMS')
  writeFileSync(sums, 'deadbeef  Lowerbeam.AppImage\n')
  signChecksums(sums, { homedir: release.homedir, passphrase, fingerprint: release.fingerprint })
  verifyChecksums(sums, `${sums}.asc`, release.publicKey, release.fingerprint); ok('a signature from the key that holds it verifies')
  writeFileSync(sums, 'cafebabe  Lowerbeam.AppImage\n')
  assert.throws(() => verifyChecksums(sums, `${sums}.asc`, release.publicKey, release.fingerprint), /does not verify/); ok('a checksum changed after signing does not')
  writeFileSync(sums, 'deadbeef  Lowerbeam.AppImage\n')
  signChecksums(sums, { homedir: other.homedir, passphrase, fingerprint: other.fingerprint })
  assert.throws(() => verifyChecksums(sums, `${sums}.asc`, other.publicKey, release.fingerprint), /is from/); ok('a good signature from another key is refused')
  const published = execFileSync('gpg', ['--batch', '--show-keys', '--with-colons', join(process.cwd(), 'release-signing-key.asc')], { encoding: 'utf8' })
  assert.ok(published.split('\n').some((line) => line.startsWith('fpr:') && line.split(':')[9] === RELEASE_FINGERPRINT)); ok('the key in the repository is the one a release is signed with')
  rmSync(release.homedir, { recursive: true, force: true })
  rmSync(other.homedir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${n} assertions passed`)
