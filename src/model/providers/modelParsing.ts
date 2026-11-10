import { normalizeOutputs } from '../modelOutputs'
import type { ModelCapabilityPath, ModelOutputsConfig } from './config'
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

// The value at a config dot path in a `/models` entry, or undefined when the
// entry has none (JSON has no undefined values, so this never hides one).
// Only own properties are read, so a segment such as 'constructor' never
// reaches an inherited member.
function valueAtPath(model: Record<string, unknown>, path: string): unknown {
  let value: unknown = model
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

// Reads a model capability from a `/models` entry, at a config dot path
// (`modelImageInput`, `modelToolCalling` in config.ts): a boolean is the
// flag, and a list means true when it holds `listValue` (such as "image" in
// OpenRouter's `architecture.input_modalities`, or "tools" in its
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

// A JSON null counts as no value.
function hasValueAtPath(model: Record<string, unknown>, path: string): boolean {
  const value = valueAtPath(model, path)
  return value !== undefined && value !== null
}

// What a `/models` entry's model makes and how Dez sends it a request, from
// the raw types at the config's `modelOutputs.path` (a string, or a list of
// them, such as OpenRouter's `architecture.output_modalities`). Types that
// `values` does not name are skipped, as is a type whose `requiredPath` has
// no value in the entry (or null); with no known type, both stay unknown.
// The outputs are the union of the known types' outputs. The request kind is
// `chat` when one type gives it, so an image+text model stays a chat model;
// else the first other kind in list order; else `none`, the kind of a type
// with no `request`.
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

  const requests: ModelRequest[] = known.map((entry) => entry.request ?? 'none')
  return {
    outputs: normalizeOutputs(known.flatMap((entry) => entry.outputs)),
    request: requests.includes('chat') ? 'chat' : requests.find((kind) => kind !== 'none') ?? 'none',
  }
}
