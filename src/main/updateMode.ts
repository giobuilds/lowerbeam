export type UpdateMode = 'self' | 'notify' | 'off'

/**
 * How this copy of the app can be updated. An AppImage (the runtime sets
 * APPIMAGE) replaces itself. Any other packaged copy — an RPM — is only told.
 * A development build never checks, unless pointed at a feed to try the flow.
 */
export function updateMode(packaged: boolean, env: NodeJS.ProcessEnv = process.env): UpdateMode {
  if (!packaged && !env['LOWERBEAM_UPDATE_URL']) return 'off'
  return env['APPIMAGE'] ? 'self' : 'notify'
}
