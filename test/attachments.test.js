import test from 'node:test'
import assert from 'node:assert/strict'
import { splitAttachments, visibleText } from '../public/attachments.js'

test('a prompt without attachments is returned as is', () => {
  assert.deepEqual(splitAttachments('just text'), { text: 'just text', files: [] })
  assert.deepEqual(splitAttachments(undefined), { text: '', files: [] })
  assert.deepEqual(splitAttachments('Mentions Attached files: in passing'), { text: 'Mentions Attached files: in passing', files: [] })
})

test('the trailing file list is split into names and image flags', () => {
  const prompt = 'Check these\n\nAttached files:\n- /data/uploads/a/Screenshot 1.png\n- /data/uploads/b/notes.pdf'
  const { text, files } = splitAttachments(prompt)
  assert.equal(text, 'Check these')
  assert.deepEqual(files, [
    { path: '/data/uploads/a/Screenshot 1.png', name: 'Screenshot 1.png', image: true },
    { path: '/data/uploads/b/notes.pdf', name: 'notes.pdf', image: false },
  ])
})

test('the default sentence is hidden, real text is kept', () => {
  assert.equal(visibleText(splitAttachments('Please look at the attached files.\n\nAttached files:\n- /u/a.png').text), '')
  assert.equal(visibleText('Fix this'), 'Fix this')
})

test('a list that is not at the end stays in the text', () => {
  const prompt = 'Attached files:\n- /u/a.png\nthen more words'
  assert.deepEqual(splitAttachments(prompt).files, [])
})
