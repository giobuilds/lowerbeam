import assert from 'node:assert/strict'
import { updateMode } from '../../src/main/updateMode.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('how a copy of the app is updated')
assert.equal(updateMode(true, { APPIMAGE: '/home/me/Apps/Lowerbeam-0.9.24.AppImage' }), 'self'); ok('an AppImage replaces itself')
assert.equal(updateMode(true, {}), 'notify'); ok('a packaged copy that is not an AppImage, an RPM, is only told')
assert.equal(updateMode(false, {}), 'off'); ok('a development build never checks')
assert.equal(updateMode(false, { LOWERBEAM_UPDATE_URL: 'http://127.0.0.1:8099/' }), 'notify'); ok('unless pointed at a feed to try the flow')

console.log(`\n${n} assertions passed`)
