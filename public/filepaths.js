export const PATH_PATTERN = /(?<![\w:/.~-])(?:~|\/(?:Users|tmp|private|var\/folders|Volumes))\/[^\s<>"'`]+/

const WHOLE_PATH = new RegExp(`^(?:${PATH_PATTERN.source})$`)
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i
const LOCATION_SUFFIX = /:\d+(?::\d+)?$/

export const isPath = (value) => WHOLE_PATH.test(value)
export const isImagePath = (value) => IMAGE_PATH.test(value)
export const stripLocation = (value) => value.replace(LOCATION_SUFFIX, '')
export const fileUrl = (path) => `/api/file?path=${encodeURIComponent(path)}`
