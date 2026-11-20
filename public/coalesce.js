export function coalesce(task) {
  let running = null
  let queued = null
  const start = () => {
    running = Promise.resolve().then(task).finally(() => { running = null })
    return running
  }
  return function run() {
    if (queued) return queued
    if (!running) return start()
    const settle = () => { queued = null; return start() }
    queued = running.then(settle, settle)
    return queued
  }
}
