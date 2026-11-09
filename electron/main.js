// A standalone window for Claude Session Board. The board itself is unchanged: this opens it
// in its own app (own Dock icon, no browser chrome) and, while it runs, reloads the window when
// files in public/ change and restarts the server when server.js or lib/ change.
const { app, BrowserWindow, Menu, shell, session, nativeImage, nativeTheme } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { classify, createBatcher } = require('./watch.cjs')

const PORT = Number(process.env.PORT ?? 4747)
const ORIGIN = `http://127.0.0.1:${PORT}`
const LABEL = 'com.user.claude-session-board'
const OPEN_PROTOCOLS = new Set(['claude:', 'https:', 'http:', 'mailto:'])

// Where the board's code lives: next to this folder in development, or the path recorded by build.sh.
function repoRoot() {
  if (process.env.BOARD_REPO) return process.env.BOARD_REPO
  if (!app.isPackaged) return path.resolve(__dirname, '..')
  try {
    return require('./repo.json').repo
  } catch {
    return path.resolve(__dirname, '..')
  }
}
const repo = repoRoot()

let win = null
let ownServer = null
let autoReload = true
let restarting = false
let restartAgain = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function healthy() {
  try {
    const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitHealthy(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await healthy()) return true
    await sleep(300)
  }
  return false
}

const launchctl = (...args) => new Promise((resolve) => execFile('launchctl', args, (error) => resolve(!error)))
const agentTarget = () => `gui/${process.getuid()}/${LABEL}`

function spawnOwnServer() {
  ownServer = spawn(process.execPath, [path.join(repo, 'server.js')], {
    cwd: repo,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
    stdio: 'ignore',
  })
  ownServer.once('exit', () => { ownServer = null })
}

// Uses the launch agent when it is installed, otherwise runs the server itself.
async function ensureServer() {
  if (await healthy()) return true
  if (await launchctl('kickstart', agentTarget()) && (await waitHealthy(8000))) return true
  spawnOwnServer()
  return waitHealthy(12000)
}

async function restartServer() {
  if (restarting) { restartAgain = true; return }
  restarting = true
  try {
    do {
      restartAgain = false
      if (ownServer) {
        ownServer.kill()
        await sleep(400)
        spawnOwnServer()
      } else if (!(await launchctl('kickstart', '-k', agentTarget()))) {
        spawnOwnServer()
      }
      await waitHealthy(15000)
    } while (restartAgain)
  } finally {
    restarting = false
  }
  reloadPage()
}

function reloadPage() {
  if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache()
}

function watchCode() {
  const batch = createBatcher((kind) => {
    if (!autoReload) return
    if (kind === 'server') restartServer()
    else reloadPage()
  })
  for (const target of ['public', 'lib', 'server.js']) {
    const full = path.join(repo, target)
    if (!fs.existsSync(full)) continue
    try {
      fs.watch(full, { recursive: true }, (event, name) => batch(classify(repo, name ? path.join(full, name) : full)))
    } catch {}
  }
}

const isBoard = (url) => {
  try {
    const { origin } = new URL(url)
    return origin === ORIGIN || origin === `http://localhost:${PORT}`
  } catch {
    return false
  }
}

function openOutside(url) {
  try {
    if (OPEN_PROTOCOLS.has(new URL(url).protocol)) shell.openExternal(url)
  } catch {}
}

// The page's top bar doubles as the title bar: clear of the traffic lights, and draggable.
const TITLEBAR_CSS = `
  .topbar { padding-left: 92px !important; -webkit-app-region: drag; }
  .topbar a, .topbar button, .topbar input, .topbar select, .topbar label, .topbar .live, .notif-panel { -webkit-app-region: no-drag; }
`

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'Claude Session Board',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  })
  const contents = win.webContents
  contents.on('did-finish-load', () => { if (isBoard(contents.getURL())) contents.insertCSS(TITLEBAR_CSS).catch(() => {}) })
  contents.setWindowOpenHandler(({ url }) => {
    if (isBoard(url)) contents.loadURL(url)
    else openOutside(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isBoard(url)) return
    event.preventDefault()
    openOutside(url)
  })
  win.on('closed', () => { win = null })
  return win
}

async function showBoard() {
  const up = await ensureServer()
  if (!win) createWindow()
  if (up) return void win.loadURL(`${ORIGIN}/focus`)
  const message = `Could not reach the board at ${ORIGIN}. Start it with "npm start" in ${repo}, then reopen this app.`
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="font:16px system-ui;padding:64px;background:#262624;color:#eee">${message}</body>`)}`)
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { label: 'Auto reload on code changes', type: 'checkbox', checked: true, click: (item) => { autoReload = item.checked } },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]))
}

app.setName('Claude Session Board')

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.whenReady().then(async () => {
    const ses = session.defaultSession
    // The page registers a service worker for the installed-browser app. Here it would only serve
    // stale files after a code change, so refuse it and clear any earlier one.
    ses.webRequest.onBeforeRequest({ urls: [`${ORIGIN}/sw.js`, `http://localhost:${PORT}/sw.js`] }, (details, callback) => callback({ cancel: true }))
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {})
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(isBoard(details.requestingUrl) && ['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
    })
    try {
      const icon = nativeImage.createFromPath(path.join(repo, 'public/icon-512.png'))
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
    } catch {}
    buildMenu()
    watchCode()
    await showBoard()
    app.on('activate', () => { if (!win) showBoard() })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { ownServer?.kill() })
}
