const FRESH_COMMAND = /^\/(?:clear|reset|new)(?=\s|$)\s*([\s\S]*)$/i
const SIDE_COMMAND = /^\/(?:btw|side)(?=\s|$)\s*([\s\S]*)$/i

export const freshCommand = (typed) => FRESH_COMMAND.exec(typed)?.[1] ?? null
export const sideCommand = (typed) => SIDE_COMMAND.exec(typed)?.[1].trim() ?? null
