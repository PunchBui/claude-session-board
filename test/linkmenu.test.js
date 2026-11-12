import test from 'node:test'
import assert from 'node:assert/strict'
import { copyTarget } from '../public/linkmenu.js'

test('copies the stored path for file links', () => {
  assert.deepEqual(copyTarget({ copy: '/Users/me/a.png', href: 'http://localhost:4747/api/file?path=x' }), { value: '/Users/me/a.png', label: 'Copy path' })
  assert.deepEqual(copyTarget({ copy: '/tmp/a.txt', href: 'http://localhost:4747/#' }), { value: '/tmp/a.txt', label: 'Copy path' })
})

test('copies the address of web and desktop links', () => {
  assert.deepEqual(copyTarget({ href: 'https://example.com/a/b?c=1' }), { value: 'https://example.com/a/b?c=1', label: 'Copy link' })
  assert.deepEqual(copyTarget({ href: 'claude://code/continue?session=abc' }), { value: 'claude://code/continue?session=abc', label: 'Copy link' })
})

test('offers nothing for anchors without a destination', () => {
  assert.equal(copyTarget({ href: '' }), null)
  assert.equal(copyTarget({}), null)
  assert.equal(copyTarget({ href: 'javascript:alert(1)' }), null)
  assert.equal(copyTarget({ href: 'file:///etc/passwd' }), null)
})
