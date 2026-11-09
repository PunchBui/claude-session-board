// Phone layout: the header controls and the Focus sidebar live in a hamburger drawer.
// The existing nodes are moved (not cloned), so every handler and id keeps working.
// Desktop is untouched: above the breakpoint nodes go back to where index.html put them.
export const mq = window.matchMedia('(max-width: 720px)')
export const isMobile = () => mq.matches

const $ = (id) => document.getElementById(id)
const moved = []

function park(node, into, before = null) {
  if (!node || moved.some((m) => m.node === node)) return
  moved.push({ node, parent: node.parentNode, next: node.nextSibling })
  into.insertBefore(node, before)
}

function restore() {
  while (moved.length) {
    const { node, parent, next } = moved.pop()
    parent.insertBefore(node, next && next.parentNode === parent ? next : null)
  }
}

export function openDrawer() {
  if (!isMobile() || $('drawer').classList.contains('open')) return
  $('drawer').classList.add('open')
  $('drawer').setAttribute('aria-hidden', 'false')
  $('scrim').classList.add('open')
  $('menu-btn').setAttribute('aria-expanded', 'true')
  document.body.classList.add('drawer-open')
  history.pushState({ drawer: true }, '', location.href)
}

// `viaHistory`: closed by the scrim or X, so pop the entry openDrawer pushed.
// A tap on a destination closes without touching history; the destination's own navigation replaces it.
export function closeDrawer(viaHistory = false) {
  if (!$('drawer').classList.contains('open')) return
  $('drawer').classList.remove('open')
  $('drawer').setAttribute('aria-hidden', 'true')
  $('scrim').classList.remove('open')
  $('menu-btn').setAttribute('aria-expanded', 'false')
  document.body.classList.remove('drawer-open')
  if (viaHistory && history.state?.drawer) history.back()
}

function layout() {
  document.body.classList.toggle('m', isMobile())
  const filter = $('side-q')
  filter.placeholder = isMobile() ? 'Filter sessions' : 'Filter focused sessions'
  filter.setAttribute('aria-label', filter.placeholder)
  if (isMobile()) {
    park(document.querySelector('.side'), $('drawer-side'))
    park(document.querySelector('.topbar .tabs'), $('drawer-nav'))
    const foot = $('drawer-foot')
    for (const node of [$('limits'), $('broadcast-open'), $('alerts'), $('interval').closest('label'), $('archived').closest('label')]) park(node, foot)
    park($('q'), document.querySelector('#view-all'), document.querySelector('#view-all').firstChild)
  } else {
    closeDrawer()
    restore()
  }
}

export function initMobile({ onChange }) {
  $('menu-btn').onclick = openDrawer
  $('drawer-close').onclick = () => closeDrawer(true)
  $('scrim').onclick = () => closeDrawer(true)
  // Back closes an open drawer before it leaves the page.
  window.addEventListener('popstate', () => closeDrawer(false))
  $('drawer').addEventListener('click', (event) => {
    if (event.target.closest('.item, .drawer-nav a, #new-chat, #broadcast-open, .other-item')) setTimeout(() => closeDrawer(false), 0)
  })
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(true) })
  layout()
  mq.addEventListener('change', () => { layout(); onChange() })
}

// iOS Safari ignores user-scalable=no for pinch, so stop the gesture itself. Double-tap zoom is off via CSS.
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(name, (event) => event.preventDefault())
