const COPYABLE = /^(https?|claude):/i

export function copyTarget({ copy, href }) {
  if (copy) return { value: copy, label: 'Copy path' }
  if (href && COPYABLE.test(href)) return { value: href, label: 'Copy link' }
  return null
}

const anchorTarget = (anchor) => copyTarget({ copy: anchor.dataset.copy, href: anchor.getAttribute('href') === '#' ? '' : anchor.href })

export function initLinkMenu(onCopy) {
  let menu = null

  const close = () => {
    menu?.remove()
    menu = null
  }

  const open = (target, x, y) => {
    close()
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = target.label
    button.onclick = async () => {
      close()
      try {
        await navigator.clipboard.writeText(target.value)
        onCopy(true, target)
      } catch {
        onCopy(false, target)
      }
    }
    menu = document.createElement('div')
    menu.className = 'linkmenu'
    menu.setAttribute('role', 'menu')
    menu.append(button)
    document.body.append(menu)
    const left = Math.min(x, window.innerWidth - menu.offsetWidth - 8)
    const top = Math.min(y, window.innerHeight - menu.offsetHeight - 8)
    menu.style.left = `${Math.max(8, left)}px`
    menu.style.top = `${Math.max(8, top)}px`
    button.focus()
  }

  document.addEventListener('contextmenu', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    const target = anchor && anchorTarget(anchor)
    if (!target) return close()
    event.preventDefault()
    open(target, event.clientX, event.clientY)
  })
  document.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  document.addEventListener('scroll', close, true)
}
