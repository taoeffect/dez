import { checkArgumentValues, fitsParameterType, parameterTypeName, type ArgumentRules } from './arguments'
import { ToolError, type ArgumentsOf, type SubcommandArguments, type SubcommandParameter, type ToolArguments, type ToolArgumentValue, type ToolDefinition, type ToolParameter } from './types'

// A tool with subcommands (the `apps`, `audio`, `image`, and `video`
// tools): one short entry in the tools array, whose details the model asks
// for only when it needs them. A call has two flat arguments, as every tool
// parameter is a flat scalar (types.ts): `command`, the subcommand's name,
// and `parameters`, the subcommand's own parameters as the text of a JSON
// object. So a parameter of a subcommand can also be a list
// (`ToolListParameter`) or an object (`ToolObjectParameter`). A call with
// no arguments lists the subcommands; the built-in `help` subcommand, or a
// subcommand that needs parameters called with none, gives the details of
// one.
//
// `P` is the kind of parameter that the subcommands of a tool have. A tool
// with no list and no object parameter keeps the default, and its code
// gets flat arguments (`ArgumentsOf`).

/** One subcommand of a `SubcommandTool`. */
export interface Subcommand<P extends SubcommandParameter = ToolParameter> {
  name: string
  /** One sentence for the list of subcommands. */
  summary: string
  /** The details that its help gives: what it does and how to use it. */
  description: string
  /** Its parameters, as the `parameters` argument holds them. */
  parameters: readonly P[]
  /** The parameters of a good call, for the example call of its help and
   *  of the error texts. */
  example: Readonly<ArgumentsOf<P>>
}

/** A tool whose calls name one of its subcommands. Its description and
 *  its subcommands are static text (no running counts, no dates): the
 *  tools array is in the provider's prompt cache. */
export interface SubcommandTool<P extends SubcommandParameter = ToolParameter> {
  name: string
  /** What the tool is for, the start of its description. */
  summary: string
  /** The tool's own subcommands; `help` is built in and not one of them. */
  subcommands: readonly Subcommand<P>[]
}

/** What a call asks for: a text to give back (the list of subcommands or
 *  the help of one), or a subcommand to run with its checked arguments. */
export type SubcommandCall<P extends SubcommandParameter = ToolParameter> =
  | { kind: 'text'; text: string }
  | { kind: 'run'; name: string; arguments: ArgumentsOf<P> }

// A tool and a subcommand with any kind of parameter: what the texts and
// the checks of this module read. Every tool is one.
type AnyTool = SubcommandTool<SubcommandParameter>
type AnySubcommand = Subcommand<SubcommandParameter>

const HELP_NAME = 'help'

function helpSubcommand(tool: AnyTool): AnySubcommand {
  return {
    name: HELP_NAME,
    summary: 'Give the details of a subcommand: what it does, its parameters, and an example call.',
    description: 'Give the details of a subcommand.',
    parameters: [{ name: 'command', type: 'string', description: 'The name of the subcommand.', required: true }],
    example: { command: tool.subcommands[0]?.name ?? HELP_NAME },
  }
}

function allSubcommands(tool: AnyTool): AnySubcommand[] {
  return [...tool.subcommands, helpSubcommand(tool)]
}

// Whether a call of the subcommand must give a parameter. A call with none
// then asks for its help; a subcommand whose parameters are all optional
// runs.
function needsParameters(subcommand: AnySubcommand): boolean {
  return subcommand.parameters.some((parameter) => parameter.required)
}

/** The tool's definition for the tools array: a short description that
 *  tells how to list the subcommands and get the details of one, and the
 *  two flat arguments of every call. */
