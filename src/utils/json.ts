export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

/** True when a JSON value is an object: not a list, and not null. */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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

/** A copy of a JSON value with `map` applied to every string in it: the
 *  string values at any depth, and the object keys. Two keys that get the
 *  same text become one field, with the value of the later key. */
export function mapJsonStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, map))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [map(key), mapJsonStrings(item, map)]))
}
