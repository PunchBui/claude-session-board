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
