import { randomBytes, timingSafeEqual } from 'node:crypto'

/** What a request for a run gets when it does not carry that run's identity. */
export const NOT_THIS_RUN = 'This request is not for that run.'

const TOKEN_BYTES = 32

/**
 * A secret issued for one run, held in memory, never written to the journal.
 *
 * The run id is a name. It is in the journal, the file name and the events.
 * The identity is how a later request shows it is about that run. The preload
 * keeps it and attaches it; the page does not see it.
 */
export class RunIdentities {
  private readonly tokens = new Map<string, Buffer>()

  /** Issue one. A second call for the same run keeps the first. */
  issue(runId: string): string {
    const existing = this.tokens.get(runId)
    if (existing) return existing.toString('base64url')
    const token = randomBytes(TOKEN_BYTES)
    this.tokens.set(runId, token)
    return token.toString('base64url')
  }

  /** The identity issued for this run, or null when this process has not issued one. */
  token(runId: string): string | null {
    return this.tokens.get(runId)?.toString('base64url') ?? null
  }

  forget(runId: string): void {
    this.tokens.delete(runId)
  }

  clear(): void {
    this.tokens.clear()
  }

  /** Throw when `presented` is not the identity issued for `runId`. */
  assert(runId: string, presented: unknown): void {
    const token = this.tokens.get(runId)
    if (!token || !sameToken(token, presented)) throw new Error(NOT_THIS_RUN)
  }
}

function sameToken(token: Buffer, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 64) return false
  const got = Buffer.from(presented, 'base64url')
  if (got.length !== token.length) return false
  return timingSafeEqual(got, token)
}
