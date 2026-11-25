import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * Public half of the key that signs the shared-profile catalog.
 *
 * The private key is not in this repository. It stays in
 * ~/.config/lowerbeam/profile-signing/ed25519.pem on the maintainer's
 * machine. Anything that does not verify with this key is ignored.
 */
export const PROFILE_CATALOG_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAq3nWNJU6Vb0PRNgC0+/wMb+lL73i0lupN8VT5PF2AKc='

/** ed25519 over the exact index bytes. The signature file is one base64 line. */
export function verifyCatalogSignature(body: Uint8Array, signature: string, spkiB64: string): boolean {
  try {
    const line = signature.trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return false
    const sig = Buffer.from(line, 'base64')
    if (sig.length !== 64) return false
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })
    return verify(null, body, key, sig)
  } catch {
    return false
  }
}

export function sha256Bytes(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}
