// What a changed file means for the running board:
//   'page'   a file the browser loads (public/): reload the window
//   'server' server code (server.js, lib/): restart the server, then reload
//   null     anything else (tests, data, editor temp files): ignore
const path = require('node:path')

const PAGE_EXT = new Set(['.js', '.css', '.html', '.svg', '.png', '.webmanifest', '.json'])
const IGNORED = /(^|\/)(\.|#)|~$|\.(swp|swx|tmp|orig)$|\.test\.js$/

function classify(repo, file) {
  const relative = path.relative(repo, file).split(path.sep).join('/')
  if (!relative || relative.startsWith('..') || IGNORED.test(relative)) return null
  const ext = path.extname(relative)
  if (relative.startsWith('public/') && PAGE_EXT.has(ext)) return 'page'
  if (relative === 'server.js' || (relative.startsWith('lib/') && ext === '.js')) return 'server'
  return null
}

// Collects changes for `wait` ms, then calls `run` once with the strongest kind seen:
// a server restart already reloads the page, so 'server' wins over 'page'.
function createBatcher(run, { waitPage = 150, waitServer = 500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null
  let kind = null
  return (next) => {
    if (!next) return
    kind = kind === 'server' || next === 'server' ? 'server' : 'page'
    clearTimer(timer)
    timer = setTimer(() => {
      const fire = kind
      timer = null
      kind = null
      run(fire)
    }, kind === 'server' ? waitServer : waitPage)
  }
}

module.exports = { classify, createBatcher }