export function subcommandToolDefinition(tool: AnyTool): ToolDefinition {
  const first = tool.subcommands[0]?.name ?? HELP_NAME
  const names = allSubcommands(tool).map((subcommand) => subcommand.name)
  return {
    name: tool.name,
    description: `${tool.summary} It has subcommands (${names.join(', ')}). `
      + 'Call it with no arguments to list them with what each one does. '
      + detailsText(tool),
    parameters: [
      {
        name: 'command',
        type: 'string',
        description: `The name of the subcommand to run, as in "${first}". Leave it out to list the subcommands.`,
        required: false,
      },
      {
        name: 'parameters',
        type: 'string',
        description: 'The parameters of the subcommand, as the text of a JSON object. Leave it out to run a subcommand that needs none, or to get the details of one that needs some.',
        required: false,
      },
    ],
    misplacedParameter: (key, values) => misplacedParameterText(tool, key, values),
    subcommands: names,
  }
}

// The arguments of a call of `subcommand` with `parameters` (its example
// parameters with none), as one line of JSON.
function exampleCall(subcommand: AnySubcommand, parameters: Readonly<SubcommandArguments> = subcommand.example): string {
  return JSON.stringify({ command: subcommand.name, parameters: JSON.stringify(parameters) })
}

// Where `key` belongs when a call has it next to `command` and it is a
// parameter of a subcommand: a model that knows `timeout_seconds` from
// `model_invoke` writes it there, and the list of the tool's two
// parameters does not tell it the fix. The subcommand of the call comes
// first, else the first one that has the parameter. The example holds the
// call's own value when it is a number or true/false of the parameter's
// type; a text, a list, or an object can be long, and the example
// parameters show how one looks.
function misplacedParameterText(tool: AnyTool, key: string, values: Readonly<Record<string, unknown>>): string | null {
  const named = typeof values.command === 'string' ? values.command.trim() : ''
  const subcommands = [...tool.subcommands].sort((a, b) => Number(b.name === named) - Number(a.name === named))
  for (const subcommand of subcommands) {
    const parameter = subcommand.parameters.find((candidate) => candidate.name === key)
    if (!parameter) continue
    const given = values[key]
    const isShortValue = parameter.type !== 'list' && parameter.type !== 'object' && typeof given !== 'string' && fitsParameterType(parameter.type, given)
    const example = isShortValue ? { ...subcommand.example, [key]: given } : subcommand.example
    return `${JSON.stringify(key)} is a parameter of the subcommand ${subcommand.name}, so it goes inside "parameters", `
      + `the text of a JSON object, and not next to "command", as in ${exampleCall(subcommand, example)}.`
  }
  return null
}

// How to get the details of a subcommand, for the tool's description and
// the list. A subcommand that needs no parameters runs when a call gives
// none, so only `help` gives the details of every subcommand; the shortcut
// call is told only with a subcommand that needs parameters.
function detailsText(tool: AnyTool): string {
  const withRequiredParameters = tool.subcommands.find(needsParameters)
  const shortcut = withRequiredParameters
    ? `, or call a subcommand that needs parameters with none, as in ${JSON.stringify({ command: withRequiredParameters.name })}`
    : ''
  return `To get the details of a subcommand (what it does, its parameters, and an example call), call ${HELP_NAME} with its name, `
    + `as in ${exampleCall(helpSubcommand(tool))}${shortcut}.`
}

function listText(tool: AnyTool): string {
  const subcommands = allSubcommands(tool)
  const first = subcommands[0]
  return [
    `The subcommands of the ${tool.name} tool:`,
    ...subcommands.map((subcommand) => `- ${subcommand.name}: ${subcommand.summary}`),
    `${detailsText(tool)} To run a subcommand, give its parameters as the text of a JSON object, as in ${exampleCall(first)}.`,
  ].join('\n')
}

// The line of a parameter in the help of its subcommand. A list of objects
// has one more line for each field of an item, under it.
function parameterLines(parameter: SubcommandParameter): string[] {
  const line = (indent: string, { name, required, description }: SubcommandParameter, type: string) =>
    `${indent}- ${name} (${type}, ${required ? 'required' : 'optional'}): ${description}`
  const own = line('', parameter, parameterTypeName(parameter))
  if (parameter.type !== 'list' || typeof parameter.items === 'string') return [own]
  return [`${own} The fields of an item:`, ...parameter.items.map((field) => line('  ', field, field.type))]
}

