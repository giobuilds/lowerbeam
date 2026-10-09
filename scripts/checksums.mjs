#!/usr/bin/env node
/**
 * Checksums for a release, and a detached signature over them.
 *
 *   node scripts/checksums.mjs <dir> [--sign]
 *
 * Writes `<dir>/SHA256SUMS` for the AppImage, the RPM and `latest-linux.yml`.
 * With `--sign`, signs that file with the key in `GNUPGHOME`. The passphrase
 * is read from `GPG_PASSPHRASE` (never from the command line, where the rest
 * of the machine could see it). The signature is checked against
 * `release-signing-key.asc` before the command returns, so a release cannot
 * be published with a signature the published key does not verify.
 *
 * A rehearsal can set `GPG_FINGERPRINT` and `GPG_PUBLIC_KEY` together to sign
 * and verify with a throwaway key. Leaving both unset is the release path:
 * the fingerprint below and the key committed in the repository.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The key in release-signing-key.asc. A signature from any other key is refused. */
export const RELEASE_FINGERPRINT = 'CB722EF260C30897756B9229CAC053DD7A018445'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PUBLIC_KEY_PATH = join(root, 'release-signing-key.asc')

/** The files a release publishes, apart from the checksums themselves. */
export function releaseFiles(names) {
  const selected = names.filter((name) => name.endsWith('.AppImage') || name.endsWith('.rpm') || name === 'latest-linux.yml').sort()
  const missing = []
  if (!selected.some((name) => name.endsWith('.AppImage'))) missing.push('an AppImage')
  if (!selected.some((name) => name.endsWith('.rpm'))) missing.push('an RPM')
  if (!selected.includes('latest-linux.yml')) missing.push('latest-linux.yml')
  if (missing.length) throw new Error(`A release needs ${missing.join(', ')}.`)
  return selected
}

/** `sha256sum -c` text: hash, two spaces, the file's own name. */
export function checksumText(files) {
  const lines = files.map((file) => `${createHash('sha256').update(file.bytes).digest('hex')}  ${file.name}`)
  return `${lines.join('\n')}\n`
}

/** Write SHA256SUMS for the release files in `dir`. Returns the text. */
export function writeChecksums(dir) {
  const names = releaseFiles(readdirSync(dir))
  const text = checksumText(names.map((name) => ({ name, bytes: readFileSync(join(dir, name)) })))
  writeFileSync(join(dir, 'SHA256SUMS'), text)
  return text
}

/**
 * Sign `sumsPath` with the key already imported in `homedir`. The passphrase
 * is this argument, handed to gpg on a pipe.
 */
export function signChecksums(sumsPath, { homedir, passphrase, fingerprint = RELEASE_FINGERPRINT }) {
  execFileSync(
    'gpg',
    [
      '--homedir', homedir,
      '--batch', '--yes',
      '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0',
      '--local-user', fingerprint,
      '--detach-sign', '--armor',
      '--output', `${sumsPath}.asc`,
      sumsPath
    ],
    { input: passphrase, stdio: ['pipe', 'pipe', 'pipe'] }
  )
}

/**
 * Import `publicKey` into a fresh keyring and require that `signaturePath`
 * is a valid signature by `fingerprint` over `sumsPath`.
 */
export function verifyChecksums(sumsPath, signaturePath, publicKey, fingerprint = RELEASE_FINGERPRINT) {
  const homedir = mkdtempSync(join(tmpdir(), 'lowerbeam-gpg-'))
  chmodSync(homedir, 0o700)
  try {
    execFileSync('gpg', ['--homedir', homedir, '--batch', '--import'], { input: publicKey, stdio: ['pipe', 'pipe', 'pipe'] })
    let status
    try {
      status = execFileSync(
        'gpg',
        ['--homedir', homedir, '--batch', '--status-fd', '1', '--verify', signaturePath, sumsPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().trim().split('\n').pop()
      throw new Error(`The checksum signature does not verify (${detail}).`)
    }
    const valid = status.split('\n').find((line) => line.startsWith('[GNUPG:] VALIDSIG '))
    const signedBy = valid?.split(' ')[2]
    if (signedBy !== fingerprint) throw new Error(`The checksum signature is from ${signedBy ?? 'an unknown key'}, not ${fingerprint}.`)
  } finally {
    rmSync(homedir, { recursive: true, force: true })
  }
}

/**
 * Who a `--sign` run signs as, and which public key the check uses.
 *
 * Both overrides or neither. A release workflow sets neither, so it can only
 * succeed with the key in the repository. A rehearsal sets both to a key
 * created for that run and thrown away with it.
 */
export function signingIdentity(env = process.env) {
  const fingerprint = env['GPG_FINGERPRINT']?.trim().toUpperCase() || ''
  const publicKey = env['GPG_PUBLIC_KEY'] || ''
  if (!fingerprint && !publicKey) return { fingerprint: RELEASE_FINGERPRINT, publicKey: null }
  if (!fingerprint || !publicKey) throw new Error('GPG_FINGERPRINT and GPG_PUBLIC_KEY must be set together.')
  if (!/^[0-9A-F]{40}$/.test(fingerprint)) throw new Error('GPG_FINGERPRINT must be 40 hex characters.')
  return { fingerprint, publicKey }
}

function main() {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: checksums.mjs <dir> [--sign]')
    process.exit(2)
  }
  const sums = join(dir, 'SHA256SUMS')
  writeChecksums(dir)
  if (!process.argv.includes('--sign')) return
  const passphrase = process.env['GPG_PASSPHRASE']
  const homedir = process.env['GNUPGHOME']
  if (!passphrase) throw new Error('GPG_PASSPHRASE is not set.')
  if (!homedir) throw new Error('GNUPGHOME is not set.')
  const identity = signingIdentity()
  const fingerprint = identity.fingerprint
  const publicKey = identity.publicKey ?? readFileSync(PUBLIC_KEY_PATH, 'utf8')
  signChecksums(sums, { homedir, passphrase, fingerprint })
  verifyChecksums(sums, `${sums}.asc`, publicKey, fingerprint)
  console.log(`Signed ${sums} with ${fingerprint}.`)
}

if (/scripts[/\\]checksums\.mjs$/.test(process.argv[1] ?? '')) {
  try {
    main()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
