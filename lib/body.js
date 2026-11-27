export const MAX_BODY_BYTES = 256_000

export class BodyTooLargeError extends Error {
  constructor(limit = MAX_BODY_BYTES) {
    super(`The request is larger than ${Math.round(limit / 1000)} KB.`)
    this.name = 'BodyTooLargeError'
  }
}

export class BadBodyError extends Error {
  constructor(cause) {
    super('The request body must be a JSON object.')
    this.name = 'BadBodyError'
    this.cause = cause
  }
}

export async function readBytes(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (Number(req.headers?.['content-length'] ?? 0) > maxBytes) throw new BodyTooLargeError(maxBytes)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const text = (await readBytes(req, { maxBytes })).toString('utf8') || '{}'
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BadBodyError(error)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadBodyError(new Error('body is not an object'))
  return parsed
}
