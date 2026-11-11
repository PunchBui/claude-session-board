import { validModel, validEffort } from './boardsessions.js'

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
