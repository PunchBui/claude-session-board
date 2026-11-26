import { validModel, validEffort, validPermissionMode } from './boardsessions.js'

const MODEL_SET = /^Set model to\b/
const EFFORT_SET = /^(Set effort level to|Effort level set to)\b/

export function noteSessionSetting(settings, commandRun, output) {
  const command = commandRun?.command
  const value = String(commandRun?.args ?? '').trim()
  if (!value) return
  if (command === 'model' && MODEL_SET.test(output)) {
    if (value === 'default') settings.model = null
    else if (validModel(value)) settings.model = value
  } else if (command === 'effort' && EFFORT_SET.test(output)) {
    if (value === 'auto') settings.effort = null
    else if (validEffort(value)) settings.effort = value
  }
}

export function runSettings(raw, chosen = {}) {
  const board = raw.source === 'board'
  const pick = (key) => (key in chosen ? chosen[key] : board ? raw[key] ?? null : null)
  return { model: pick('model'), effort: pick('effort') }
}

export function shownSettings(raw, chosen = {}) {
  const pick = (key) => (key in chosen ? chosen[key] : raw[key] ?? null)
  return { model: pick('model'), effort: pick('effort') }
}

export function parseOverride(body) {
  const out = {}
  for (const [key, valid] of [['model', validModel], ['effort', validEffort], ['permissionMode', validPermissionMode]]) {
    if (!(key in (body ?? {}))) continue
    const value = body[key]
    if (value === null || value === '') out[key] = null
    else if (valid(value)) out[key] = value
    else return { error: `That ${key} is not valid.` }
  }
  return { override: out }
}

export function mergeOverride(stored, change) {
  const next = { ...stored }
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

export function withOverride(settings, override) {
  return { ...settings, ...override }
}

export function overridesFromFile(parsed) {
  const items = parsed?.items && typeof parsed.items === 'object' ? parsed.items : {}
  const out = {}
  for (const [id, value] of Object.entries(items)) {
    const { override } = parseOverride(value)
    if (override && Object.keys(override).length && /^local_[A-Za-z0-9-]{1,64}$/.test(id)) out[id] = Object.fromEntries(Object.entries(override).filter(([, v]) => v !== null))
  }
  return out
}
