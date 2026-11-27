import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export function readConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    return c && typeof c === 'object' ? c : {}
  } catch {
    return {}
  }
}

function currentHosts(config) {
  return Array.isArray(config.hosts) ? config.hosts : []
}

export function addHost(config, pattern, host, token) {
  const hosts = currentHosts(config).filter(h => !pattern.test(h) && h !== host)
  return { ...config, hosts: [...hosts, host], token }
}

export function removeHosts(config, pattern) {
  const hosts = currentHosts(config).filter(h => !pattern.test(h))
  return hosts.length ? { ...config, hosts } : null
}

function write(file, config) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, action, pattern, host, token] = process.argv.slice(2)
  const re = new RegExp(pattern)
  const config = readConfig(file)
  if (action === 'add') {
    write(file, addHost(config, re, host, token))
  } else if (action === 'remove') {
    const next = removeHosts(config, re)
    if (next) write(file, next)
    else fs.rmSync(file, { force: true })
  } else {
    process.exit(2)
  }
}
