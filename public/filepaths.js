export const PATH_PATTERN = /(?<![\w:/.~-])(?:~|\/(?:Users|home|tmp|private|var|Volumes|Applications|Library|System|opt|usr|etc|mnt|srv|cores|Network))\/[^\s<>"'`]+/

export const BARE_DOC_PATTERN = /(?<![\w/.~:@-])\w[\w.-]*\.(?:pptx|potx|docx|xlsx|xlsm|csv|pages|numbers)(?![\w-])/

const WHOLE_BARE_DOC = new RegExp(`^(?:${BARE_DOC_PATTERN.source})$`)
const WHOLE_PATH = new RegExp(`^(?:${PATH_PATTERN.source})$`)
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i
const HTML_PATH = /\.html?$/i
const PDF_PATH = /\.pdf$/i
const LOCATION_SUFFIX = /:\d+(?::\d+)?$/

export const isPath = (value) => WHOLE_PATH.test(value)
export const isBareDoc = (value) => WHOLE_BARE_DOC.test(value)
export const isImagePath = (value) => IMAGE_PATH.test(value)
export const isHtmlPath = (value) => HTML_PATH.test(value)
export const isPdfPath = (value) => PDF_PATH.test(value)
export const stripLocation = (value) => value.replace(LOCATION_SUFFIX, '')
export const isRelativeHtml = (value) => /^(?![/~]|[a-z][a-z0-9+.-]*:)[^\s<>"'`]+\.html?$/i.test(value) && !value.includes('..')
export const fileUrl = (path, base) => `/api/file?path=${encodeURIComponent(path)}${base && !/^[/~]/.test(path) ? `&base=${encodeURIComponent(base)}` : ''}`
