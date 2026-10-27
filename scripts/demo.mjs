import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync, utimesSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.DEMO_DIR ?? join(tmpdir(), 'claude-session-board-demo')
const PORT = process.env.PORT ?? '4747'
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url))
const MODEL = 'claude-sonnet-5-5'
const NOW = Date.now()
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let seed = 20260101
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (min, max) => Math.round(min + random() * (max - min))

const iso = (ms) => new Date(ms).toISOString()
const user = (at, content) => ({ type: 'user', timestamp: iso(at), message: { content } })
const result = (at, ...ids) => user(at, ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })))
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
const say = (text) => ({ type: 'text', text })
let messageCounter = 0
const reply = (at, usage, ...content) => {
  messageCounter += 1
  return { type: 'assistant', timestamp: iso(at), message: { id: `msg_demo_${messageCounter}`, model: MODEL, content, usage: { input_tokens: 3, output_tokens: between(120, 900), cache_read_input_tokens: usage - 3000, cache_creation_input_tokens: 2997 } } }
}

function git(dir, ...args) {
  execFileSync('git', ['-C', dir, '-c', 'user.name=Demo User', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'ignore' })
}

function makeRepo(dir, committed, dirty, untracked) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [file, body] of Object.entries(committed)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'Initial project setup')
  for (const [file, body] of Object.entries(dirty)) writeFileSync(join(dir, file), body)
  for (const [file, body] of Object.entries(untracked)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
}

const dirs = {
  sessions: join(ROOT, 'sessions', 'org', 'user'),
  projects: join(ROOT, 'projects'),
  data: join(ROOT, 'data'),
  work: join(ROOT, 'work'),
}
rmSync(ROOT, { recursive: true, force: true })
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

const repos = {
  'web-app': [{ 'src/theme/tokens.css': ':root { --bg: #fff; }\n', 'src/settings/SettingsPage.tsx': 'export const SettingsPage = () => null\n' }, { 'src/theme/tokens.css': ':root { --bg: #fff; }\n[data-theme=dark] { --bg: #111; }\n', 'src/settings/SettingsPage.tsx': 'export const SettingsPage = () => <Toggle />\n' }, { 'src/theme/useTheme.ts': 'export const useTheme = () => {}\n' }],
  'api-server': [{ 'src/cart/service.ts': 'export class CartService {}\n', 'tests/checkout.test.ts': 'test("checkout", () => {})\n' }, { 'src/cart/service.ts': 'export class CartService { lock() {} }\n' }, {}],
  'data-pipeline': [{ 'jobs/reports.py': 'def run(): pass\n' }, { 'jobs/reports.py': 'async def run(): pass\n' }, { 'jobs/queue.py': 'class Queue: ...\n' }],
  'docs-site': [{ 'docs/releases/2.3.md': '# 2.3\n' }, {}, { 'docs/releases/2.4.md': '# 2.4\n' }],
  'mobile-app': [{ 'app/build.gradle': 'android {}\n' }, {}, {}],
}
const workDir = (name) => join(dirs.work, name)
for (const [name, [committed, dirty, untracked]] of Object.entries(repos)) makeRepo(workDir(name), committed, dirty, untracked)

const sessions = []
function addSession({ title, project, status, detail, turns, ageMs, context, transcript, starred = false, history = 0 }) {
  const cliSessionId = randomUUID()
  const sessionId = `local_${randomUUID()}`
  const cwd = workDir(project)
  const usageHistory = []
  for (let i = 0; i < history; i += 1) {
    const at = NOW - between(1, 21) * DAY - between(0, 12) * HOUR
    usageHistory.push({ type: 'assistant', timestamp: iso(at), message: { id: `msg_hist_${sessionId}_${i}`, model: MODEL, content: [], usage: { input_tokens: 4, output_tokens: between(300, 5200), cache_read_input_tokens: between(40000, 90000), cache_creation_input_tokens: between(1000, 6000) } } })
  }
  const lines = [...usageHistory, ...transcript(context)]
  const dir = join(dirs.projects, `-demo-${project}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${cliSessionId}.jsonl`)
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const touched = new Date(NOW - ageMs)
  utimesSync(file, touched, touched)
  writeFileSync(join(dirs.sessions, `${sessionId}.json`), JSON.stringify({
    sessionId,
    cliSessionId,
    cwd,
    originCwd: cwd,
    gitAnchors: [{ gitRoot: cwd, commonDir: join(cwd, '.git') }],
    title,
    model: MODEL,
    effort: 'medium',
    isArchived: false,
    permissionMode: 'default',
    createdAt: NOW - 3 * DAY,
    lastActivityAt: NOW - ageMs,
    completedTurns: turns,
    postTurnSummary: { status_category: status, status_detail: detail },
  }, null, 2))
  sessions.push({ sessionId, file, starred, ageMs, title })
  return sessionId
}

