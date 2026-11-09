import { describe, expect, it } from 'vitest'
import { TOOL_DEFINITIONS } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { buildSystemPrompt } from './index'

const MODEL = { providerId: 'openrouter', modelId: 'google/gemini-3-pro-preview' }

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
  it('names the model and the provider by their ids', () => {
    const prompt = buildSystemPrompt(MODEL, [])

    expect(prompt).toContain('`google/gemini-3-pro-preview`')
    expect(prompt).toContain('`openrouter`')
  })

  it('lists each tool in order, with the type and use of each parameter', () => {
    const lines = buildSystemPrompt(MODEL, [SEARCH, CLOCK]).split('\n')
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
    const prompt = buildSystemPrompt(MODEL, [])

    expect(prompt.split('\n')).toContain('None.')
    expect(prompt).not.toContain('- `')
  })

  it('lists every Dez tool from the registry', () => {
    const prompt = buildSystemPrompt(MODEL, TOOL_DEFINITIONS)

    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(`- \`${tool.name}\`: ${tool.description}`)
  })

  it('ends with no line break or space, so the bytes do not depend on the file end', () => {
    expect(buildSystemPrompt(MODEL, [SEARCH])).toBe(buildSystemPrompt(MODEL, [SEARCH]).trimEnd())
  })
})
