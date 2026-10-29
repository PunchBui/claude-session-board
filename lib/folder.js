import { execFile } from 'node:child_process'

const SCRIPT = 'POSIX path of (choose folder with prompt "Choose a folder for the new chat")'

export function runOsascript() {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', SCRIPT], { timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr }))
      resolve(stdout)
    })
  })
}

export async function pickFolder({ platform = process.platform, run = runOsascript } = {}) {
  if (platform !== 'darwin') return { unsupported: true }
  try {
    const path = (await run()).trim().replace(/(.)\/+$/, '$1')
    return path ? { path } : { cancelled: true }
  } catch (error) {
    if (/-128|cancel/i.test(error.stderr ?? error.message ?? '')) return { cancelled: true }
    throw error
  }
}
