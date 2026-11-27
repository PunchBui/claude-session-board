import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const SUPPORTED = [
  'GITLAB_HOST',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'FLOW_JQL',
  'PORT',
  'PROMPT_PERMISSION_MODE',
  'REVIEW_SLACK_CHANNEL',
  'REMOTE_HOSTS',
  'BOARD_TOKEN',
  'CLAUDE_APP_ASAR',
  'CLAUDE_BIN',
  'CLAUDE_HOME',
  'DATA_DIR',
  'SESSIONS_DIR',
  'PROJECTS_DIR',
  'PING_DUE_HOURS',
]

export function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readExisting(plistPath) {
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const env = JSON.parse(json).EnvironmentVariables
    return env && typeof env === 'object' ? env : {}
  } catch {
    return {}
  }
}

export function mergeEnv(existing, shellEnv, agentPath) {
  const merged = {}
  for (const [key, value] of Object.entries(existing)) {
    if (typeof value === 'string') merged[key] = value
  }
  for (const key of SUPPORTED) {
    if (shellEnv[key]) merged[key] = shellEnv[key]
  }
  merged.PATH = agentPath
  return merged
}

export function toXml(env) {
  return Object.keys(env)
    .sort()
    .map(key => `    <key>${escapeXml(key)}</key><string>${escapeXml(env[key])}</string>`)
    .join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [plistPath, agentPath] = process.argv.slice(2)
  process.stdout.write(toXml(mergeEnv(readExisting(plistPath), process.env, agentPath)) + '\n')
}
