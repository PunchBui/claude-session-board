// One sidebar holds the page menu, the Focus list and the global controls.
// Phone (<= 720px): it is a slide-in drawer behind the header's menu button, sessions first.
// Desktop: it is always open on the left, page menu first, and can shrink to an icon rail.
// Nodes that sit in different places per layout are moved (not cloned), so every handler and id keeps working.
export const mq = window.matchMedia('(max-width: 720px)')
export const isMobile = () => mq.matches

const $ = (id) => document.getElementById(id)
const moved = []
const COLLAPSED_KEY = 'board.sideCollapsed'

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

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

function setCollapsed(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed)
  const button = $('side-collapse')
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(collapsed))
}

function layout() {
  const mobile = isMobile()
  document.body.classList.toggle('m', mobile)
  document.body.classList.toggle('d', !mobile)
  const filter = $('side-q')
  filter.placeholder = mobile ? 'Filter sessions' : 'Filter focused sessions'
  filter.setAttribute('aria-label', filter.placeholder)
  closeDrawer()
  restore()
  const body = $('drawer-body')
  if (mobile) {
    body.insertBefore($('drawer-side'), $('drawer-nav'))
    park($('archived').closest('label'), $('drawer-foot'))
    $('drawer').setAttribute('aria-hidden', 'true')
  } else {
    body.insertBefore($('drawer-nav'), $('drawer-side'))
    for (const node of [$('live'), $('history'), $('notif-panel')]) park(node, $('drawer-head-slot'))
    // One compact row: Focus · new chat · sort · broadcast · clean all. The filter field is phone-only.
    for (const node of [$('new-chat'), $('side-sort-btn'), $('side-sort-menu'), $('broadcast-open'), $('focus-clear')]) park(node, $('focus-tools'))
    filter.value = ''
    $('drawer').setAttribute('aria-hidden', 'false')
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
  setCollapsed(readCollapsed())
  $('side-collapse').onclick = () => {
    const collapsed = !document.body.classList.contains('side-collapsed')
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0') } catch {}
    setCollapsed(collapsed)
  }
  layout()
  mq.addEventListener('change', () => { layout(); onChange() })
}

// iOS Safari ignores user-scalable=no for pinch, so stop the gesture itself. Double-tap zoom is off via CSS.
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(name, (event) => event.preventDefault())
