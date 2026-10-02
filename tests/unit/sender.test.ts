import assert from 'node:assert/strict'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isAppSender, isAppUrl, trustWindow } from '../../src/main/sender.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// Reproduced in #76: every channel served any sender, and isAppUrl took any
// file:// page for the app.
const index = 'file:///opt/Lowerbeam/resources/app.asar/out/renderer/index.html'

console.log('the app is one page, not anything on file://')
{
  assert.ok(isAppUrl(index, '', index)); ok('the index the window loads')
  assert.ok(isAppUrl(`${index}#/coding`, '', index) && isAppUrl(`${index}?x=1`, '', index)); ok('with any fragment or query')
  assert.ok(!isAppUrl('file:///home/me/notes.html', '', index)); ok('another local page is not the app')
  assert.ok(!isAppUrl('file:///opt/Lowerbeam/resources/app.asar/out/renderer/other.html', '', index)); ok('nor a file beside it')
  assert.ok(!isAppUrl('https://example.com/', '', index) && !isAppUrl('not a url', '', index)); ok('nor the web, nor nonsense')
  const dev = 'http://localhost:5173'
  assert.ok(isAppUrl('http://localhost:5173/', dev, index) && isAppUrl('http://localhost:5173/#/x', dev, index)); ok('in development, the dev server')
  assert.ok(!isAppUrl('http://localhost:51730/', dev, index)); ok('and not a port that merely starts the same')
  assert.ok(!isAppUrl('http://localhost:5173.evil.example/', dev, index)); ok('nor a host that does')
  assert.ok(!isAppUrl(index, dev, index)); ok('nor, in development, a built file')
}

console.log('\nonly the app’s own window, top frame, at the app, is served')
{
  const closed: Array<() => void> = []
  const window = (id: number) => ({ webContents: { id }, on: (_: string, fn: () => void) => closed.push(fn) }) as unknown as BrowserWindow
  const top = { parent: null, url: `${index}#/chat` }
  const event = (id: number, frame: unknown) => ({ sender: { id }, senderFrame: frame }) as unknown as IpcMainInvokeEvent
  process.env['ELECTRON_RENDERER_URL'] = ''
  // isAppUrl's default index is where this test bundle sits; use a frame there.
  const { APP_INDEX_PATH } = await import('../../src/main/sender.js')
  const { pathToFileURL } = await import('node:url')
  const here = { parent: null, url: pathToFileURL(APP_INDEX_PATH).href }
  assert.ok(!isAppSender(event(7, here))); ok('a window never trusted is refused')
  trustWindow(window(7))
  assert.ok(isAppSender(event(7, here))); ok('the app’s window at the app is served')
  assert.ok(!isAppSender(event(7, { parent: here, url: here.url }))); ok('a frame inside it is refused')
  assert.ok(!isAppSender(event(7, { parent: null, url: 'https://example.com/' }))); ok('the window after navigating away is refused')
  assert.ok(!isAppSender(event(7, top))); ok('so is a file:// page that is not the app')
  assert.ok(!isAppSender(event(7, null))); ok('a sender with no frame is refused')
  assert.ok(!isAppSender(event(8, here))); ok('another web contents at the same URL is refused')
  closed.forEach((fn) => fn())
  assert.ok(!isAppSender(event(7, here))); ok('a closed window is forgotten')
}

console.log(`\n${n} assertions passed`)
