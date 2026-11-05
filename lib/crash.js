export function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export function installCrashGuard(proc = process, log = console.error) {
  const onRejection = (reason) => log(`unhandled rejection: ${describeError(reason)}`)
  proc.on('unhandledRejection', onRejection)
  return () => proc.off('unhandledRejection', onRejection)
}

export async function eachIsolated(items, fn, onError) {
  for (const item of items) {
    try {
      await fn(item)
    } catch (error) {
      onError(error, item)
    }
  }
}

export function logged(label, fn, log = console.error) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      log(`${label}: ${describeError(error)}`)
      return undefined
    }
  }
}
