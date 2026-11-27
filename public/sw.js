const CACHE = 'board-shell-v54'
const SHELL = ['/', '/app.css', '/app.js', '/alerts.js', '/autofocus.js', '/warmth.js', '/skills.js', '/mrs.js', '/loops.js', '/timeline.js', '/timelineview.js', '/calendar.js', '/tip.js', '/drafts.js', '/history.js', '/icons.js', '/mobile.js', '/richtext.js', '/filepaths.js', '/linkmenu.js', '/sidebar.js', '/sidechats.js', '/attachments.js', '/patch.js', '/coalesce.js', '/flow.js', '/flowview.js', '/flowmap.js', '/widgets.js', '/quickreply.js', '/guards.js', '/slash.js', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']
const PAGES = new Set(['/', '/focus', '/loops', '/background', '/mrs', '/flow', '/search', '/usage', '/skills', '/schedule'])

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  const key = PAGES.has(url.pathname.replace(/(.)\/+$/, '$1')) ? '/' : request.url
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(key, copy))
        }
        return response
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())))
})
