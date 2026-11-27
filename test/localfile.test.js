import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileKind, resolveLocal, resolveWithBase, findByName, expandHome, imageType } from '../lib/localfile.js'

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'localfile-')))
  const home = join(base, 'home')
  const elsewhere = join(base, 'elsewhere')
  await mkdir(join(home, 'Desktop'), { recursive: true })
  await mkdir(elsewhere)
  await writeFile(join(home, 'Desktop', 'shot.gif'), 'gif')
  await writeFile(join(elsewhere, 'other.png'), 'png')
  return { base, home, elsewhere, options: { home } }
}

test('resolves a file under the home folder', async () => {
  const { base, home, options } = await sandbox()
  const found = await resolveLocal(join(home, 'Desktop', 'shot.gif'), options)
  assert.deepEqual(found, { path: join(home, 'Desktop', 'shot.gif'), directory: false, size: 3 })
  await rm(base, { recursive: true })
})

test('resolves a file anywhere on disk', async () => {
  const { base, elsewhere, options } = await sandbox()
  const found = await resolveLocal(join(elsewhere, 'other.png'), options)
  assert.equal(found.path, join(elsewhere, 'other.png'))
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

test('follows a symlink to the real file', async () => {
  const { base, home, elsewhere, options } = await sandbox()
  await symlink(join(elsewhere, 'other.png'), join(home, 'link.png'))
  const found = await resolveLocal(join(home, 'link.png'), options)
  assert.equal(found.path, join(elsewhere, 'other.png'))
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

import { withSizeReporter, SIZE_SCRIPT, isPdfFile, contentDisposition, parseRange } from '../lib/localfile.js'
test('withSizeReporter injects the size reporter before the last </body>, or appends it', () => {
  assert.equal(withSizeReporter('<body>x</body>'), `<body>x${SIZE_SCRIPT}</body>`)
  assert.equal(withSizeReporter('<p>x</p>'), `<p>x</p>${SIZE_SCRIPT}`)
})

test('pdf files are recognised and get a safe content-disposition, Thai names included', () => {
  assert.equal(isPdfFile('/a/b.PDF'), true)
  assert.equal(isPdfFile('/a/b.pdf.png'), false)
  assert.equal(contentDisposition('/a/guide.pdf', false), "inline; filename*=UTF-8''guide.pdf")
  assert.equal(contentDisposition('/a/คู่มือ (1).pdf', true), "attachment; filename*=UTF-8''%E0%B8%84%E0%B8%B9%E0%B9%88%E0%B8%A1%E0%B8%B7%E0%B8%AD%20%281%29.pdf")
  assert.ok(!contentDisposition('/a/x"\r\ny.pdf', false).includes('\n'))
})

test('byte ranges: open-ended, bounded, suffix, clamped, and unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 })
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=5-2', 1000), 'unsatisfiable')
  assert.equal(parseRange(undefined, 1000), null)
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null)
  assert.equal(parseRange('items=0-1', 1000), null)
})

test('resolves a bare filename inside the session folder', async () => {
  const { base, elsewhere, options } = await sandbox()
  await writeFile(join(elsewhere, 'deck.pptx'), 'x')
  const found = await resolveWithBase('deck.pptx', elsewhere, { ...options, search: async () => [] })
  assert.equal(found.path, join(elsewhere, 'deck.pptx'))
  await rm(base, { recursive: true })
})

test('falls back to a name search, preferring a non-Library copy', async () => {
  const { base, home, elsewhere, options } = await sandbox()
  await mkdir(join(home, 'Library'))
  await writeFile(join(home, 'Library', 'deck.pptx'), 'x')
  await writeFile(join(elsewhere, 'deck.pptx'), 'x')
  const search = async () => [join(home, 'Library', 'deck.pptx'), join(elsewhere, 'deck.pptx'), join(elsewhere, 'other-deck.pptx')]
  const found = await resolveWithBase('deck.pptx', join(base, 'missing'), { ...options, search })
  assert.equal(found.path, join(elsewhere, 'deck.pptx'))
  await rm(base, { recursive: true })
})

test('never searches for names with a path or a parent segment', async () => {
  const { base, options } = await sandbox()
  const search = async () => { throw new Error('searched') }
  assert.equal(await resolveWithBase('../deck.pptx', base, { ...options, search }), null)
  assert.equal(await resolveWithBase('a/deck.pptx', base, { ...options, search }), null)
  assert.equal(await findByName('nothing.pptx', { ...options, search: async () => [] }), null)
  await rm(base, { recursive: true })
})

test('a file is classified by type and refused as too large past its own limit', () => {
  const at = (path, size, directory = false) => ({ path, size, directory })
  assert.deepEqual(fileKind(at('/a/x.html', 10)), { kind: 'html' })
  assert.deepEqual(fileKind(at('/a/x.pdf', 10)), { kind: 'pdf' })
  assert.deepEqual(fileKind(at('/a/x.PNG', 10)), { kind: 'image' })
  assert.deepEqual(fileKind(at('/a/x.html', 10_000_001)), { tooLarge: true })
  assert.deepEqual(fileKind(at('/a/x.pdf', 50_000_001)), { tooLarge: true })
  assert.deepEqual(fileKind(at('/a/x.png', 25_000_001)), { tooLarge: true })
  assert.equal(fileKind(at('/a/x.txt', 10)), null)
  assert.equal(fileKind(at('/a/x.html', 10, true)), null)
  assert.equal(fileKind(null), null)
})
