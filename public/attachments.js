// Prompts sent from the board carry their attachments as a trailing "Attached files:" list
// of absolute paths (see withAttachments in app.js). Split that back out so the UI can show
// the text and a preview instead of the raw paths.
const MARKER = /\n*Attached files:\n((?:- .+(?:\n|$))+)\s*$/
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i

export function splitAttachments(prompt) {
  const text = String(prompt ?? '')
  const match = MARKER.exec(text)
  if (!match) return { text, files: [] }
  const files = match[1].split('\n').filter(Boolean).map((line) => {
    const path = line.slice(2).trim()
    return { path, name: path.split('/').pop() || path, image: IMAGE_NAME.test(path) }
  })
  return { text: text.slice(0, match.index).trimEnd(), files }
}

// The default sentence the board adds when a file is sent with no text of its own.
export const DEFAULT_ATTACH_TEXT = 'Please look at the attached files.'
export const visibleText = (text) => (text === DEFAULT_ATTACH_TEXT ? '' : text)
