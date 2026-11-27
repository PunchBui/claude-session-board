import test from 'node:test'
import assert from 'node:assert/strict'
import { timeBucket, cardVersion, parseHave, createCardCache, focusDelta } from '../lib/cardcache.js'

test('a recently active session is bucketed every 5 seconds and an old one every minute', () => {
  const now = 60_000 * 1_000_000
  assert.notEqual(timeBucket(now, now - 1000), timeBucket(now + 5000, now - 1000))
  assert.equal(timeBucket(now, now - 60 * 60_000), timeBucket(now + 30_000, now - 60 * 60_000))
  assert.notEqual(timeBucket(now, now - 60 * 60_000), timeBucket(now + 60_000, now - 60 * 60_000))
})

test('the version changes only when a part changes', () => {
  assert.equal(cardVersion(['a', 1]), cardVersion(['a', 1]))
  assert.notEqual(cardVersion(['a', 1]), cardVersion(['a', 2]))
})

test('have is read from id:version pairs and bad pairs are skipped', () => {
  assert.deepEqual([...parseHave('a:v1,b:v2,junk,:x')], [['a', 'v1'], ['b', 'v2']])
  assert.equal(parseHave(undefined).size, 0)
})

test('the cache returns a card only for its version and drops the oldest past the limit', () => {
  const cache = createCardCache(2)
  cache.set('a', 'v1', { id: 'a' })
  assert.deepEqual(cache.get('a', 'v1'), { id: 'a' })
  assert.equal(cache.get('a', 'v2'), null)
  cache.set('b', 'v1', { id: 'b' })
  cache.set('c', 'v1', { id: 'c' })
  assert.equal(cache.get('a', 'v1'), null)
  assert.equal(cache.size(), 2)
})

test('cards the client already has are not built or sent, changed ones are, in order', async () => {
  const built = []
  const versions = { a: 'v1', b: 'v2', c: 'v1' }
  const result = await focusDelta(['a', 'b', 'c'], {
    have: new Map([['a', 'v1'], ['b', 'old']]),
    versionOf: async (id) => versions[id],
    build: async (id) => { built.push(id); return { id } },
    cache: createCardCache(),
  })
  assert.deepEqual(result.same, ['a'])
  assert.deepEqual(result.cards.map((card) => card.id), ['b', 'c'])
  assert.deepEqual(built.sort(), ['b', 'c'])
  assert.equal(result.cards[0].version, 'v2')
})

test('a cached card is reused for the same version without rebuilding', async () => {
  const cache = createCardCache()
  let builds = 0
  const options = { have: new Map(), versionOf: async () => 'v1', build: async (id) => { builds += 1; return { id } }, cache }
  await focusDelta(['a'], options)
  await focusDelta(['a'], options)
  assert.equal(builds, 1)
})
