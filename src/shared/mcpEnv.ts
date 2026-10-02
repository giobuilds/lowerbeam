/**
 * What an MCP server inherits from Lowerbeam's environment: enough to find
 * programs, a home, a locale and a temporary folder, and nothing else. A token
 * in the shell that started Lowerbeam — GITHUB_TOKEN, a cloud key — is not
 * every third-party server's to read. A server that needs one names it in its
 * own environment, which the settings show and edit.
 */
export const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TZ', 'TERM', 'TMPDIR', 'XDG_*']

export function isInherited(name: string): boolean {
  return INHERITED_ENV.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))
}

/** The environment a server starts with: the inherited names that are set, then its own, which win. */
export function serverEnv(base: Record<string, string | undefined>, own: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined && isInherited(name)) env[name] = value
  return { ...env, ...own }
}

/** `KEY=value` lines, as typed in the settings, to an environment; or the first line that is not one. */
export function parseEnvLines(text: string): { env: Record<string, string> } | { problem: string } {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { problem: `Not NAME=value: ${line.slice(0, 40)}` }
    env[name] = line.slice(eq + 1)
  }
  return { env }
}

export function envLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
}
