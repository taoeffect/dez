import { IMAGE_ID_SOURCE } from '../chat/images'
import { ToolError, type MisplacedParameterText, type ToolArguments, type ToolArgumentValue, type ToolParameter, type ToolParameterType } from './types'

// The checks of the arguments of a call against the parameters of a tool
// (or of a subcommand, subcommands.ts), with error texts that tell the
// model how to fix the call.

/** What a call's arguments are checked against: the tool's name, for the
 *  error texts, and its parameters. A `ToolDefinition` is one. */
export interface ArgumentRules {
  name: string
  parameters: readonly ToolParameter[]
  /** What the error of a key that is no parameter tells when the tool
   *  knows where the key belongs; else the error lists the parameters. */
  misplacedParameter?: MisplacedParameterText
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
function parametersText(rules: ArgumentRules): string {
  if (rules.parameters.length === 0) return `${rules.name} has no parameters: send {} as the arguments.`
  const list = rules.parameters.map((parameter) => `${parameter.name} (${parameter.type}${parameter.required ? ', required' : ''})`).join(', ')
  return `The parameters of ${rules.name} are: ${list}.`
}

// The form of a good call, for arguments that are not one JSON object: an
// example with the required parameters (else the first one), and the list
// of all of them.
function argumentsFormText(rules: ArgumentRules): string {
  const { parameters } = rules
  if (parameters.length === 0) return parametersText(rules)
  const required = parameters.filter((parameter) => parameter.required)
  return `Send one JSON object, as in ${exampleArguments(required.length > 0 ? required : parameters.slice(0, 1))}. ${parametersText(rules)}`
}

/** Checks the arguments JSON text of a call from the model against the
 *  tool's parameters (`checkArgumentValues`). Invalid JSON and a value that
 *  is not an object are errors too; `error` then also tells the form of a
 *  good call (an example and the parameter names and types). Blank text
 *  reads as `{}`: some servers send no text for a call with no arguments. */
export function parseToolArguments(rules: ArgumentRules, json: string): ToolArgumentsParse {
  let given: unknown = {}
  if (json.trim() !== '') {
    try {
      given = JSON.parse(json)
    } catch {
      return { ok: false, error: `The arguments are not valid JSON. ${argumentsFormText(rules)}` }
    }
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, error: `The arguments are not a JSON object. ${argumentsFormText(rules)}` }
  }
  return checkArgumentValues(rules, given as Record<string, unknown>)
}

/** Checks the values of a call's arguments, one JSON object, against the
 *  parameters. The result has the parameters in definition order.
 *
 *  An unknown key, a value of the wrong type, and a missing required
 *  parameter are errors; `error` is then the text for the model to read:
 *  what is wrong, and how a good value looks (the parameter names and
 *  types, where the key belongs (`ArgumentRules.misplacedParameter`), or
 *  an example). A `null` value counts as absent. */
export function checkArgumentValues(rules: ArgumentRules, values: Record<string, unknown>): ToolArgumentsParse {
  const unknownKey = Object.keys(values).find((key) => !rules.parameters.some((parameter) => parameter.name === key))
  if (unknownKey !== undefined) {
    const fix = rules.misplacedParameter?.(unknownKey, values) ?? parametersText(rules)
    return { ok: false, error: `${rules.name} has no parameter ${JSON.stringify(unknownKey)}. ${fix}` }
  }

  const parsed: ToolArguments = {}
  for (const parameter of rules.parameters) {
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

const ASSET_ID_ARGUMENT = new RegExp(`^@?(${IMAGE_ID_SOURCE})$`)

/** The id of the image or the clip that an argument names (`a` or `@a`).
 *  Throws a ToolError for any other value; the model reads the error.
 *  `asset` is the kind of asset with its article (`an image`, `a clip`),
 *  and `example` is an id, for the error text. */
export function assetIdArgument(value: ToolArgumentValue | undefined, asset: string, example: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const id = ASSET_ID_ARGUMENT.exec(text)?.[1]
  if (id === undefined) {
    const sentenceStart = asset.charAt(0).toUpperCase() + asset.slice(1)
    throw new ToolError(`${JSON.stringify(text)} is not ${asset} id. ${sentenceStart} id is lower-case letters, as in "${example}" or "@${example}".`)
  }
  return id
}

/** The words of the text argument `parameter` of a call, separated by
 *  white space or commas, in the order of the call: none for an absent
 *  value or a value that is no text. */
export function argumentWords(args: ToolArguments, parameter: string): string[] {
  const value = args[parameter]
  return (typeof value === 'string' ? value : '').split(/[\s,]+/).filter((word) => word !== '')
}

/** The ids of the images and the clips that the text argument `parameter`
 *  of a call names (`a` or `@a`), its words (`argumentWords`) in the order
 *  of the call; an id can be there twice. Throws a ToolError for a
 *  word that is no id. `asset` is the kind of asset with its article (`a
 *  clip`), and `advice` ends the error text: the form of a good argument,
 *  and what Dez did not do. */
export function assetIdWords(args: ToolArguments, parameter: string, asset: string, advice: string): string[] {
  return argumentWords(args, parameter).map((word) => {
    const id = ASSET_ID_ARGUMENT.exec(word)?.[1]
    if (id === undefined) throw new ToolError(`\`${parameter}\` holds ${JSON.stringify(word)}, which is no id of ${asset}. ${advice}`)
    return id
  })
}

/** The ids that the `assets` argument of a call names (`assetIdWords`),
 *  each one once, in the order of the call. Throws a `ToolError` that ends
 *  with `notDone` for a word that is no id, for no id, and for more than
 *  `max` ids. */
export function assetIdsArgument(args: ToolArguments, { max, notDone }: { max: number, notDone: string }): string[] {
  const form = 'Give the ids of the images and the clips, as in "@a @c".'
  const ids = new Set(assetIdWords(args, 'assets', 'an image or a clip', `${form} ${notDone}`))
  if (ids.size === 0) throw new ToolError(`\`assets\` names no image and no clip. ${form} ${notDone}`)
  if (ids.size > max) {
    throw new ToolError(`\`assets\` names ${ids.size} images and clips, and one call takes at most ${max}. `
      + `Call again with the first ${max}, then again with the rest. ${notDone}`)
  }
  return [...ids]
}

/** The error of a call that gives `parameter` the values `values`, which it
 *  does not take; `valid` tells what it takes. */
export function unknownValuesText(parameter: string, values: readonly string[], valid: string): string {
  const quoted = values.map((value) => JSON.stringify(value)).join(', ')
  return `Unknown value${values.length === 1 ? '' : 's'} ${quoted} in \`${parameter}\`. Use ${valid}.`
}
