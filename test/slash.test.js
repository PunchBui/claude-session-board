import test from 'node:test'
import assert from 'node:assert/strict'
import { freshCommand, sideCommand } from '../public/slash.js'

test('the fresh-chat command needs whitespace or the end after it', () => {
  assert.equal(freshCommand('/new'), '')
  assert.equal(freshCommand('/new x'), 'x')
  assert.equal(freshCommand('/clear'), '')
  assert.equal(freshCommand('/RESET  now\nplease'), 'now\nplease')
  assert.equal(freshCommand('/new-feature add login'), null)
  assert.equal(freshCommand('/reset-db'), null)
  assert.equal(freshCommand('/clear-cache'), null)
  assert.equal(freshCommand('please /new'), null)
})

test('the side-chat command needs whitespace or the end after it', () => {
  assert.equal(sideCommand('/btw y'), 'y')
  assert.equal(sideCommand('/side'), '')
  assert.equal(sideCommand('/side-effects x'), null)
  assert.equal(sideCommand('/btw-notes y'), null)
  assert.equal(sideCommand('/new x'), null)
})
