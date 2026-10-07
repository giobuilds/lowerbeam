export type UpdateMode = 'self' | 'notify' | 'off'

/**
 * How this copy of the app can be updated. An AppImage (the runtime sets
 * APPIMAGE) replaces itself. Any other packaged copy — an RPM — is only told.
 * A development build never checks, unless pointed at a feed to try the flow.
 */
export function updateMode(packaged: boolean, env: NodeJS.ProcessEnv = process.env): UpdateMode {
  if (!packaged && !testFeed(env)) return 'off'
  return env['APPIMAGE'] ? 'self' : 'notify'
}

/**
 * A feed to try the update flow against, from LOWERBEAM_UPDATE_URL: a local
 * server serving latest-linux.yml and an AppImage. Honoured only on this
 * machine's loopback address. Anything that can set the app's environment
 * could otherwise point a packaged copy at someone else's server and have
 * it install what that server offers; a server on loopback is already
 * running as someone with access to this machine.
 */
export function testFeed(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['LOWERBEAM_UPDATE_URL']
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? raw : null
  } catch {
    return null
  }
}
