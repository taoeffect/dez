import { describe, expect, it } from 'vitest'
import { parseToolArguments } from './arguments'
import { parseSubcommandCall, subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { refusal } from './testing'

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
const DETAILS = 'To get the details of a subcommand (what it does, its parameters, and an example call), call help with its name, '
  + 'as in {"command":"help","parameters":"{\\"command\\":\\"cut\\"}"}, or call a subcommand that takes parameters with none, as in {"command":"cut"}.'
const LIST = [
  'The subcommands of the sound tool:',
  '- cut: Cut a part of a sound.',
  '- list: List the sounds.',
  '- help: Give the details of a subcommand: what it does, its parameters, and an example call.',
  `${DETAILS} To run a subcommand, give its parameters as the text of a JSON object, as in ${CUT_CALL}.`,
].join('\n')
const CUT_HELP = [
  'The subcommand cut of the sound tool: Makes a new sound from a part of a sound.',
  'Its parameters, in the text of a JSON object in "parameters":',
  '- sound (string, required): The id of the sound.',
  '- start (number, optional): The start in seconds.',
  `Example call: ${CUT_CALL}`,
].join('\n')

describe('subcommandToolDefinition', () => {
  it('names the subcommands and how to list them and get their details, with two optional text arguments', () => {
    const definition = subcommandToolDefinition(TOOL)
    expect(definition.description).toBe('Change sounds. It has subcommands (cut, list, help). '
      + `Call it with no arguments to list them with what each one does. ${DETAILS}`)
    expect(definition.parameters.map(({ name, type, required }) => ({ name, type, required }))).toStrictEqual([
      { name: 'command', type: 'string', required: false },
      { name: 'parameters', type: 'string', required: false },
    ])
  })

  // A subcommand that takes no parameters runs when a call gives none, so it
  // is never the example of a details call with no parameters.
  it('gives a details call with no parameters only for a subcommand that takes parameters, and none when no subcommand does', () => {
    const [cut, list] = TOOL.subcommands
    expect(subcommandToolDefinition({ ...TOOL, subcommands: [list, cut] }).description).toBe('Change sounds. It has subcommands (list, cut, help). '
      + 'Call it with no arguments to list them with what each one does. '
      + 'To get the details of a subcommand (what it does, its parameters, and an example call), call help with its name, '
      + 'as in {"command":"help","parameters":"{\\"command\\":\\"list\\"}"}, or call a subcommand that takes parameters with none, as in {"command":"cut"}.')
    expect(subcommandToolDefinition({ ...TOOL, subcommands: [list] }).description).toBe('Change sounds. It has subcommands (list, help). '
      + 'Call it with no arguments to list them with what each one does. '
      + 'To get the details of a subcommand (what it does, its parameters, and an example call), call help with its name, '
      + 'as in {"command":"help","parameters":"{\\"command\\":\\"list\\"}"}.')
  })
})

// A model that knows a parameter from another tool writes it next to
// `command`. The list of the tool's two parameters does not tell the fix.
describe('a call with a parameter of a subcommand next to "command"', () => {
  const FADE = { name: 'fade', summary: 'Fade a sound.', description: 'Fades a sound in.', parameters: TOOL.subcommands[0].parameters.slice(1), example: { start: 0 } }
  const definition = subcommandToolDefinition({ ...TOOL, subcommands: [...TOOL.subcommands, FADE] })
  const errorOfCall = (args: Record<string, unknown>) => {
    const parsed = parseToolArguments(definition, JSON.stringify(args))
    return parsed.ok ? '' : parsed.error
  }
  const goesInside = (key: string, subcommand: string, call: string) =>
    `sound has no parameter "${key}". "${key}" is a parameter of the subcommand ${subcommand}, so it goes inside "parameters", the text of a JSON object, and not next to "command", as in ${call}.`

  it('tells that it goes inside "parameters", with the call\'s own number in the example', () => {
    expect(errorOfCall({ command: 'cut', parameters: '{"sound":"c"}', start: 3 }))
      .toBe(goesInside('start', 'cut', '{"command":"cut","parameters":"{\\"sound\\":\\"b\\",\\"start\\":3}"}'))
  })

  it('names the subcommand of the call first, else the first one that has the parameter', () => {
    expect(errorOfCall({ command: ' fade ', start: 2 })).toBe(goesInside('start', 'fade', '{"command":"fade","parameters":"{\\"start\\":2}"}'))
    for (const command of ['list', 'none', undefined, 7]) {
      expect(errorOfCall({ command, start: 2 })).toBe(goesInside('start', 'cut', '{"command":"cut","parameters":"{\\"sound\\":\\"b\\",\\"start\\":2}"}'))
    }
  })

  // A text can be long, and a value of a wrong type is no example.
  it.each([
    ['a text', 'sound', 'c'.repeat(500)],
    ['a value of another type', 'start', '3'],
    ['a value that is no scalar', 'start', { seconds: 3 }],
  ])('keeps %s out of the example', (_name, key, value) => {
    expect(errorOfCall({ command: 'cut', [key]: value })).toBe(goesInside(key, 'cut', CUT_CALL))
  })

  it('lists the two parameters of the tool for a key that no subcommand has', () => {
    expect(errorOfCall({ command: 'cut', end: 3 })).toBe('sound has no parameter "end". The parameters of sound are: command (string), parameters (string).')
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
    expect(refusal(() => parseSubcommandCall(TOOL, { parameters: '{"sound": "b"}' })))
      .toBe(`The call gives "parameters" but no "command". Give the name of the subcommand in "command". ${LIST}`)
  })

  it('refuses an unknown subcommand, also one that help names, and lists the subcommands', () => {
    const unknown = `The sound tool has no subcommand "Cut". ${LIST}`
    expect(refusal(() => parseSubcommandCall(TOOL, { command: 'Cut' }))).toBe(unknown)
    expect(refusal(() => parseSubcommandCall(TOOL, { command: 'help', parameters: '{"command": "Cut"}' }))).toBe(unknown)
  })

  it('refuses parameters that are not the text of a JSON object, with an example call', () => {
    const error = `"parameters" is not the text of a JSON object. Give the parameters of sound cut as the text of one JSON object, as in ${CUT_CALL}.`
    for (const parameters of ['{"sound":', '["b"]', 'null', '"b"']) {
      expect(refusal(() => parseSubcommandCall(TOOL, { command: 'cut', parameters }))).toBe(error)
    }
  })

  it('refuses parameters that the subcommand does not take, and tells where they go', () => {
    const where = `The parameters go in "parameters" as the text of a JSON object, as in ${CUT_CALL}.`
    expect(refusal(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"sound": "b", "end": 3}' })))
      .toBe(`sound cut has no parameter "end". The parameters of sound cut are: sound (string, required), start (number). ${where}`)
    expect(refusal(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"start": 3}' })))
      .toBe(`The required parameter "sound" is missing. Add it as a string, as in {"sound": "..."}. ${where}`)
    expect(refusal(() => parseSubcommandCall(TOOL, { command: 'cut', parameters: '{"sound": "b", "start": "3"}' })))
      .toBe(`The parameter "start" must be a number, as in {"start": 1.5}. ${where}`)
  })
})