const ago = (ms) => NOW - ms

const darkMode = addSession({
  title: 'Add dark mode to the settings page',
  project: 'web-app',
  status: 'in_progress',
  detail: 'Toggle and theme tokens added; running the settings tests',
  turns: 3,
  ageMs: 2 * SECOND,
  starred: true,
  history: 14,
  transcript: (ctx) => [
    user(ago(11 * MINUTE), 'Add a dark mode toggle to the settings page and remember the choice between visits.'),
    reply(ago(10.5 * MINUTE), ctx - 30000, say("I'll start by checking how the settings page and the theme are wired up."), tool('w1', 'Grep', { pattern: 'theme' }), tool('w2', 'Read', { file_path: join(workDir('web-app'), 'src/settings/SettingsPage.tsx') }), tool('w3', 'Read', { file_path: join(workDir('web-app'), 'src/theme/tokens.css') })),
    result(ago(10 * MINUTE), 'w1', 'w2', 'w3'),
    reply(ago(9.5 * MINUTE), ctx - 20000, say('The app already uses CSS variables for colour, so dark mode is mostly a second set of tokens. My plan:\n- Put a `data-theme` attribute on `<html>`\n- Add a **Appearance** toggle to the settings page\n- Save the choice in `localStorage` and fall back to the system setting\n\nImplementing it now.'), tool('w4', 'Edit', { file_path: join(workDir('web-app'), 'src/theme/tokens.css') }), tool('w5', 'Edit', { file_path: join(workDir('web-app'), 'src/settings/SettingsPage.tsx') }), tool('w6', 'Write', { file_path: join(workDir('web-app'), 'src/theme/useTheme.ts') })),
    result(ago(8 * MINUTE), 'w4', 'w5', 'w6'),
    reply(ago(6 * MINUTE), ctx, say('First pass is done for PROJ-214. The toggle lives under **Settings → Appearance**, and a preview build is at https://staging.example.com/settings. I opened https://gitlab.example.com/example/web-app/-/merge_requests/42 as a draft. Running the settings tests now.'), tool('w7', 'Bash', { command: 'npm test -- settings' })),
  ].map((line, index, all) => (index === all.length - 1 ? { ...line, timestamp: iso(ago(25 * SECOND)) } : line)),
  context: 92000,
})

const checkout = addSession({
  title: 'Fix the flaky checkout test',
  project: 'api-server',
  status: 'blocked',
  detail: 'Race condition found in the cart service; waiting for a decision on the fix',
  turns: 4,
  ageMs: 3 * MINUTE,
  starred: true,
  history: 18,
  transcript: (ctx) => [
    user(ago(26 * MINUTE), 'The checkout integration test fails about one run in ten. Can you find out why?'),
    reply(ago(25 * MINUTE), ctx - 40000, say("Let me reproduce it first. I'll run the test repeatedly and read the cart service."), tool('c1', 'Bash', { command: 'for i in $(seq 1 20); do npm test -- checkout --runInBand || echo "FAIL $i"; done' }), tool('c2', 'Read', { file_path: join(workDir('api-server'), 'tests/checkout.test.ts') }), tool('c3', 'Read', { file_path: join(workDir('api-server'), 'src/cart/service.ts') })),
    result(ago(22 * MINUTE), 'c1', 'c2', 'c3'),
    reply(ago(20 * MINUTE), ctx - 12000, say('Found it, and it is a real bug rather than test noise.\n\n`CartService.reserveStock()` and `applyCoupon()` both read the cart, change it and write it back with no lock. When the test fires them together, whichever write lands second silently overwrites the first. It failed in 2 of 20 local runs, always with the coupon missing from the final total.'), tool('c4', 'Edit', { file_path: join(workDir('api-server'), 'src/cart/service.ts') })),
    result(ago(19 * MINUTE), 'c4'),
    reply(ago(3 * MINUTE), ctx, say('There are two reasonable fixes and they trade simplicity for throughput. Which would you like?\n\n1. **Retry** the stock reservation up to three times when the cart changed underneath it. Small change, but it hides the race.\n2. **Serialize** writes with a per-cart lock. Slightly more code, and it removes the race for good.'), tool('c5', 'AskUserQuestion', { questions: [{ question: 'Retry the stock reservation up to three times, or serialize cart writes with a per-cart lock?' }] })),
  ],
  context: 124000,
})

