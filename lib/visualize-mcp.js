import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadImagine, SERVER_NAME, WIDGET_TOOL, README_TOOL } from './imagine.js'

export const SCRIPT_PATH = fileURLToPath(import.meta.url)
export const DEFAULT_PROTOCOL = '2025-06-18'
export const UNAVAILABLE = 'The Claude desktop app was not found on this Mac, so visualizations are unavailable. Answer in text instead.'

export function mcpConfig(nodeBin = process.execPath, script = SCRIPT_PATH) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: nodeBin, args: [script] } } })
}

export function runArgs(available, nodeBin, script) {
  return available ? ['--mcp-config', mcpConfig(nodeBin, script), '--allowedTools', `${README_TOOL} ${WIDGET_TOOL}`] : []
}

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

export function createHandler(getImagine) {
  return async function handle(message) {
    const { id, method, params } = message ?? {}
    const isRequest = id !== undefined && id !== null
    if (!isRequest) return null
    const imagine = getImagine()
    switch (method) {
      case 'initialize':
        return result(id, { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: { name: SERVER_NAME, version: '1.0.0' } })
      case 'ping':
        return result(id, {})
      case 'tools/list':
        return result(id, { tools: imagine?.tools ?? [] })
      case 'tools/call':
        if (!imagine) return result(id, { content: [{ type: 'text', text: UNAVAILABLE }], isError: true })
        try {
          return result(id, await imagine.call(params?.name, params?.arguments))
        } catch (error) {
          return result(id, { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true })
        }
      case 'resources/list':
        return result(id, { resources: imagine?.resources() ?? [] })
      case 'resources/read': {
        const read = imagine ? await imagine.read(params?.uri) : null
        return read?.contents ? result(id, { contents: read.contents }) : failure(id, -32002, 'Resource not found')
      }
      default:
        return failure(id, -32601, `Method not found: ${method}`)
    }
  }
}

export function serve({ input = process.stdin, output = process.stdout, getImagine } = {}) {
  let imagine
  const lazy = getImagine ?? (() => {
    if (imagine === undefined) {
      try {
        imagine = loadImagine()
      } catch {
        imagine = null
      }
    }
    return imagine
  })
  const handle = createHandler(lazy)
  const lines = createInterface({ input })
  lines.on('line', async (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return output.write(`${JSON.stringify(failure(null, -32700, 'Parse error'))}\n`)
    }
    const reply = await handle(message)
    if (reply) output.write(`${JSON.stringify(reply)}\n`)
  })
  return lines
}

if (process.argv[1] === SCRIPT_PATH) serve()
