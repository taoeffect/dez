import { describe, expect, it } from 'vitest'
import { RESERVED_TOOL_ATTRIBUTES } from '../chat/toolBlocks'
import { parseToolArguments, TOOL_DEFINITIONS, toolDefinition, toolJsonSchema } from './registry'
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

describe('parseToolArguments', () => {
  it('gives typed values in definition order', () => {
    const result = parseToolArguments(SAMPLE, '{"exact":false,"ratio":0.5,"limit":3,"query":"gemini"}')
    expect(result).toStrictEqual({ ok: true, arguments: { query: 'gemini', limit: 3, ratio: 0.5, exact: false } })
    expect(result.ok && Object.keys(result.arguments)).toStrictEqual(['query', 'limit', 'ratio', 'exact'])
  })

  it('reads null and absent optional values as absent', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":null}')).toStrictEqual({ ok: true, arguments: { query: 'a' } })
  })

  it('reads blank text as no arguments', () => {
    expect(parseToolArguments(NO_PARAMETERS, '')).toStrictEqual({ ok: true, arguments: {} })
    expect(parseToolArguments(NO_PARAMETERS, ' \n')).toStrictEqual({ ok: true, arguments: {} })
    expect(parseToolArguments(SAMPLE, '')).toStrictEqual({ ok: false, error: 'missing required parameter "query"' })
  })

  it('refuses a missing or null required value', () => {
    expect(parseToolArguments(SAMPLE, '{}')).toStrictEqual({ ok: false, error: 'missing required parameter "query"' })
    expect(parseToolArguments(SAMPLE, '{"query":null}')).toStrictEqual({ ok: false, error: 'missing required parameter "query"' })
  })

  it('refuses text that is not a JSON object', () => {
    expect(parseToolArguments(SAMPLE, '{"query":')).toStrictEqual({ ok: false, error: 'not valid JSON' })
    for (const json of ['null', '[]', '"query"', '3']) {
      expect(parseToolArguments(SAMPLE, json)).toStrictEqual({ ok: false, error: 'not a JSON object' })
    }
  })

  it('refuses an unknown key, even one that names an Object.prototype member', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","Query":"b"}')).toStrictEqual({ ok: false, error: 'unknown parameter "Query"' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","__proto__":{}}')).toStrictEqual({ ok: false, error: 'unknown parameter "__proto__"' })
  })

  it('does not read an absent parameter from Object.prototype', () => {
    const tool: ToolDefinition = { ...NO_PARAMETERS, parameters: [{ name: 'constructor', type: 'string', description: '', required: false }] }
    expect(parseToolArguments(tool, '{}')).toStrictEqual({ ok: true, arguments: {} })
  })

  it('refuses a value of the wrong type, with no coercion', () => {
    expect(parseToolArguments(SAMPLE, '{"query":3}')).toStrictEqual({ ok: false, error: '"query" must be a string' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":"3"}')).toStrictEqual({ ok: false, error: '"limit" must be an integer' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":1.5}')).toStrictEqual({ ok: false, error: '"limit" must be an integer' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":true}')).toStrictEqual({ ok: false, error: '"ratio" must be a number' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","exact":"true"}')).toStrictEqual({ ok: false, error: '"exact" must be true or false' })
  })

  it('refuses a number too large for a finite value', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":1e999}')).toStrictEqual({ ok: false, error: '"ratio" must be a number' })
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":-1e999}')).toStrictEqual({ ok: false, error: '"ratio" must be a number' })
  })

  it('accepts a whole number written with a fraction as an integer', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":2.0}')).toStrictEqual({ ok: true, arguments: { query: 'a', limit: 2 } })
  })
})
