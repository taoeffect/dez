import { checkArgumentValues, type ArgumentRules } from './arguments'
import { ToolError, type ToolArguments, type ToolArgumentValue, type ToolDefinition, type ToolParameter } from './types'

// A tool with subcommands (the `audio` tool; later the `image` tool): one
// short entry in the tools array, whose details the model asks for only
// when it needs them. A call has two flat arguments, as every tool
// parameter is a flat scalar (types.ts): `command`, the subcommand's name,
// and `parameters`, the subcommand's own parameters as the text of a JSON
// object. A call with no arguments lists the subcommands; the built-in
// `help` subcommand, or a subcommand called with no parameters, gives the
// details of one.

/** One subcommand of a `SubcommandTool`. */
export interface Subcommand {
  name: string
  /** One sentence for the list of subcommands. */
  summary: string
  /** The details that its help gives: what it does and how to use it. */
  description: string
  /** Its parameters, as the `parameters` argument holds them. */
  parameters: readonly ToolParameter[]
  /** The parameters of a good call, for the example call of its help and
   *  of the error texts. */
  example: Readonly<Record<string, ToolArgumentValue>>
}

/** A tool whose calls name one of its subcommands. Its description and
 *  its subcommands are static text (no counts, no dates): the tools array
 *  is in the provider's prompt cache. */
export interface SubcommandTool {
  name: string
  /** What the tool is for, the start of its description. */
  summary: string
  /** The tool's own subcommands; `help` is built in and not one of them. */
  subcommands: readonly Subcommand[]
}

/** What a call asks for: a text to give back (the list of subcommands or
 *  the help of one), or a subcommand to run with its checked arguments. */
export type SubcommandCall =
  | { kind: 'text'; text: string }
  | { kind: 'run'; name: string; arguments: ToolArguments }

const HELP_NAME = 'help'

function helpSubcommand(tool: SubcommandTool): Subcommand {
  return {
    name: HELP_NAME,
    summary: 'Give the details of a subcommand: what it does, its parameters, and an example call.',
    description: 'Give the details of a subcommand.',
    parameters: [{ name: 'command', type: 'string', description: 'The name of the subcommand.', required: true }],
    example: { command: tool.subcommands[0]?.name ?? HELP_NAME },
  }
}

function allSubcommands(tool: SubcommandTool): Subcommand[] {
  return [...tool.subcommands, helpSubcommand(tool)]
}

/** The tool's definition for the tools array: a short description that
 *  tells how to list the subcommands and get the details of one, and the
 *  two flat arguments of every call. */
export function subcommandToolDefinition(tool: SubcommandTool): ToolDefinition {
  const first = tool.subcommands[0]?.name ?? HELP_NAME
  const names = allSubcommands(tool).map((subcommand) => subcommand.name).join(', ')
  return {
    name: tool.name,
    description: `${tool.summary} It has subcommands (${names}). `
      + 'Call it with no arguments to list them with what each one does. '
      + `Call a subcommand with no parameters, as in {"command": "${first}"}, to get its details: what it does, its parameters, and an example call.`,
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
        description: 'The parameters of the subcommand, as the text of a JSON object. Leave it out to get the details of the subcommand.',
        required: false,
      },
    ],
  }
}

// The arguments of a call of `subcommand` with its example parameters, as
// one line of JSON.
function exampleCall(subcommand: Subcommand): string {
  return JSON.stringify({ command: subcommand.name, parameters: JSON.stringify(subcommand.example) })
}

function listText(tool: SubcommandTool): string {
  const subcommands = allSubcommands(tool)
  const first = subcommands[0]
  return [
    `The subcommands of the ${tool.name} tool:`,
    ...subcommands.map((subcommand) => `- ${subcommand.name}: ${subcommand.summary}`),
    `To get the details of a subcommand, call it with no parameters, as in ${JSON.stringify({ command: first.name })}. `
      + `To run it, give its parameters as the text of a JSON object, as in ${exampleCall(first)}.`,
  ].join('\n')
}

// The details of a subcommand. Those of `help` are the list, which tells
// how to use it.
function helpText(tool: SubcommandTool, subcommand: Subcommand): string {
  if (subcommand.name === HELP_NAME) return listText(tool)
  const parameters = subcommand.parameters.length === 0
    ? ['It has no parameters.']
    : [
        'Its parameters, in the text of a JSON object in "parameters":',
        ...subcommand.parameters.map((parameter) => `- ${parameter.name} (${parameter.type}, ${parameter.required ? 'required' : 'optional'}): ${parameter.description}`),
      ]
  return [
    `The subcommand ${subcommand.name} of the ${tool.name} tool: ${subcommand.description}`,
    ...parameters,
    `Example call: ${exampleCall(subcommand)}`,
  ].join('\n')
}

// The object that the `parameters` text of a call holds; `{}` when the call
// has none (absent or blank text).
function givenParameters(tool: SubcommandTool, subcommand: Subcommand, text: ToolArgumentValue | undefined): Record<string, unknown> {
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

function findSubcommand(tool: SubcommandTool, name: string): Subcommand {
  const subcommand = allSubcommands(tool).find((candidate) => candidate.name === name)
  if (!subcommand) throw new ToolError(`The ${tool.name} tool has no subcommand ${JSON.stringify(name)}. ${listText(tool)}`)
  return subcommand
}

/** What a call of a subcommand tool asks for, from its checked arguments
 *  (`command` and `parameters`, as `subcommandToolDefinition` gives them).
 *
 *  No arguments give the list of subcommands. A subcommand that has
 *  parameters, called with none, gives its help; so does `help` with the
 *  name of a subcommand, and the help of `help` is the list. Throws a
 *  `ToolError` that tells how to fix the call for `parameters` with no
 *  `command`, an unknown subcommand, `parameters` that are not the text of
 *  a JSON object, and parameters that the subcommand does not take
 *  (`checkArgumentValues`, under the name `<tool> <subcommand>`). */
export function parseSubcommandCall(tool: SubcommandTool, args: ToolArguments): SubcommandCall {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command === '') {
    if (typeof args.parameters === 'string' && args.parameters.trim() !== '') {
      throw new ToolError(`The call gives "parameters" but no "command". Give the name of the subcommand in "command". ${listText(tool)}`)
    }
    return { kind: 'text', text: listText(tool) }
  }
  const subcommand = findSubcommand(tool, command)
  const given = givenParameters(tool, subcommand, args.parameters)
  if (subcommand.parameters.length > 0 && Object.keys(given).length === 0) return { kind: 'text', text: helpText(tool, subcommand) }

  const rules: ArgumentRules = { name: `${tool.name} ${subcommand.name}`, parameters: subcommand.parameters }
  const checked = checkArgumentValues(rules, given)
  if (!checked.ok) {
    throw new ToolError(`${checked.error} The parameters go in "parameters" as the text of a JSON object, as in ${exampleCall(subcommand)}.`)
  }
  if (subcommand.name !== HELP_NAME) return { kind: 'run', name: subcommand.name, arguments: checked.arguments }
  return { kind: 'text', text: helpText(tool, findSubcommand(tool, String(checked.arguments.command).trim())) }
}
