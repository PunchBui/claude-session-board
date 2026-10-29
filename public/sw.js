const CACHE = 'board-shell-v1'
const SHELL = ['/', '/app.css', '/app.js', '/alerts.js', '/autofocus.js', '/history.js', '/icons.js', '/richtext.js', '/favicon.svg', '/icon-192.png', '/icon-512.png']
const PAGES = new Set(['/', '/focus', '/search', '/usage'])

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
