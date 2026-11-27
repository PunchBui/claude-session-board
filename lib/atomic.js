import { open, rename, readFile, mkdir, rm } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'

const queues = new Map()
const locks = new Map()
let counter = 0

async function replaceFile(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${counter++}.tmp`)
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export function writeJsonAtomic(file, value) {
  const text = JSON.stringify(value, null, 2)
  const key = resolve(file)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => replaceFile(file, text))
  queues.set(key, next)
  const release = () => {
    if (queues.get(key) === next) queues.delete(key)
  }
  next.then(release, release)
  return next
}

export function withFileLock(file, task) {
  const key = resolve(file)
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(key, next)
  const release = () => {
    if (locks.get(key) === next) locks.delete(key)
  }
  next.then(release, release)
  return next
}

export function updateJsonFile(file, fallback, mutate, { read = readJsonQuarantine, write = writeJsonAtomic } = {}) {
  return withFileLock(file, async () => {
    const before = await read(file, fallback)
    const after = await mutate(before)
    if (after !== before) await write(file, after)
    return { before, after }
  })
}

export async function readJsonQuarantine(file, fallback, { now = Date.now, onCorrupt = () => {} } = {}) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    const kept = `${file}.corrupt-${now()}`
    await rename(file, kept).catch(() => {})
    onCorrupt({ file, kept, error })
    return fallback
  }
}
