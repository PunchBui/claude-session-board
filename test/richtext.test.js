import test from 'node:test'
import assert from 'node:assert/strict'
import { splitFences } from '../public/richtext.js'

test('plain text stays one text part', () => {
  assert.deepEqual(splitFences('hello\nworld'), [{ type: 'text', text: 'hello\nworld' }])
})

test('a fenced block becomes a code part between text parts', () => {
  const parts = splitFences('See this:\n\n```\nhttps://gitlab.example.com/g/p/-/merge_requests/54\n```\n\nThen run it.')
  assert.deepEqual(parts, [
    { type: 'text', text: 'See this:' },
    { type: 'code', lang: '', text: 'https://gitlab.example.com/g/p/-/merge_requests/54' },
    { type: 'text', text: 'Then run it.' },
  ])
})

test('keeps the language label and blank lines inside code', () => {
  const [part] = splitFences('```js\nconst a = 1\n\nconst b = 2\n```')
  assert.equal(part.lang, 'js')
  assert.equal(part.text, 'const a = 1\n\nconst b = 2')
})

test('handles several blocks and an unterminated fence', () => {
  const parts = splitFences('```\none\n```\ntext\n```bash\nnpm test')
  assert.deepEqual(parts.map((p) => p.type), ['code', 'text', 'code'])
  assert.equal(parts[2].text, 'npm test')
  assert.equal(parts[2].lang, 'bash')
})

test('triple backticks on a single line are not a fence', () => {
  assert.deepEqual(splitFences('use ```inline``` here'), [{ type: 'text', text: 'use ```inline``` here' }])
})

test('indented fences inside lists are recognised', () => {
  const parts = splitFences('- step\n  ```\n  npm start\n  ```')
  assert.deepEqual(parts.map((p) => p.type), ['text', 'code'])
})