const reports = addSession({
  title: 'Move the reports job to an async queue',
  project: 'data-pipeline',
  status: 'completed',
  detail: 'Reports job now runs on the queue; MR opened and tests pass',
  turns: 9,
  ageMs: 47 * MINUTE,
  starred: true,
  history: 26,
  transcript: (ctx) => [
    user(ago(3 * HOUR), 'The nightly reports job blocks the API for minutes. Move it onto the background queue without changing the output.'),
    reply(ago(2.9 * HOUR), ctx - 90000, say("I'll look at how the job is triggered and what the queue already supports."), tool('r1', 'Read', { file_path: join(workDir('data-pipeline'), 'jobs/reports.py') }), tool('r2', 'Grep', { pattern: 'Queue' }), tool('r3', 'Bash', { command: 'git log --oneline -n 15 -- jobs/' })),
    result(ago(2.8 * HOUR), 'r1', 'r2', 'r3'),
    reply(ago(2.5 * HOUR), ctx - 60000, say('The queue supports retries and a dead-letter list, which is what the reports job needs. Plan for PROJ-301:\n1. Wrap the job body in an async task\n2. Enqueue it from the scheduler instead of calling it\n3. Add a test that the output file matches the old one byte for byte'), tool('r4', 'Edit', { file_path: join(workDir('data-pipeline'), 'jobs/reports.py') }), tool('r5', 'Write', { file_path: join(workDir('data-pipeline'), 'jobs/queue.py') })),
    result(ago(2.2 * HOUR), 'r4', 'r5'),
    reply(ago(1.2 * HOUR), ctx - 20000, say('Tests pass, including the byte-for-byte comparison against last night\'s output.'), tool('r6', 'Bash', { command: 'pytest jobs -q' })),
    result(ago(1.1 * HOUR), 'r6'),
    reply(ago(47 * MINUTE), ctx, say('Migration is complete. Summary:\n- The reports job runs on the queue with 3 retries\n- Failed runs land in the dead-letter list instead of being lost\n- API latency during the nightly run dropped from minutes to normal\n\nMerge request: https://gitlab.example.com/example/data-pipeline/-/merge_requests/87. I did not touch the scheduler config, so you will need to enable the new task there.')),
  ],
  context: 215000,
})

const notes = addSession({
  title: 'Draft the 2.4 release notes',
  project: 'docs-site',
  status: 'completed',
  detail: 'Release notes drafted in docs/releases/2.4.md',
  turns: 3,
  ageMs: 2 * HOUR,
  starred: true,
  history: 9,
  transcript: (ctx) => [
    user(ago(2.5 * HOUR), 'Write release notes for 2.4 from the merged changes since 2.3. Keep them short and user-facing.'),
    reply(ago(2.4 * HOUR), ctx - 8000, say("I'll read the changelog entries since 2.3."), tool('n1', 'Bash', { command: 'git log v2.3..HEAD --oneline' })),
    result(ago(2.3 * HOUR), 'n1'),
    reply(ago(2 * HOUR), ctx, say('Drafted `docs/releases/2.4.md` with three sections: **New**, **Improved** and **Fixed**. I left out internal refactors. Two entries reference PROJ-188 and PROJ-190, so please check the wording against those tickets.'), tool('n2', 'Write', { file_path: join(workDir('docs-site'), 'docs/releases/2.4.md') })),
    result(ago(1.9 * HOUR), 'n2'),
  ],
  context: 38000,
})

