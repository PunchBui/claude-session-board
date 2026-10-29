import test from 'node:test'
import assert from 'node:assert/strict'
import { pickFolder } from '../lib/folder.js'

const darwin = (run) => pickFolder({ platform: 'darwin', run })

test('returns the chosen folder without the trailing slash', async () => {
  assert.deepEqual(await darwin(async () => '/Users/me/repos/app/\n'), { path: '/Users/me/repos/app' })
})

test('keeps the root folder intact', async () => {
  assert.deepEqual(await darwin(async () => '/\n'), { path: '/' })
})

test('closing the dialog is a cancel, not an error', async () => {
  const run = async () => { throw Object.assign(new Error('failed'), { stderr: 'execution error: User canceled. (-128)' }) }
  assert.deepEqual(await darwin(run), { cancelled: true })
})

test('other failures are thrown', async () => {
  const run = async () => { throw Object.assign(new Error('boom'), { stderr: 'something else' }) }
  await assert.rejects(darwin(run), /boom/)
})

test('non-mac platforms report unsupported', async () => {
  assert.deepEqual(await pickFolder({ platform: 'linux' }), { unsupported: true })
})
