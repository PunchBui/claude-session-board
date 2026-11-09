import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// What `claude` uses for model and effort when a flag is not given: the first of these that
// sets them wins (project local, project, user local, user). Anything unset is null, meaning
// the account's own default, which the board cannot know.
export async function readNewSessionDefaults({ home, folder, permissionMode, read = (file) => readFile(file, 'utf8') }) {
  const files = [
    ...(folder ? [join(folder, '.claude/settings.local.json'), join(folder, '.claude/settings.json')] : []),
    join(home, '.claude/settings.local.json'),
    join(home, '.claude/settings.json'),
  ]
  const found = { model: null, effort: null }
  for (const file of files) {
    let settings
    try {
      settings = JSON.parse(await read(file))
    } catch {
      continue
    }
    if (found.model === null && typeof settings?.model === 'string' && settings.model) found.model = settings.model
    if (found.effort === null && typeof settings?.effortLevel === 'string' && settings.effortLevel) found.effort = settings.effortLevel
  }
  return { ...found, permissionMode }
}
