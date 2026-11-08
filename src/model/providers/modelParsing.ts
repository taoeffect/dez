export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function modelData<T extends Record<string, unknown>>(data: unknown): T[] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    return []
  }

  return data.data.filter(isRecord) as T[]
}

// Reads whether a `/models` entry's model reads images, at the config's dot
// path (`modelImageInput.path` in config.ts): a boolean is the flag, and a
// list means true when it holds "image". Anything else is unknown. Only own
// properties are read, so a segment such as 'constructor' never reaches an
// inherited member.
export function modelImageInput(model: Record<string, unknown>, path: string): boolean | undefined {
  let value: unknown = model
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }

  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.includes('image')
  return undefined
}
