import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_DEFINITIONS } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { ExplainedError } from '../../utils/errorText'
import { BUILT_IN_SYSTEM_PROMPT, buildSystemPrompt, systemPromptErrorText, systemPromptProblem } from './index'

const MODEL = { providerId: 'openrouter', modelId: 'google/gemini-3-pro-preview' }
const PROVIDER_NAME = 'OpenRouter'

const SEARCH: ToolDefinition = {
  name: 'search',
  description: 'Search the notes.',
  parameters: [
    { name: 'query', type: 'string', description: 'The words to find.', required: true },
    { name: 'limit', type: 'integer', description: 'The most results.', required: false },
  ],
}
const CLOCK: ToolDefinition = { name: 'clock', description: 'Give the time.', parameters: [] }

// The built-in prompt, which is never blank.
function builtIn(model: { providerId: string, modelId: string }, providerName: string, tools: readonly ToolDefinition[]): string {
  const prompt = buildSystemPrompt(BUILT_IN_SYSTEM_PROMPT, model, providerName, tools)
  if (prompt === undefined) throw new Error('The built-in prompt is blank')
  return prompt
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildSystemPrompt with the built-in template', () => {
  it('names the model by its id and the provider by its display name and its id', () => {
    // A provider added in Settings has a random id that the user never sees.
    const custom = { providerId: '3f2c9a1e-7b4d-4c8e-9f60-2a5b8d1c7e43', modelId: 'llama3:8b' }
    const prompt = builtIn(custom, 'Home server', [])

    expect(prompt).toContain('`llama3:8b`')
    expect(prompt).toContain('"Home server"')
    expect(prompt).toContain('`3f2c9a1e-7b4d-4c8e-9f60-2a5b8d1c7e43`')
  })

  it('keeps a provider name with line breaks on the first line, with one space for each run of white space', () => {
    // The Settings field is one line, but a hand-edited app_state.json can hold any name.
    const firstLine = builtIn(MODEL, 'Home\n\tserver\r\nbox', []).split('\n')[0]

    expect(firstLine).toContain('"Home server box" (id `openrouter`)')
  })

  it('lists each tool in order, with the type and use of each parameter', () => {
    const lines = builtIn(MODEL, PROVIDER_NAME, [SEARCH, CLOCK]).split('\n')
    const first = lines.indexOf('- `search`: Search the notes. Parameters:')

    expect(first).toBeGreaterThanOrEqual(0)
    expect(lines.slice(first, first + 4)).toEqual([
      '- `search`: Search the notes. Parameters:',
      '  - `query` (string, required): The words to find.',
      '  - `limit` (integer, optional): The most results.',
      '- `clock`: Give the time. No parameters.',
    ])
  })

  it('says None. in place of the list when the request offers no tools', () => {
    const prompt = builtIn(MODEL, PROVIDER_NAME, [])

    expect(prompt.split('\n')).toContain('None.')
    expect(prompt).not.toContain('- `')
  })

  it('lists every Dez tool from the registry', () => {
    const prompt = builtIn(MODEL, PROVIDER_NAME, TOOL_DEFINITIONS)

    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(`- \`${tool.name}\`: ${tool.description}`)
  })

  it('ends with no line break or space, so the bytes do not depend on the file end', () => {
    expect(builtIn(MODEL, PROVIDER_NAME, [SEARCH])).toBe(builtIn(MODEL, PROVIDER_NAME, [SEARCH]).trimEnd())
  })
})

describe('buildSystemPrompt with a template of the user', () => {
  it('fills the variables and drops only the white space at the end', () => {
    expect(buildSystemPrompt('\n  Be {{ model_id }} of {{provider_name}} ({{provider_id}}).\nTools:\n{{tools_list}}\n \n', MODEL, 'Open\nRouter', [CLOCK]))
      .toBe('\n  Be google/gemini-3-pro-preview of Open Router (openrouter).\nTools:\n- `clock`: Give the time. No parameters.')
  })

  it('gives no system prompt for an empty template or one of only white space', () => {
    expect(buildSystemPrompt('', MODEL, PROVIDER_NAME, [])).toBeUndefined()
    expect(buildSystemPrompt(' \n\t\r\n ', MODEL, PROVIDER_NAME, [SEARCH])).toBeUndefined()
  })

  it('sends no path of a stored file that the template holds', () => {
    const template = 'Look at ![/home/u/.config/dez/assets/images/1.png](id=a) and {{model_id}}.'

    expect(buildSystemPrompt(template, MODEL, PROVIDER_NAME, [])).toBe('Look at ![image](id=a) and google/gemini-3-pro-preview.')
  })

  it('throws the refusal text of a template with a problem, and logs it', () => {
    let thrown: unknown
    try {
      buildSystemPrompt('Hi\n{{model}}', MODEL, PROVIDER_NAME, [])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ExplainedError)
    expect((thrown as ExplainedError).message).toBe(systemPromptErrorText('Line 2: {{model}} is not a variable.'))
    expect(console.error).toHaveBeenCalledWith(thrown)
  })
})

describe('systemPromptProblem', () => {
  it('finds no problem in the built-in template or a blank one', () => {
    expect(systemPromptProblem(BUILT_IN_SYSTEM_PROMPT)).toBeNull()
    expect(systemPromptProblem('  \n')).toBeNull()
  })

  it('gives the first problem with its line, and logs nothing', () => {
    expect(systemPromptProblem('You are {{model_id}}.\n{{model_name}} and }}')).toBe('Line 2: {{model_name}} is not a variable.')
    expect(console.error).not.toHaveBeenCalled()
  })
})
