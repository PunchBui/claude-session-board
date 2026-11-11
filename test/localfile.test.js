import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLocal, expandHome, imageType } from '../lib/localfile.js'

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'localfile-')))
  const home = join(base, 'home')
  const outside = join(base, 'outside')
  await mkdir(join(home, 'Desktop'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(home, 'Desktop', 'shot.gif'), 'gif')
  await writeFile(join(outside, 'secret.png'), 'png')
  return { base, home, outside, options: { roots: [home], home } }
}

test('resolves a file inside an allowed root', async () => {
  const { base, home, options } = await sandbox()
  const found = await resolveLocal(join(home, 'Desktop', 'shot.gif'), options)
  assert.deepEqual(found, { path: join(home, 'Desktop', 'shot.gif'), directory: false, size: 3 })
  await rm(base, { recursive: true })
})

test('expands ~ to the home folder', async () => {
  const { base, home, options } = await sandbox()
  const found = await resolveLocal('~/Desktop/shot.gif', options)
  assert.equal(found.path, join(home, 'Desktop', 'shot.gif'))
  assert.equal(expandHome('~', home), home)
  assert.equal(expandHome('/etc/hosts', home), '/etc/hosts')
  await rm(base, { recursive: true })
})

test('reports a folder as a directory', async () => {
  const { base, home, options } = await sandbox()
  const found = await resolveLocal(join(home, 'Desktop'), options)
  assert.equal(found.directory, true)
  await rm(base, { recursive: true })
})

test('refuses files outside every root', async () => {
  const { base, outside, options } = await sandbox()
  assert.equal(await resolveLocal(join(outside, 'secret.png'), options), null)
  await rm(base, { recursive: true })
})

test('refuses a symlink that points outside the root', async () => {
  const { base, home, outside, options } = await sandbox()
  await symlink(join(outside, 'secret.png'), join(home, 'link.png'))
  assert.equal(await resolveLocal(join(home, 'link.png'), options), null)
  await rm(base, { recursive: true })
})

test('refuses dot-dot segments that climb out of the root', async () => {
  const { base, home, options } = await sandbox()
  assert.equal(await resolveLocal(join(home, 'Desktop', '..', '..', 'outside', 'secret.png'), options), null)
  await rm(base, { recursive: true })
})

test('refuses missing, relative, empty and malformed paths', async () => {
  const { base, home, options } = await sandbox()
  assert.equal(await resolveLocal(join(home, 'nope.png'), options), null)
  assert.equal(await resolveLocal('Desktop/shot.gif', options), null)
  assert.equal(await resolveLocal('', options), null)
  assert.equal(await resolveLocal(null, options), null)
  assert.equal(await resolveLocal(`${join(home, 'Desktop', 'shot.gif')}\0.png`, options), null)
  assert.equal(await resolveLocal(`/${'a'.repeat(2000)}`, options), null)
  await rm(base, { recursive: true })
})

test('only common raster images get an image type', () => {
  assert.equal(imageType('/a/b.PNG'), 'image/png')
  assert.equal(imageType('/a/b.jpeg'), 'image/jpeg')
  assert.equal(imageType('/a/b.gif'), 'image/gif')
  assert.equal(imageType('/a/b.webp'), 'image/webp')
  assert.equal(imageType('/a/b.svg'), null)
  assert.equal(imageType('/a/b.html'), null)
  assert.equal(imageType('/a/b'), null)
})
