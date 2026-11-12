import { normalizeOutputs } from '../modelOutputs'
import type { ModelCapabilityPath, ModelOutputsConfig, ProviderConfig, ProviderSettingDef } from './config'
import type { ModelCapabilities, ModelRequest } from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function modelData<T extends Record<string, unknown>>(data: unknown): T[] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    return []
  }

  return data.data.filter(isRecord) as T[]
}

// The value at a dot path in a `/models` entry, or undefined when the entry
// has none (JSON has no undefined values, so this never hides one). Only
// own properties are read, so a segment such as 'constructor' never
// reaches an inherited member.
export function valueAtPath(model: unknown, path: string): unknown {
  let value: unknown = model
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

// Reads a model capability from a `/models` entry, at a config dot path
// (`modelImageInput`, `modelToolCalling`, `modelThinking`, and
// `settings[].modelSupport` in config.ts): a boolean is the flag, and a list
// means true when it holds `listValue` (such as "image" in OpenRouter's
// `architecture.input_modalities`, or "tools" in its
// `supported_parameters`). No value at the path gives the config's
// `missing` flag. Anything else, or no config, is unknown.
export function modelCapability(model: Record<string, unknown>, capability: ModelCapabilityPath | undefined, listValue: string): boolean | undefined {
  if (capability === undefined) return undefined

  const value = valueAtPath(model, capability.path)
  if (value === undefined) return capability.missing
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.includes(listValue)
  return undefined
}

// The readable name of a `/models` entry's model, at the config's
// `modelReadableName` path: a string with text, trimmed. Anything else, or
// no config, is unknown.
export function modelReadableName(model: Record<string, unknown>, config: ProviderConfig['modelReadableName']): string | undefined {
  if (config === undefined) return undefined

  const value = valueAtPath(model, config.path)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** The form of a release date that Dez keeps (`ModelInfo.released`). */
export const RELEASED_DATE = /^\d{4}-\d{2}-\d{2}$/

// The first and the end of the release times that count: a date before
// 2000 is a placeholder (a list can give the epoch for an unknown date),
// and `toISOString` writes no `YYYY` after 9999.
const FIRST_RELEASE_MS = Date.UTC(2000, 0, 1)
const RELEASE_END_MS = Date.UTC(10000, 0, 1)

// An RFC 3339 date or date-time, in parts: the date, the time with no
// fraction, and the offset. A fraction of a second cannot change the date.
const RFC3339_TIME = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2}:\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2}))?$/

// The time of an RFC 3339 text, in ms; NaN for another value. RFC 3339
// allows forms that ECMAScript leaves to each engine (a lower-case `t` or
// `z`, a space, more than 3 digits of a fraction), so the parts go to
// `Date.parse` in the one form that it defines, and the webview and the
// tests agree.
function rfc3339Time(value: unknown): number {
  const match = typeof value === 'string' ? RFC3339_TIME.exec(value) : null
  if (!match) return NaN
  const [, date, time = '00:00:00', offset = 'Z'] = match
  return Date.parse(`${date}T${time}${offset.toUpperCase()}`)
}

// The release date of a `/models` entry's model, at the config's
// `modelReleased` path, as `YYYY-MM-DD` in UTC. A value that is not of the
// config's format, a time out of the range that counts, or no config is
// unknown.
export function modelReleased(model: Record<string, unknown>, config: ProviderConfig['modelReleased']): string | undefined {
  if (config === undefined) return undefined

  const value = valueAtPath(model, config.path)
  const ms = config.format === 'unixSeconds'
    ? (typeof value === 'number' ? value * 1000 : NaN)
    : rfc3339Time(value)
  // A NaN fails both compares.
  if (!(ms >= FIRST_RELEASE_MS && ms < RELEASE_END_MS)) return undefined
  return new Date(ms).toISOString().slice(0, 10)
}

// The keys of the config toggles (`settings`) that a `/models` entry says
// its model does not take: each toggle whose flag at its `modelSupport` is
// false. A list there holds the names of the request fields that the model
// takes (OpenRouter's `supported_parameters`), so it means "takes it" when
// it holds the first name of the toggle's `bodyPath`.
export function unsupportedSettings(model: Record<string, unknown>, settings: readonly ProviderSettingDef[] | undefined): string[] {
  return (settings ?? [])
    .filter((setting) => modelCapability(model, setting.modelSupport, setting.bodyPath.split('.')[0]) === false)
    .map((setting) => setting.key)
}

// A JSON null counts as no value.
function hasValueAtPath(model: Record<string, unknown>, path: string): boolean {
  const value = valueAtPath(model, path)
  return value !== undefined && value !== null
}

// The request kind that one type of `modelOutputs.values` gives an entry:
// the kind of the entry's value at the type's `requestBy.path` when
// `requestBy.values` names that value, else the type's `request`, else
// `none`. The keys of the table are JSON texts, so a boolean value of the
// entry counts as its text, `true` or `false`.
function typeRequest(model: Record<string, unknown>, { request, requestBy }: ModelOutputsConfig['values'][string]): ModelRequest {
  const value = requestBy === undefined ? undefined : valueAtPath(model, requestBy.path)
  const name = typeof value === 'boolean' ? String(value) : value
  // Object.hasOwn: as for the raw types below.
  if (requestBy === undefined || typeof name !== 'string' || !Object.hasOwn(requestBy.values, name)) return request ?? 'none'
  return requestBy.values[name]
}

// What a `/models` entry's model makes and how Dez sends it a request, from
// the raw types at the config's `modelOutputs.path` (a string, or a list of
// them, such as OpenRouter's `architecture.output_modalities`). Types that
// `values` does not name are skipped, as is a type whose `requiredPath` has
// no value in the entry (or null); with no known type, all stay unknown.
// The outputs are the union of the known types' outputs. The request kind is
// `chat` when one type gives it (`typeRequest`), so an image+text model
// stays a chat model; else the first other kind in list order; else `none`.
export function modelOutputsAndRequest(model: Record<string, unknown>, mapping: ModelOutputsConfig | undefined): Pick<ModelCapabilities, 'outputs' | 'request'> {
  if (mapping === undefined) return {}

  const value = valueAtPath(model, mapping.path)
  const types = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  // Object.hasOwn: a raw type such as 'constructor' must not read an
  // inherited member of the `values` object.
  const known = types
    .filter((type): type is string => typeof type === 'string' && Object.hasOwn(mapping.values, type))
    .map((type) => mapping.values[type])
    .filter((entry) => entry.requiredPath === undefined || hasValueAtPath(model, entry.requiredPath))
  if (known.length === 0) return {}

  const kinds = known.map((entry) => typeRequest(model, entry))
  return {
    outputs: normalizeOutputs(known.flatMap((entry) => entry.outputs)),
    request: kinds.includes('chat') ? 'chat' : kinds.find((kind) => kind !== 'none') ?? 'none',
  }
}