// The details of a subcommand. Those of `help` are the list, which tells
// how to use it. An empty line ends the description: a description can end
// in a list (the hint of `apps edit`), and the parameter list must not read
// as more of that list.
function helpText(tool: AnyTool, subcommand: AnySubcommand): string {
  if (subcommand.name === HELP_NAME) return listText(tool)
  const parameters = subcommand.parameters.length === 0
    ? ['It has no parameters.']
    : ['Its parameters, in the text of a JSON object in "parameters":', ...subcommand.parameters.flatMap(parameterLines)]
  return [
    `The subcommand ${subcommand.name} of the ${tool.name} tool: ${subcommand.description}`,
    '',
    ...parameters,
    `Example call: ${exampleCall(subcommand)}`,
  ].join('\n')
}

// The object that the `parameters` text of a call holds; `{}` when the call
// has none (absent or blank text).
function givenParameters(tool: AnyTool, subcommand: AnySubcommand, text: ToolArgumentValue | undefined): Record<string, unknown> {
  if (typeof text !== 'string' || text.trim() === '') return {}
  let given: unknown
  try {
    given = JSON.parse(text)
  } catch {
    given = undefined
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ToolError(`"parameters" is not the text of a JSON object. Give the parameters of ${tool.name} ${subcommand.name} as the text of one JSON object, `
      + `as in ${exampleCall(subcommand)}.`)
  }
  return given as Record<string, unknown>
}

function findSubcommand(tool: AnyTool, name: string): AnySubcommand {
  const subcommand = allSubcommands(tool).find((candidate) => candidate.name === name)
  if (!subcommand) throw new ToolError(`The ${tool.name} tool has no subcommand ${JSON.stringify(name)}. ${listText(tool)}`)
  return subcommand
}

// `parseSubcommandCall` for a tool with any kind of parameter.
function parsedCall(tool: AnyTool, args: ToolArguments): SubcommandCall<SubcommandParameter> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command === '') {
    if (typeof args.parameters === 'string' && args.parameters.trim() !== '') {
      throw new ToolError(`The call gives "parameters" but no "command". Give the name of the subcommand in "command". ${listText(tool)}`)
    }
    return { kind: 'text', text: listText(tool) }
  }
  const subcommand = findSubcommand(tool, command)
  const given = givenParameters(tool, subcommand, args.parameters)
  if (needsParameters(subcommand) && Object.keys(given).length === 0) return { kind: 'text', text: helpText(tool, subcommand) }

  const rules: ArgumentRules<SubcommandParameter> = { name: `${tool.name} ${subcommand.name}`, parameters: subcommand.parameters }
  const checked = checkArgumentValues(rules, given)
  if (!checked.ok) {
    throw new ToolError(`${checked.error} The parameters go in "parameters" as the text of a JSON object, as in ${exampleCall(subcommand)}.`)
  }
  if (subcommand.name !== HELP_NAME) return { kind: 'run', name: subcommand.name, arguments: checked.arguments }
  return { kind: 'text', text: helpText(tool, findSubcommand(tool, String(checked.arguments.command).trim())) }
}

/** What a call of a subcommand tool asks for, from its checked arguments
 *  (`command` and `parameters`, as `subcommandToolDefinition` gives them).
 *
 *  No arguments give the list of subcommands. A subcommand that has a
 *  required parameter, called with none, gives its help; so does `help`
 *  with the name of a subcommand, and the help of `help` is the list. A
 *  subcommand whose parameters are all optional runs when the call gives
 *  none. Throws a `ToolError` that tells how to fix the call for
 *  `parameters` with no `command`, an unknown subcommand, `parameters`
 *  that are not the text of a JSON object, and parameters that the
 *  subcommand does not take (`checkArgumentValues`, under the name `<tool>
 *  <subcommand>`). */
export function parseSubcommandCall<P extends SubcommandParameter = ToolParameter>(tool: SubcommandTool<P>, args: ToolArguments): SubcommandCall<P> {
  // The arguments of a run hold a list only for a list parameter, which
  // only a tool of the wide kind has (`ArgumentsOf`).
  return parsedCall(tool, args) as SubcommandCall<P>
}
