import { describe, expect, it } from 'vitest'
import { TOOL_DEFINITIONS } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { buildSystemPrompt } from './index'

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

describe('buildSystemPrompt', () => {
  it('names the model by its id and the provider by its display name and its id', () => {
    // A provider added in Settings has a random id that the user never sees.
    const custom = { providerId: '3f2c9a1e-7b4d-4c8e-9f60-2a5b8d1c7e43', modelId: 'llama3:8b' }
    const prompt = buildSystemPrompt(custom, 'Home server', [])

    expect(prompt).toContain('`llama3:8b`')
    expect(prompt).toContain('"Home server"')
    expect(prompt).toContain('`3f2c9a1e-7b4d-4c8e-9f60-2a5b8d1c7e43`')
  })

  it('keeps a provider name with line breaks on the first line, with one space for each run of white space', () => {
    // The Settings field is one line, but a hand-edited app_state.json can hold any name.
    const firstLine = buildSystemPrompt(MODEL, 'Home\n\tserver\r\nbox', []).split('\n')[0]

    expect(firstLine).toContain('"Home server box" (id `openrouter`)')
  })

  it('lists each tool in order, with the type and use of each parameter', () => {
    const lines = buildSystemPrompt(MODEL, PROVIDER_NAME, [SEARCH, CLOCK]).split('\n')
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
    const prompt = buildSystemPrompt(MODEL, PROVIDER_NAME, [])

    expect(prompt.split('\n')).toContain('None.')
    expect(prompt).not.toContain('- `')
  })

  it('lists every Dez tool from the registry', () => {
    const prompt = buildSystemPrompt(MODEL, PROVIDER_NAME, TOOL_DEFINITIONS)

    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(`- \`${tool.name}\`: ${tool.description}`)
  })

  it('ends with no line break or space, so the bytes do not depend on the file end', () => {
    expect(buildSystemPrompt(MODEL, PROVIDER_NAME, [SEARCH])).toBe(buildSystemPrompt(MODEL, PROVIDER_NAME, [SEARCH]).trimEnd())
  })
})
