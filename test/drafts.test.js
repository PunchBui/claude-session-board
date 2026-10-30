import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftStore } from '../public/drafts.js'

const memoryStorage = (initial = {}) => {
  const data = { ...initial }
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value } }
}

test('drafts survive a reload through storage', () => {
  const storage = memoryStorage()
  const first = new DraftStore(storage)
  first.set('a', 'half written prompt')
  first.set('b', 'another one')
  const second = new DraftStore(storage)
  assert.equal(second.get('a'), 'half written prompt')
  assert.equal(second.get('b'), 'another one')
})

test('sending or clearing a draft removes it everywhere', () => {
  const storage = memoryStorage()
  const store = new DraftStore(storage)
  store.set('a', 'text')
  store.delete('a')
  assert.equal(new DraftStore(storage).get('a'), undefined)
  store.set('b', 'x')
  store.set('b', '   ')
  assert.equal(store.has('b'), false)
  assert.equal(JSON.parse(storage.data['board.drafts']).b, undefined)
})

test('has ignores blank drafts and a broken or missing storage is tolerated', () => {
  assert.equal(new DraftStore(memoryStorage({ 'board.drafts': '{not json' })).size, 0)
  const noStorage = new DraftStore(null)
  noStorage.set('a', 'still works in memory')
  assert.equal(noStorage.get('a'), 'still works in memory')
  assert.equal(noStorage.has('a'), true)
})

test('only the most recent drafts are kept', () => {
  const storage = memoryStorage()
  const store = new DraftStore(storage)
  for (let i = 0; i < 70; i += 1) store.set(`s${i}`, `draft ${i}`)
  const saved = JSON.parse(storage.data['board.drafts'])
  assert.equal(Object.keys(saved).length, 60)
  assert.equal(saved.s69, 'draft 69')
  assert.equal(saved.s0, undefined)
})
