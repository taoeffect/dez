export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function modelData<T extends Record<string, unknown>>(data: unknown): T[] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    return []
  }

  return data.data.filter(isRecord) as T[]
}

// Reads a model capability from a `/models` entry, at a config dot path
// (`modelImageInput.path`, `modelToolCalling.path` in config.ts): a boolean
// is the flag, and a list means true when it holds `listValue` (such as
// "image" in OpenRouter's `architecture.input_modalities`, or "tools" in its
// `supported_parameters`). Anything else, or no path, is unknown. Only own
// properties are read, so a segment such as 'constructor' never reaches an
// inherited member.
export function modelCapability(model: Record<string, unknown>, path: string | undefined, listValue: string): boolean | undefined {
  if (path === undefined) return undefined

  let value: unknown = model
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }

  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.includes(listValue)
  return undefined
}
