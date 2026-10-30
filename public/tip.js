let tip = null
let owner = null

function element() {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.append(tip)
  return tip
}

export function hideTip() {
  if (tip) tip.hidden = true
  owner = null
}

function place(target) {
  const box = element()
  const anchor = target.getBoundingClientRect()
  const width = box.offsetWidth
  const height = box.offsetHeight
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8)
  const below = anchor.bottom + 8
  const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 8) : below
  box.style.left = `${left}px`
  box.style.top = `${top}px`
}

function fill(content) {
  const box = element()
  box.replaceChildren()
  const heading = document.createElement('b')
  heading.textContent = content.heading
  const text = document.createElement('p')
  text.textContent = content.text
  box.append(heading, text)
  if (content.rows.length) {
    const list = document.createElement('dl')
    for (const [label, value] of content.rows) {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = value
      list.append(term, detail)
    }
    box.append(list)
  }
}

export function attachTip(node, build) {
  const show = () => {
    const box = element()
    fill(build())
    box.hidden = false
    owner = node
    place(node)
  }
  const hide = () => { if (owner === node) hideTip() }
  node.tabIndex = 0
  node.addEventListener('mouseenter', show)
  node.addEventListener('mouseleave', hide)
  node.addEventListener('focus', show)
  node.addEventListener('blur', hide)
  return node
}
