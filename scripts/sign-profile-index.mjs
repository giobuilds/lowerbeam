#!/usr/bin/env node
/**
 * Sign a shared-profile index.json with the maintainer key.
 *
 * The private key is read from ~/.config/lowerbeam/profile-signing/ed25519.pem.
 * It is never written, printed, or stored in this repository. The signature
 * is the raw ed25519 signature of the file's exact bytes, as one base64 line
 * in index.json.sig beside the index.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createPrivateKey, sign } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const keyPath = join(homedir(), '.config/lowerbeam/profile-signing/ed25519.pem')
const indexPath = process.argv[2]
if (!indexPath) {
  console.error('Usage: node scripts/sign-profile-index.mjs <index.json>')
  process.exit(2)
}

let pem
try {
  pem = await readFile(keyPath)
} catch {
  console.error(`No profile signing key at ${keyPath}.`)
  process.exit(1)
}

const body = await readFile(indexPath)
const signature = sign(null, body, createPrivateKey(pem)).toString('base64')
await writeFile(`${indexPath}.sig`, `${signature}\n`, { mode: 0o600 })
console.log(`Signed ${indexPath}`)
