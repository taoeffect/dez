import type { JsonObject } from '../../utils/json'
import { CROP_SCALE_IMAGE_TOOL } from './cropScaleImage'
import { MODEL_INFO_TOOL } from './modelInfo'
import { MODEL_LIST_TOOL } from './modelList'
import type { ToolArguments, ToolArgumentValue, ToolDefinition, ToolParameter, ToolParameterType } from './types'

/** Every Dez tool, in the order that requests list them. A new tool goes
 *  at the end: the tools before it then keep their bytes in the tools
 *  array (the provider's prompt cache). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [MODEL_LIST_TOOL, MODEL_INFO_TOOL, CROP_SCALE_IMAGE_TOOL]

/** The Dez tool with this name; undefined when no Dez tool has it. */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

/** The error result of a call to a tool that Dez does not have. */
export function unknownToolText(name: string): string {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name).join(', ')
  return `Dez has no tool named ${JSON.stringify(name)}. Call only the Dez tools, by their exact names: ${names}.`
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

// `number` needs a finite value: `JSON.parse('1e999')` gives `Infinity`, and
// `JSON.stringify` writes it as `null`, so a block would read back another
// value. `Number.isInteger` already refuses it. `example` is a value of the
// type, as JSON, for the error texts.
const TYPE_RULES: Record<ToolParameterType, { matches: (value: unknown) => value is ToolArgumentValue; text: string; example: string }> = {
  string: { matches: (value): value is string => typeof value === 'string', text: 'a string', example: '"..."' },
  number: { matches: (value): value is number => Number.isFinite(value), text: 'a number', example: '1.5' },
  integer: { matches: (value): value is number => Number.isInteger(value), text: 'an integer', example: '1' },
  boolean: { matches: (value): value is boolean => typeof value === 'boolean', text: 'true or false', example: 'true' },
}

/** True when a JSON value is of a parameter's type, with no coercion. */
export function fitsParameterType(type: ToolParameterType, value: unknown): value is ToolArgumentValue {
  return TYPE_RULES[type].matches(value)
}

export type ToolArgumentsParse =
  | { ok: true; arguments: ToolArguments }
  | { ok: false; error: string }

// Arguments that hold `parameters`, each with an example value of its type,
// as one line of JSON.
function exampleArguments(parameters: readonly ToolParameter[]): string {
  return `{${parameters.map((parameter) => `${JSON.stringify(parameter.name)}: ${TYPE_RULES[parameter.type].example}`).join(', ')}}`
}

// What a tool takes: its parameters with their JSON types (`limit
// (integer)`), or an empty object for a tool with none.
function parametersText(definition: ToolDefinition): string {
  if (definition.parameters.length === 0) return `${definition.name} has no parameters: send {} as the arguments.`
  const list = definition.parameters.map((parameter) => `${parameter.name} (${parameter.type}${parameter.required ? ', required' : ''})`).join(', ')
  return `The parameters of ${definition.name} are: ${list}.`
}

// The form of a good call, for arguments that are not one JSON object: an
// example with the required parameters (else the first one), and the list
// of all of them.
function argumentsFormText(definition: ToolDefinition): string {
  const { parameters } = definition
  if (parameters.length === 0) return parametersText(definition)
  const required = parameters.filter((parameter) => parameter.required)
  return `Send one JSON object, as in ${exampleArguments(required.length > 0 ? required : parameters.slice(0, 1))}. ${parametersText(definition)}`
}

/** Checks the arguments JSON text of a call from the model against the
 *  tool's definition. The result has the parameters in definition order.
 *
 *  Invalid JSON, a value that is not an object, an unknown key, a value of
 *  the wrong type, and a missing required parameter are errors; `error` is
 *  then the text for the model to read: what is wrong, and the form of a
 *  good call (the parameter names and types, or an example). A `null` value
 *  counts as absent, and blank text as `{}`: some servers send no text for
 *  a call with no arguments. */
export function parseToolArguments(definition: ToolDefinition, json: string): ToolArgumentsParse {
  let given: unknown = {}
  if (json.trim() !== '') {
    try {
      given = JSON.parse(json)
    } catch {
      return { ok: false, error: `The arguments are not valid JSON. ${argumentsFormText(definition)}` }
    }
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, error: `The arguments are not a JSON object. ${argumentsFormText(definition)}` }
  }

  const unknownKey = Object.keys(given).find((key) => !definition.parameters.some((parameter) => parameter.name === key))
  if (unknownKey !== undefined) {
    return { ok: false, error: `${definition.name} has no parameter ${JSON.stringify(unknownKey)}. ${parametersText(definition)}` }
  }

  const values = given as Record<string, unknown>
  const parsed: ToolArguments = {}
  for (const parameter of definition.parameters) {
    // Own keys only: a parameter such as `constructor` must not read
    // `Object.prototype`.
    const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : null
    const rule = TYPE_RULES[parameter.type]
    if (value === null) {
      if (parameter.required) {
        return { ok: false, error: `The required parameter "${parameter.name}" is missing. Add it as ${rule.text}, as in ${exampleArguments([parameter])}.` }
      }
      continue
    }
    if (!rule.matches(value)) return { ok: false, error: `The parameter "${parameter.name}" must be ${rule.text}, as in ${exampleArguments([parameter])}.` }
    parsed[parameter.name] = value
  }
  return { ok: true, arguments: parsed }
}
