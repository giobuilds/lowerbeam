import assert from 'node:assert/strict'
import { testFeed, updateMode } from '../../src/main/updateMode.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

console.log('how a copy of the app is updated')
assert.equal(updateMode(true, { APPIMAGE: '/home/me/Apps/Lowerbeam-0.9.24.AppImage' }), 'self'); ok('an AppImage replaces itself')
assert.equal(updateMode(true, {}), 'notify'); ok('a packaged copy that is not an AppImage, an RPM, is only told')
assert.equal(updateMode(false, {}), 'off'); ok('a development build never checks')
assert.equal(updateMode(false, { LOWERBEAM_UPDATE_URL: 'http://127.0.0.1:8099/' }), 'notify'); ok('unless pointed at a feed to try the flow')


// #135: the test feed cannot point a copy at someone else's server.
console.log('\nthe test feed, loopback only')
assert.equal(testFeed({ LOWERBEAM_UPDATE_URL: 'http://127.0.0.1:8099/' }), 'http://127.0.0.1:8099/'); assert.equal(testFeed({ LOWERBEAM_UPDATE_URL: 'http://localhost:8099/feed' }), 'http://localhost:8099/feed'); assert.equal(testFeed({ LOWERBEAM_UPDATE_URL: 'http://[::1]:8099/' }), 'http://[::1]:8099/'); ok('a server on this machine’s loopback is honoured')
for (const url of ['https://updates.example.com/', 'http://192.168.1.5/', 'http://127.0.0.1.evil.example/', 'file:///tmp/feed', 'not a url']) assert.equal(testFeed({ LOWERBEAM_UPDATE_URL: url }), null, url)
ok('any other host, a lookalike, another scheme or nonsense is ignored')
assert.equal(updateMode(false, { LOWERBEAM_UPDATE_URL: 'https://updates.example.com/' }), 'off'); ok('so a development build is not turned on by one')
assert.equal(testFeed({}), null); ok('and none set is none')

console.log(`\n${n} assertions passed`)
