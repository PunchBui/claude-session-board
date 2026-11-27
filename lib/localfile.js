import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname, isAbsolute, join } from 'node:path'

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

const spotlight = async (name) => {
  const { stdout } = await promisify(execFile)('mdfind', ['-name', name], { timeout: 5000 }).catch(() => ({ stdout: '' }))
  return stdout.split('\n').filter(Boolean)
}

export async function findByName(name, { search = spotlight, home = homedir() } = {}) {
  const hits = []
  for (const candidate of await search(name)) {
    if (basename(candidate) !== name) continue
    const info = await stat(candidate).catch(() => null)
    if (info?.isFile()) hits.push({ path: candidate, mtime: info.mtimeMs, library: candidate.startsWith(join(home, 'Library')) })
  }
  hits.sort((a, b) => Number(a.library) - Number(b.library) || b.mtime - a.mtime)
  return hits[0] ? resolveLocal(hits[0].path, { home }) : null
}

export async function resolveWithBase(value, base, options = {}) {
  const direct = await resolveLocal(value, options)
  if (direct) return direct
  if (typeof value !== 'string' || !value || /^[/~]/.test(value) || value.split('/').includes('..')) return null
  if (typeof base === 'string' && isAbsolute(base)) {
    const inBase = await resolveLocal(join(base, value), options)
    if (inBase) return inBase
  }
  return value.includes('/') ? null : findByName(value, options)
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

export function fileKind(found) {
  if (!found || found.directory) return null
  const kinds = [
    ['html', isHtmlFile(found.path), MAX_HTML_BYTES],
    ['pdf', isPdfFile(found.path), MAX_PDF_BYTES],
    ['image', Boolean(imageType(found.path)), MAX_IMAGE_BYTES],
  ]
  const match = kinds.find(([, fits]) => fits)
  if (!match) return null
  return found.size <= match[2] ? { kind: match[0] } : { tooLarge: true }
}
