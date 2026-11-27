import test from 'node:test'
import assert from 'node:assert'
import { mergeEnv, toXml, escapeXml } from '../scripts/launch-agent-env.js'
import { addHost, removeHosts } from '../scripts/remote-config.js'

test('mergeEnv keeps existing keys, overlays set shell vars and always sets PATH', () => {
  const merged = mergeEnv({ JIRA_EMAIL: 'old@x', CUSTOM: '1', PATH: 'stale' }, { JIRA_EMAIL: 'new@x', GITLAB_HOST: 'g.example', UNRELATED: 'x' }, '/bin')
  assert.deepStrictEqual(merged, { JIRA_EMAIL: 'new@x', CUSTOM: '1', PATH: '/bin', GITLAB_HOST: 'g.example' })
})

test('toXml escapes values', () => {
  assert.strictEqual(escapeXml('a&b<c>'), 'a&amp;b&lt;c&gt;')
  assert.match(toXml({ FLOW_JQL: 'a & b < c' }), /<string>a &amp; b &lt; c<\/string>/)
})

test('addHost and removeHosts only touch their own host family', () => {
  const start = { hosts: ['mac.tail.ts.net'], token: 't' }
  const both = addHost(start, /\.trycloudflare\.com$/, 'x.trycloudflare.com', 't')
  assert.deepStrictEqual(both.hosts, ['mac.tail.ts.net', 'x.trycloudflare.com'])
  const rotated = addHost(both, /\.trycloudflare\.com$/, 'y.trycloudflare.com', 't')
  assert.deepStrictEqual(rotated.hosts, ['mac.tail.ts.net', 'y.trycloudflare.com'])
  assert.deepStrictEqual(removeHosts(rotated, /\.trycloudflare\.com$/).hosts, ['mac.tail.ts.net'])
  assert.strictEqual(removeHosts(start, /\.ts\.net$/), null)
})
