import { describe, expect, it } from 'vitest'
import { parseSubcommandCall, subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError } from './types'

const TOOL: SubcommandTool = {
  name: 'sound',
  summary: 'Change sounds.',
  subcommands: [
    {
      name: 'cut',
      summary: 'Cut a part of a sound.',
      description: 'Makes a new sound from a part of a sound.',
      parameters: [
        { name: 'sound', type: 'string', description: 'The id of the sound.', required: true },
        { name: 'start', type: 'number', description: 'The start in seconds.', required: false },
      ],
      example: { sound: 'b', start: 1.5 },
    },
    {
      name: 'list',
      summary: 'List the sounds.',
      description: 'Lists every sound.',
      parameters: [],
      example: {},
    },
  ],
}

const CUT_CALL = '{"command":"cut","parameters":"{\\"sound\\":\\"b\\",\\"start\\":1.5}"}'
const LIST = [
  'The subcommands of the sound tool:',
  '- cut: Cut a part of a sound.',
  '- list: List the sounds.',
  '- help: Give the details of a subcommand: what it does, its parameters, and an example call.',
  `To get the details of a subcommand, call it with no parameters, as in {"command":"cut"}. To run it, give its parameters as the text of a JSON object, as in ${CUT_CALL}.`,
].join('\n')
const CUT_HELP = [
  'The subcommand cut of the sound tool: Makes a new sound from a part of a sound.',
  'Its parameters, in the text of a JSON object in "parameters":',
  '- sound (string, required): The id of the sound.',
  '- start (number, optional): The start in seconds.',
  `Example call: ${CUT_CALL}`,
].join('\n')

function errorOf(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('The call did not throw.')
}

describe('subcommandToolDefinition', () => {
  it('names the subcommands and how to list them and get their details, with two optional text arguments', () => {
    const definition = subcommandToolDefinition(TOOL)
    expect(definition.description).toBe('Change sounds. It has subcommands (cut, list, help). '
      + 'Call it with no arguments to list them with what each one does. '
      + 'Call a subcommand with no parameters, as in {"command": "cut"}, to get its details: what it does, its parameters, and an example call.')
    expect(definition.parameters.map(({ name, type, required }) => ({ name, type, required }))).toStrictEqual([
      { name: 'command', type: 'string', required: false },
      { name: 'parameters', type: 'string', required: false },
    ])
  })
})

describe('parseSubcommandCall', () => {
  it('lists the subcommands for a call with no arguments or a blank command', () => {
    expect(parseSubcommandCall(TOOL, {})).toStrictEqual({ kind: 'text', text: LIST })
    expect(parseSubcommandCall(TOOL, { command: ' ', parameters: '' })).toStrictEqual({ kind: 'text', text: LIST })
  })

  it('gives the help of a subcommand called with no parameters, a blank text, or an empty object', () => {
    for (const parameters of [undefined, ' ', '{}']) {
      expect(parseSubcommandCall(TOOL, { command: 'cut', ...(parameters !== undefined && { parameters }) })).toStrictEqual({ kind: 'text', text: CUT_HELP })
    }
  })

  it('gives the help of a subcommand that help names, and the list for help of help or help alone', () => {
    expect(parseSubcommandCall(TOOL, { command: 'help', parameters: '{"command": "cut"}' })).toStrictEqual({ kind: 'text', text: CUT_HELP })
    expect(parseSubcommandCall(TOOL, { command: 'help', parameters: '{"command": "help"}' })).toStrictEqual({ kind: 'text', text: LIST })
    expect(parseSubcommandCall(TOOL, { command: 'help' })).toStrictEqual({ kind: 'text', text: LIST })
  })

  it('runs a subcommand with its checked parameters, and one with no parameters at once', () => {
    expect(parseSubcommandCall(TOOL, { command: ' cut ', parameters: '{"start": 2, "sound": "c"}' }))
      .toStrictEqual({ kind: 'run', name: 'cut', arguments: { sound: 'c', start: 2 } })
    expect(parseSubcommandCall(TOOL, { command: 'list' })).toStrictEqual({ kind: 'run', name: 'list', arguments: {} })
  })

  it('refuses parameters with no command, and lists the subcommands', () => {
    expect(errorOf(() => parseSubcommandCall(TOOL, { parameters: '{"sound": "b"}' })))
      .toBe(`The call gives "parameters" but no "command". Give the name of the subcommand in "command". ${LIST}`)
  })

  it('refuses an unknown subcommand, also one that help names, and lists the subcommands', () => {
    const unknown = `The sound tool has no subcommand "Cut". ${LIST}`
    expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'Cut' }))).toBe(unknown)
    expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'help', parameters: '{"command": "Cut"}' }))).toBe(unknown)
  })

  it('refuses parameters that are not the text of a JSON object, with an example call', () => {
    const error = `"parameters" is not the text of a JSON object. Give the parameters of sound cut as the text of one JSON object, as in ${CUT_CALL}.`
    for (const parameters of ['{"sound":', '["b"]', 'null', '"b"']) {
      expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'cut', parameters }))).toBe(error)
    }
  })

  it('refuses parameters that the subcommand does not take, and tells where they go', () => {
    const where = `The parameters go in "parameters" as the text of a JSON object, as in ${CUT_CALL}.`
    expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"sound": "b", "end": 3}' })))
      .toBe(`sound cut has no parameter "end". The parameters of sound cut are: sound (string, required), start (number). ${where}`)
    expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"start": 3}' })))
      .toBe(`The required parameter "sound" is missing. Add it as a string, as in {"sound": "..."}. ${where}`)
    expect(errorOf(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"sound": "b", "start": "3"}' })))
      .toBe(`The parameter "start" must be a number, as in {"start": 1.5}. ${where}`)
  })
})