addSession({ title: 'Investigate the slow search endpoint', project: 'api-server', status: 'completed', detail: 'Missing index on the products table; added in a migration', turns: 5, ageMs: 5 * HOUR, history: 20, context: 61000, transcript: (ctx) => [user(ago(6 * HOUR), 'The search endpoint takes over two seconds. Why?'), reply(ago(5 * HOUR), ctx, say('The query scans the whole products table because there is no index on `name`. I added one in a migration and the endpoint now answers in about 40 ms.'))] })
addSession({ title: 'Upgrade the build to Node 22', project: 'web-app', status: 'completed', detail: 'CI and local builds pass on Node 22', turns: 4, ageMs: 1 * DAY, history: 11, context: 47000, transcript: (ctx) => [user(ago(26 * HOUR), 'Upgrade the build to Node 22 and fix whatever breaks.'), reply(ago(25 * HOUR), ctx, say('Upgraded. Two packages needed a minor bump and one deprecated API was replaced. CI is green.'))] })
addSession({ title: 'Fix the crash when rotating the screen', project: 'mobile-app', status: 'blocked', detail: 'Cannot reproduce on an emulator; needs a device log', turns: 6, ageMs: 2 * DAY, history: 16, context: 83000, transcript: (ctx) => [user(ago(50 * HOUR), 'The app crashes when the screen rotates on the checkout screen.'), reply(ago(49 * HOUR), ctx, say('I could not reproduce this on an emulator. If you can capture a device log from a crash, I can pinpoint it.'))] })
addSession({ title: 'Add pagination to the orders API', project: 'api-server', status: 'completed', detail: 'Cursor pagination added with tests', turns: 7, ageMs: 3 * DAY, history: 13, context: 55000, transcript: (ctx) => [user(ago(74 * HOUR), 'Add cursor pagination to the orders endpoint.'), reply(ago(73 * HOUR), ctx, say('Added cursor pagination with a default page size of 50, and tests for the first, middle and last pages.'))] })

const focused = sessions.filter((s) => s.starred).map((s) => s.sessionId)
writeFileSync(join(dirs.data, 'focus.json'), JSON.stringify({ ids: focused }, null, 2))
writeFileSync(join(dirs.data, 'queue.json'), JSON.stringify({
  [darkMode]: { paused: false, items: [
    { qid: randomUUID(), prompt: 'When the tests pass, also add a screenshot test for the dark theme.', addedAt: NOW - 5 * MINUTE },
    { qid: randomUUID(), prompt: 'Then update the README section on theming.', addedAt: NOW - 4 * MINUTE },
  ] },
}, null, 2))
const nextSix = new Date(NOW)
nextSix.setHours(18, 0, 0, 0)
if (nextSix.getTime() <= NOW) nextSix.setDate(nextSix.getDate() + 1)
writeFileSync(join(dirs.data, 'schedules.json'), JSON.stringify({ items: [
  { sid: randomUUID(), id: notes, prompt: 'Summarize today\'s merged changes into the changelog draft.', at: nextSix.getTime(), repeat: 'weekdays' },
] }, null, 2))

const stub = join(ROOT, 'claude-stub.sh')
writeFileSync(stub, '#!/bin/sh\necho "Demo mode: prompts are not sent to Claude." >&2\nexit 1\n')
chmodSync(stub, 0o755)

const working = sessions[0]
setInterval(() => {
  const now = new Date()
  utimesSync(working.file, now, now)
}, 4 * SECOND)

console.log(`Demo data in ${ROOT}`)
const child = spawn(process.execPath, [SERVER], {
  stdio: 'inherit',
  env: { ...process.env, PORT, SESSIONS_DIR: join(ROOT, 'sessions'), PROJECTS_DIR: dirs.projects, DATA_DIR: dirs.data, CLAUDE_BIN: stub },
})
const stop = () => { child.kill('SIGTERM'); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', (code) => process.exit(code ?? 0))
