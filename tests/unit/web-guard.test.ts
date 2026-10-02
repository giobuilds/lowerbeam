import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { blockedAddress, fetchPage, DEFAULT_LIMITS } from '../../src/main/web.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// A page fetch reaches the public internet and nothing else. Reproduced in
// #74: a page could have the model read 127.0.0.1 and pass on what it got.

console.log('which addresses are refused')
{
  for (const ip of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1']) {
    assert.ok(blockedAddress(ip), ip)
  }
  ok('loopback, private, link-local, CGNAT, unspecified and multicast, in both families, and IPv4 written as IPv6')
  for (const ip of ['1.1.1.1', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111']) assert.equal(blockedAddress(ip), null, ip)
  ok('public addresses beside those ranges are not')
  assert.equal(blockedAddress('169.254.169.254'), 'a link-local address'); ok('the cloud metadata address is named for what it is')
}

const serve = (handler: Parameters<typeof createServer>[1], host = '127.0.0.1'): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, host, () => resolve(server))
  })
const port = (s: Server): number => (s.address() as AddressInfo).port
const page = (body: string) => (_req: unknown, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end(body)
}

console.log('\na local server is refused, by address and by name')
const local = await serve(page('<title>slots</title><p>secret slot state</p>'))
{
  await assert.rejects(() => fetchPage(`http://127.0.0.1:${port(local)}/slots`), /127\.0\.0\.1 is on this computer, so it was not fetched/); ok('127.0.0.1')
  await assert.rejects(() => fetchPage(`http://localhost:${port(local)}/slots`), /localhost \((127\.0\.0\.1|::1)\) is on this computer/); ok('localhost, after the name is looked up')
  await assert.rejects(() => fetchPage(`http://[::1]:${port(local)}/`), /::1 is on this computer/); ok('[::1]')
  await assert.rejects(() => fetchPage(`http://2130706433:${port(local)}/`), /on this computer/); ok('127.0.0.1 written as one number')
  await assert.rejects(() => fetchPage('http://169.254.169.254/latest/meta-data/'), /link-local address/); ok('the metadata address, without a connection attempt')
  await assert.rejects(() => fetchPage(`http://127.0.0.1:${port(local)}/`), /Only pages on the public internet can be read/); ok('and the refusal tells the model why')
}

console.log('\nevery redirect is checked again')
{
  // 127.0.0.1 stands in for a public site here; 127.0.0.2 for the private one.
  const onlyFirst = (ip: string): string | null => (ip === '127.0.0.1' ? null : blockedAddress(ip))
  const inner = await serve(page('<p>inner</p>'), '127.0.0.2')
  const outer = await serve((req, res) => {
    if (req.url === '/away') res.writeHead(302, { location: `http://127.0.0.2:${port(inner)}/` }).end()
    else if (req.url === '/hop') res.writeHead(301, { location: '/plain' }).end()
    else if (req.url === '/gz') res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync('<title>Z</title><p>zipped page</p>'))
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Plain</title><p>plain page</p>')
  })
  const base = `http://127.0.0.1:${port(outer)}`
  const plain = await fetchPage(`${base}/`, DEFAULT_LIMITS, onlyFirst)
  assert.equal(plain.title, 'Plain'); assert.match(plain.text, /plain page/); ok('an allowed address is fetched')
  const hopped = await fetchPage(`${base}/hop`, DEFAULT_LIMITS, onlyFirst)
  assert.equal(hopped.url, `${base}/plain`); assert.match(hopped.text, /plain page/); ok('a redirect to an allowed address is followed, and the final address reported')
  await assert.rejects(() => fetchPage(`${base}/away`, DEFAULT_LIMITS, onlyFirst), /127\.0\.0\.2 is on this computer/); ok('a redirect to a refused address is refused')
  const zipped = await fetchPage(`${base}/gz`, DEFAULT_LIMITS, onlyFirst)
  assert.match(zipped.text, /zipped page/); ok('a compressed page is read as text')
  outer.close(); inner.close()
}
local.close()

console.log(`\n${n} assertions passed`)
