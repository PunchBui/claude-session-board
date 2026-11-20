export const MAX_BODY_BYTES = 256_000

export class BodyTooLargeError extends Error {
  constructor(limit = MAX_BODY_BYTES) {
    super(`The request is larger than ${Math.round(limit / 1000)} KB.`)
    this.name = 'BodyTooLargeError'
  }
}

export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (Number(req.headers?.['content-length'] ?? 0) > maxBytes) throw new BodyTooLargeError(maxBytes)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
