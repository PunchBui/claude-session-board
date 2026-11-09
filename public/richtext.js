export function splitFences(value) {
  const parts = []
  let buffer = []
  let code = null
  const flushText = () => {
    const text = buffer.join('\n').replace(/^\n+|\n+$/g, '')
    if (text) parts.push({ type: 'text', text })
    buffer = []
  }
  for (const line of String(value).split('\n')) {
    const open = /^\s*```(.*)$/.exec(line)
    if (code) {
      if (/^\s*```\s*$/.test(line)) {
        parts.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') })
        code = null
      } else {
        code.lines.push(line)
      }
    } else if (open && !/```\s*$/.test(open[1])) {
      flushText()
      code = { lang: open[1].trim(), lines: [] }
    } else {
      buffer.push(line)
    }
  }
  if (code) parts.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') })
  flushText()
  return parts
}

const splitRow = (line) => {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

const isDivider = (line) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && (line.includes('|') || /^\s*:?-+:?\s*$/.test(line) === false)

const alignOf = (cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null)

// Turns a text part into blocks: paragraph, heading, table, list, quote, rule.
export function parseBlocks(value) {
  const lines = String(value).split('\n')
  const blocks = []
  let para = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { flush(); continue }
    let m
    if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))) {
      flush()
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] })
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
    } else if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]) && splitRow(line).length === splitRow(lines[i + 1]).length) {
      flush()
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map(alignOf)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i])
        while (cells.length < header.length) cells.push('')
        rows.push(cells.slice(0, header.length))
        i++
      }
      i--
      blocks.push({ type: 'table', header, aligns, rows })
    } else if (/^\s*>/.test(line)) {
      flush()
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ type: 'quote', text: quote.join('\n') })
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const ordered = /^\s*\d/.test(line)
      const items = []
      while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])) && (m[1].length > 1 || /\d/.test(m[2][0]) === ordered)) {
        items.push({ depth: Math.min(Math.floor(m[1].length / 2), 3), text: m[3] })
        i++
      }
      i--
      blocks.push({ type: 'list', ordered, items })
    } else {
      para.push(line)
    }
  }
  flush()
  return blocks
}
