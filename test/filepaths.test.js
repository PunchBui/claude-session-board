import test from 'node:test'
import assert from 'node:assert/strict'
import { PATH_PATTERN, isPath, isImagePath, stripLocation, fileUrl } from '../public/filepaths.js'

const found = (text) => text.match(new RegExp(PATH_PATTERN.source, 'g'))

test('finds home, tmp and Volumes paths in prose', () => {
  assert.deepEqual(found('Saved to /Users/dkunweeroj/Desktop/run.gif and ~/Desktop/run.gif now'), ['/Users/dkunweeroj/Desktop/run.gif', '~/Desktop/run.gif'])
  assert.deepEqual(found('see /tmp/out.png, /private/tmp/a/b.png and /Volumes/Disk/x.png'), ['/tmp/out.png,', '/private/tmp/a/b.png', '/Volumes/Disk/x.png'])
  assert.deepEqual(found('at /var/folders/ab/cd/T/shot.png'), ['/var/folders/ab/cd/T/shot.png'])
})

test('ignores routes, urls and words that only look like paths', () => {
  assert.equal(found('GET /api/upload and /usr/bin/node'), null)
  assert.equal(found('open https://example.com/Users/dkunweeroj/a.png'), null)
  assert.equal(found('and/tmp/x and cost ~5 or ~/'), null)
  assert.equal(found('/var/log/system.log'), null)
})

test('a path in brackets or parentheses is still found', () => {
  assert.deepEqual(found('(see /Users/me/a.png)'), ['/Users/me/a.png)'])
})

test('isPath accepts a whole path only', () => {
  assert.equal(isPath('/Users/me/a.png'), true)
  assert.equal(isPath('~/a.png'), true)
  assert.equal(isPath('see /Users/me/a.png'), false)
  assert.equal(isPath('/api/file'), false)
  assert.equal(isPath('Users/me/a.png'), false)
})

test('image detection looks at the extension', () => {
  assert.equal(isImagePath('/Users/me/a.GIF'), true)
  assert.equal(isImagePath('/Users/me/a.webp'), true)
  assert.equal(isImagePath('/Users/me/a.svg'), false)
  assert.equal(isImagePath('/Users/me/a.png.txt'), false)
})

test('a trailing line and column are dropped before the file is opened', () => {
  assert.equal(stripLocation('/Users/me/app.js:12'), '/Users/me/app.js')
  assert.equal(stripLocation('/Users/me/app.js:12:5'), '/Users/me/app.js')
  assert.equal(stripLocation('/Users/me/app.js'), '/Users/me/app.js')
})

test('the file url carries the encoded path', () => {
  assert.equal(fileUrl('/Users/me/my shot.png'), '/api/file?path=%2FUsers%2Fme%2Fmy%20shot.png')
})
