import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { McpServer } from '../../src/main/mcp.js'
import { isInherited, parseEnvLines, serverEnv } from '@shared/mcpEnv.js'
import type { McpServerState } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// Reproduced in #77: every MCP server was started with all of Lowerbeam's
// environment, tokens included.

console.log('a server inherits the basics and nothing else')
{
  const base = { PATH: '/usr/bin', HOME: '/home/me', LANG: 'en_GB.UTF-8', LC_ALL: 'C', XDG_CONFIG_HOME: '/home/me/.config', TMPDIR: '/tmp', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'k', SSH_AUTH_SOCK: '/run/agent', DBUS_SESSION_BUS_ADDRESS: 'unix:x', UNSET: undefined }
  const env = serverEnv(base)
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME']); ok('tokens, the ssh agent and the session bus are left behind')
  const own = serverEnv(base, { GITHUB_TOKEN: 'for-this-server', PATH: '/opt/bin' })
  assert.equal(own['GITHUB_TOKEN'], 'for-this-server'); assert.equal(own['PATH'], '/opt/bin'); ok('what its config names is added, and wins')
  assert.ok(isInherited('LC_TIME') && !isInherited('LCX') && !isInherited('PATHX')); ok('patterns match by prefix only where they say so')
}

console.log('\nthe environment as typed in the settings')
{
  assert.deepEqual(parseEnvLines('A=1\n\n# note\nB = two=2\n'), { env: { A: '1', B: ' two=2' } }); ok('NAME=value lines, blanks and comments skipped, the value kept as typed')
  assert.ok('problem' in parseEnvLines('just words')); ok('a line that is not NAME=value is a problem')
  assert.ok('problem' in parseEnvLines('1BAD=x')); ok('and so is a name no shell would accept')
}

console.log('\na real server sees only that')
{
  process.env['LOWERBEAM_TEST_SECRET'] = 'should not arrive'
  const server = new McpServer({
    id: 'env', name: 'Env', command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/env-mcp.mjs', import.meta.url))],
    env: { LOWERBEAM_TEST_OWN: 'from the config' }, enabled: true
  })
  const ready = new Promise<McpServerState>((resolve) => server.on('state', (s: McpServerState) => (s.status === 'ready' || s.status === 'failed') && resolve(s)))
  void server.start()
  const state = await ready
  assert.equal(state.status, 'ready', state.error ?? ''); ok('it starts')
  const result = await server.call('env', {})
  const seen = JSON.parse(result.content) as { names: string[]; own: string | null }
  assert.ok(!seen.names.includes('LOWERBEAM_TEST_SECRET')); ok('a variable from Lowerbeam’s environment does not reach it')
  assert.ok(seen.names.every((name) => isInherited(name) || name === 'LOWERBEAM_TEST_OWN'), seen.names.join(',')); ok('every name it sees is a basic or its own')
  assert.equal(seen.own, 'from the config'); ok('and its own arrives')
  server.stop()
}

console.log(`\n${n} assertions passed`)
