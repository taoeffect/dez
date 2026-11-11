import { normalizeOutputs } from '../modelOutputs'
import type { ModelCapabilityPath, ModelOutputsConfig, ProviderSettingDef } from './config'
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

// What one type of `modelOutputs.values` gives an entry. The request kind:
// the kind of the entry's value at the type's `requestBy.path` when
// `requestBy.values` names that value, else the type's `request`, else
// `none`. The clip input, in the same way: the kind that
// `requestBy.clipInputs` names for that value, else the type's `clipInput`.
// The keys of both tables are JSON texts, so a boolean value of the entry
// counts as its text, `true` or `false`.
function typeRequest(model: Record<string, unknown>, { request, clipInput, requestBy }: ModelOutputsConfig['values'][string]): Pick<ModelCapabilities, 'clipInput'> & { request: ModelRequest } {
  const value = requestBy === undefined ? undefined : valueAtPath(model, requestBy.path)
  const name = typeof value === 'boolean' ? String(value) : value
  if (requestBy === undefined || typeof name !== 'string') return { request: request ?? 'none', clipInput }
  // Object.hasOwn: as for the raw types below.
  return {
    request: Object.hasOwn(requestBy.values, name) ? requestBy.values[name] : request ?? 'none',
    clipInput: requestBy.clipInputs !== undefined && Object.hasOwn(requestBy.clipInputs, name) ? requestBy.clipInputs[name] : clipInput,
  }
}

// What a `/models` entry's model makes and how Dez sends it a request, from
// the raw types at the config's `modelOutputs.path` (a string, or a list of
// them, such as OpenRouter's `architecture.output_modalities`). Types that
// `values` does not name are skipped, as is a type whose `requiredPath` has
// no value in the entry (or null); with no known type, all stay unknown.
// The outputs are the union of the known types' outputs. The request kind is
// `chat` when one type gives it (`typeRequest`), so an image+text model
// stays a chat model; else the first other kind in list order; else `none`.
// A `none` model gets the clip input of its first type that has one.
export function modelOutputsAndRequest(model: Record<string, unknown>, mapping: ModelOutputsConfig | undefined): Pick<ModelCapabilities, 'outputs' | 'request' | 'clipInput'> {
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

  const requests = known.map((entry) => typeRequest(model, entry))
  const kinds = requests.map((entry) => entry.request)
  const request = kinds.includes('chat') ? 'chat' : kinds.find((kind) => kind !== 'none') ?? 'none'
  const clipInput = request === 'none' ? requests.find((entry) => entry.clipInput !== undefined)?.clipInput : undefined
  return {
    outputs: normalizeOutputs(known.flatMap((entry) => entry.outputs)),
    request,
    ...(clipInput !== undefined && { clipInput }),
  }
}
