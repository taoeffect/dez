import type { JsonObject } from '../../utils/json'
import { MODEL_LIST_TOOL } from './modelList'
import type { ToolArguments, ToolArgumentValue, ToolDefinition, ToolParameterType } from './types'

/** Every Dez tool, in the order that requests list them. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [MODEL_LIST_TOOL]

/** The Dez tool with this name; undefined when no Dez tool has it. */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

/** The JSON schema of a tool's arguments: the OpenAI-format `parameters` and
 *  the Anthropic-format `input_schema`. It comes from the static definition
 *  with a fixed key order, so the tools array is the same bytes in every
 *  request and stays in the provider's prompt cache.
 *
 *  `required` is left out when it would be empty (older JSON Schema drafts
 *  need at least one item). `additionalProperties: false` is left out too:
 *  some servers that translate schemas for other model families refuse it,
 *  and `parseToolArguments` refuses unknown keys anyway. */
export function toolJsonSchema(definition: ToolDefinition): JsonObject {
  const properties = Object.fromEntries(definition.parameters.map((parameter) => [
    parameter.name,
    { type: parameter.type, description: parameter.description },
  ]))
  const required = definition.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name)
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

const TYPE_RULES: Record<ToolParameterType, { matches: (value: unknown) => value is ToolArgumentValue; text: string }> = {
  string: { matches: (value): value is string => typeof value === 'string', text: 'a string' },
  number: { matches: (value): value is number => typeof value === 'number', text: 'a number' },
  integer: { matches: (value): value is number => Number.isInteger(value), text: 'an integer' },
  boolean: { matches: (value): value is boolean => typeof value === 'boolean', text: 'true or false' },
}

export type ToolArgumentsParse =
  | { ok: true; arguments: ToolArguments }
  | { ok: false; error: string }

/** Checks the arguments JSON text of a call from the model against the
 *  tool's definition. The result has the parameters in definition order.
 *
 *  Invalid JSON, a value that is not an object, an unknown key, a value of
 *  the wrong type, and a missing required parameter are errors; `error` is
 *  then a short reason with no final period, for the model to read. A
 *  `null` value counts as absent, and blank text as `{}`: some servers send
 *  no text for a call with no arguments. */
export function parseToolArguments(definition: ToolDefinition, json: string): ToolArgumentsParse {
  let given: unknown = {}
  if (json.trim() !== '') {
    try {
      given = JSON.parse(json)
    } catch {
      return { ok: false, error: 'not valid JSON' }
    }
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, error: 'not a JSON object' }
  }

  const unknownKey = Object.keys(given).find((key) => !definition.parameters.some((parameter) => parameter.name === key))
  if (unknownKey !== undefined) return { ok: false, error: `unknown parameter ${JSON.stringify(unknownKey)}` }

  const values = given as Record<string, unknown>
  const parsed: ToolArguments = {}
  for (const parameter of definition.parameters) {
    // Own keys only: a parameter such as `constructor` must not read
    // `Object.prototype`.
    const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : null
    if (value === null) {
      if (parameter.required) return { ok: false, error: `missing required parameter "${parameter.name}"` }
      continue
    }
    const rule = TYPE_RULES[parameter.type]
    if (!rule.matches(value)) return { ok: false, error: `"${parameter.name}" must be ${rule.text}` }
    parsed[parameter.name] = value
  }
  return { ok: true, arguments: parsed }
}
