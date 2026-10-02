// The smallest MCP server: one tool, `env`, that returns the names (and the
// value of LOWERBEAM_TEST_OWN) of the environment it was started with.
import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env', version: '1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'env', description: 'environment', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ names: Object.keys(process.env).sort(), own: process.env.LOWERBEAM_TEST_OWN ?? null }) }] } })
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no such method' } })
})
