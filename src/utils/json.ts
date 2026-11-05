export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (value !== null && typeof value === 'object') return cloneJsonObject(value)
  return value
}

// `Object.fromEntries` defines a `__proto__` key as an own property. A plain
// `copy[key] = value` would set the copy's prototype instead.
export function cloneJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]))
}
