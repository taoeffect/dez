import { describe, expect, it } from 'vitest'
import { RESERVED_TOOL_ATTRIBUTES } from '../chat/toolBlocks'
import { TOOL_DEFINITIONS, toolDefinition, toolJsonSchema, unknownToolText } from './registry'
import type { ToolDefinition } from './types'

const SAMPLE: ToolDefinition = {
  name: 'sample',
  description: 'A sample tool.',
  parameters: [
    { name: 'query', type: 'string', description: 'The query.', required: true },
    { name: 'limit', type: 'integer', description: 'The limit.', required: false },
    { name: 'ratio', type: 'number', description: 'The ratio.', required: false },
    { name: 'exact', type: 'boolean', description: 'Exact match.', required: false },
  ],
}

const NO_PARAMETERS: ToolDefinition = { name: 'bare', description: 'No parameters.', parameters: [] }

describe('TOOL_DEFINITIONS', () => {
  // Tool and parameter names go into `<dez:tool>` blocks: the tool name as the
  // `name` attribute, each parameter as one more attribute. The block writes
  // `RESERVED_TOOL_ATTRIBUTES` itself, so no parameter may use those names.
  const NAME = /^[a-z][a-z0-9_]*$/

  it('gives each tool a unique name that providers and blocks accept', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(NAME)
      expect(name.length).toBeLessThanOrEqual(64)
    }
  })

  it('gives each parameter a unique attribute name that the block does not use', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const names = tool.parameters.map((parameter) => parameter.name)
      expect(new Set(names).size).toBe(names.length)
      for (const name of names) {
        expect(name).toMatch(NAME)
        expect(RESERVED_TOOL_ATTRIBUTES).not.toContain(name)
      }
    }
  })
})

describe('toolDefinition', () => {
  it('finds a tool by its exact name only', () => {
    expect(toolDefinition('model_list')?.name).toBe('model_list')
    expect(toolDefinition('Model_List')).toBeUndefined()
    expect(toolDefinition('web_search')).toBeUndefined()
  })
})

describe('unknownToolText', () => {
  it('names every Dez tool', () => {
    expect(unknownToolText('web_search')).toBe(
      'Dez has no tool named "web_search". Call only the Dez tools, by their exact names: model_list, model_info, crop_scale_image, audio.',
    )
  })
})

describe('toolJsonSchema', () => {
  it('lists the parameters in definition order with the required ones', () => {
    expect(JSON.stringify(toolJsonSchema(SAMPLE))).toBe(JSON.stringify({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query.' },
        limit: { type: 'integer', description: 'The limit.' },
        ratio: { type: 'number', description: 'The ratio.' },
        exact: { type: 'boolean', description: 'Exact match.' },
      },
      required: ['query'],
    }))
  })

  it('leaves out an empty required list', () => {
    expect(toolJsonSchema(NO_PARAMETERS)).toStrictEqual({ type: 'object', properties: {} })
    expect(toolJsonSchema({ ...SAMPLE, parameters: SAMPLE.parameters.slice(1) })).not.toHaveProperty('required')
  })
})
