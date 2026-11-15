import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_PATH_LENGTH = 1024

export const MAX_IMAGE_BYTES = 25_000_000

export const MAX_HTML_BYTES = 10_000_000

export const isHtmlFile = (path) => /\.html?$/i.test(path)

export const MAX_PDF_BYTES = 50_000_000

export const isPdfFile = (path) => /\.pdf$/i.test(path)

// RFC 5987 filename so Thai (and any non-ASCII) names survive the header.
export const contentDisposition = (path, attachment) => `${attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

export const imageType = (path) => IMAGE_TYPES[extname(path).toLowerCase()] ?? null

export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export async function resolveLocal(value, { home = homedir() } = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || value.includes('\0')) return null
  const expanded = expandHome(value, home)
  if (!isAbsolute(expanded)) return null
  const real = await realpath(expanded).catch(() => null)
  if (!real) return null
  const info = await stat(real).catch(() => null)
  if (!info) return null
  return { path: real, directory: info.isDirectory(), size: info.size }
}

// Appended to pages shown in the board's viewer: reports the page size so the board can pan/zoom it like a canvas.
export const SIZE_SCRIPT = `<script>(()=>{const post=()=>parent.postMessage({htmlViewerSize:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}},'*');
addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);post()})()</script>`

export const withSizeReporter = (html) => (/<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${SIZE_SCRIPT}</body>`) : html + SIZE_SCRIPT)

// Single-range "bytes=a-b" / "bytes=a-" / "bytes=-n". null = no usable range (send the whole file), 'unsatisfiable' = 416.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  let start
  let end
  if (match[1] === '') {
    const last = Number(match[2])
    if (last === 0) return 'unsatisfiable'
    start = Math.max(0, size - last)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  return start >= size || start > end ? 'unsatisfiable' : { start, end }
}
