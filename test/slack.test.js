import test from 'node:test'
import assert from 'node:assert/strict'
import { slackThreadsIn, channelNamesIn, plainText, isReadThread, readThreadTarget, threadParent, threadUrl, threadKey, tsToMs } from '../lib/slack.js'
import { newScanState, absorbLine } from '../lib/scan.js'
import { buildFlow } from '../lib/flow.js'

test('permalinks give the thread root, using thread_ts for a reply link', () => {
  const text = 'see https://acme.slack.com/archives/C04821G22RM/p1793756981996389 and https://acme.enterprise.slack.com/archives/C0ABCDEFG/p1793756990000100?thread_ts=1793756981.000200&cid=C0ABCDEFG twice https://acme.slack.com/archives/C04821G22RM/p1793756981996389'
  assert.deepEqual(slackThreadsIn(text), [
    { host: 'acme', channel: 'C04821G22RM', ts: '1793756981.996389' },
    { host: 'acme.enterprise', channel: 'C0ABCDEFG', ts: '1793756981.000200' },
  ])
  assert.equal(threadUrl({ host: 'acme', channel: 'C04821G22RM', ts: '1793756981.996389' }), 'https://acme.slack.com/archives/C04821G22RM/p1793756981996389')
  assert.equal(threadUrl({ host: null, channel: 'C1', ts: '1.2' }), null)
  assert.equal(threadKey({ channel: 'C1', ts: '1793756981.996389' }), 'C1/1793756981.996389')
  assert.equal(tsToMs('1793756981.996389'), 1793756981996)
})

test('channel names come from Slack references, search results and replies', () => {
  assert.deepEqual(channelNamesIn('in <#C09CAC9NQ3W|robozyne> and <#C7H9G4U15|it-noc>'), [['C09CAC9NQ3W', 'robozyne'], ['C7H9G4U15', 'it-noc']])
  assert.deepEqual(channelNamesIn('Channel: #help-desk (ID: C03MBKZ8AGP)\nposted in #release-shop (C082FQ774TV)'), [['C03MBKZ8AGP', 'help-desk'], ['C082FQ774TV', 'release-shop']])
})

test('thread titles lose Slack markup', () => {
  assert.equal(plainText(':goose-announce-right: <!subteam^S06FGGRE8R3> please check <@UB9P8FW2F|Faustina Efendy>, <@U123> and <#C1|ops> &amp; <https://x.example.com/a|the doc>'), '@team please check @Faustina Efendy, @someone and #ops & the doc')
  assert.equal(plainText('> quoted line\n> more'), 'quoted line more')
})

test('a slack_read_thread call names its thread, and its result gives the parent message', () => {
  assert.equal(isReadThread('mcp__slack__slack_read_thread'), true)
  assert.equal(isReadThread('mcp__slack__slack_search_public'), false)
  assert.deepEqual(readThreadTarget({ channel_id: 'C04821G22RM', message_ts: '1793756981.996389' }), { channel: 'C04821G22RM', ts: '1793756981.996389' })
  assert.equal(readThreadTarget({ channel_id: 'nope', message_ts: '1' }), null)
  const result = [{ type: 'text', text: JSON.stringify({ messages: '=== THREAD PARENT MESSAGE ===\nFrom: Chuong Pham <c@example.com> (U03RHG2AW4R)\nTime: 2026-11-04 08:49:41 +07\nMessage TS: 1793756981.996389\nHi team, the hotel HID 625537 is using the new <@U123> setup.\nReactions: eyes (1)\n\n=== THREAD REPLIES (5 total) ===' }) }]
  assert.deepEqual(threadParent(result), { author: 'Chuong Pham', text: 'Hi team, the hotel HID 625537 is using the new @someone setup.' })
})

test('the scanner records threads from prompt links and thread reads, with the thread title', () => {
  const state = newScanState({ ownId: 's1' })
  const line = (entry) => absorbLine(state, JSON.stringify({ sessionId: 's1', timestamp: '2026-11-04T02:00:00Z', ...entry }))
  line({ type: 'user', message: { role: 'user', content: 'Look at https://acme.slack.com/archives/C04821G22RM/p1793756981996389 please' } })
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found https://acme.slack.com/archives/C0OTHER12/p1793756999000000 in <#C0OTHER12|help-desk>' }, { type: 'tool_use', id: 't1', name: 'mcp__slack__slack_read_thread', input: { channel_id: 'C04821G22RM', message_ts: '1793756981.996389' } }] } })
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '=== THREAD PARENT MESSAGE ===\nFrom: Ann <a@example.com> (U1)\nTime: x\nMessage TS: 1793756981.996389\nThe price is wrong\n' }] }] } })
  assert.deepEqual([...state.slack.keys()], ['C04821G22RM/1793756981.996389'])
  const thread = state.slack.get('C04821G22RM/1793756981.996389')
  assert.deepEqual([thread.host, thread.via, thread.title, thread.author], ['acme', ['link', 'read'], 'The price is wrong', 'Ann'])
  assert.equal(state.slackChannels.get('C0OTHER12'), 'help-desk')
})

test('a session started from Slack joins the flow with its thread, channel and MRs, and leaves the loose lists', () => {
  const MR = 'https://gitlab.example.com/a/b/-/merge_requests/5'
  const flow = buildFlow({
    jira: { issues: [], mrLinks: {} },
    mrs: [{ url: MR, ref: 'a/b!5', title: 'Fix price', branch: 'fix-price', state: 'merged', author: 'me', createdAt: 1, mergedAt: 2, updatedAt: 2 }],
    sessions: [
      { id: 's1', title: 'Price bug from Slack', project: 'shop', lastActivityAt: Date.now(), branches: [], tickets: [], mrUrls: [MR], slack: [{ key: 'C1AAAAAA/1793756981.996389', host: 'acme', channel: 'C1AAAAAA', ts: '1793756981.996389', via: ['link'], title: 'The price is wrong', author: 'Ann' }] },
      { id: 's2', title: 'Read the same thread', project: 'shop', lastActivityAt: Date.now(), branches: [], tickets: [], mrUrls: [], slack: [{ key: 'C1AAAAAA/1793756981.996389', host: null, channel: 'C1AAAAAA', ts: '1793756981.996389', via: ['read'] }] },
    ],
    slackChannels: { C1AAAAAA: 'help-desk' },
    me: 'me',
  })
  assert.equal(flow.threads.length, 1)
  assert.deepEqual([flow.threads[0].title, flow.threads[0].url, flow.threads[0].sessions], ['The price is wrong', 'https://acme.slack.com/archives/C1AAAAAA/p1793756981996389', ['s1', 's2']])
  assert.deepEqual(flow.channels.map((channel) => [channel.id, channel.name, channel.threads]), [['C1AAAAAA', 'help-desk', 1]])
  assert.deepEqual(flow.sessions.map((row) => [row.id, row.threads[0].why, row.mrs]), [['s1', 'Slack link in a prompt', [MR]], ['s2', 'Read the Slack thread', []]])
  assert.deepEqual(flow.mrs.map((row) => [row.url, row.tickets, row.threads]), [[MR, [], ['C1AAAAAA/1793756981.996389']]])
  assert.deepEqual([flow.loose.mrs.length, flow.loose.sessions.length], [0, 0])
})
