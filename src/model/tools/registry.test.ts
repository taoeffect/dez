import { describe, expect, it } from 'vitest'
import { RESERVED_TOOL_ATTRIBUTES } from '../chat/toolBlocks'
import { callLabel, isIntermediateCall, TOOL_DEFINITIONS, toolDefinition, toolJsonSchema, unknownToolText } from './registry'
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

describe('callLabel', () => {
  it('gives the start of the prompt of a model_invoke call', () => {
    expect(callLabel('model_invoke', { model: 'studio/paint', prompt: 'Scene 3:\n"the fox runs"' })).toBe('Scene 3: \'the fox runs\'')
  })

  it('gives the subcommand and its main argument of a video call', () => {
    expect(callLabel('video', { command: 'join_clips', parameters: '{"clips": "@a @b", "is_intermediate": true}' })).toBe('join_clips @a @b')
    expect(callLabel('video', { command: 'ffmpeg', parameters: '{"arguments": "-i @a out.mp4"}' })).toBe('ffmpeg -i @a out.mp4')
    expect(callLabel('video', { command: 'title', parameters: '{"text": "NEON CITY", "duration": 3}' })).toBe('title NEON CITY')
  })

  it('gives the app and the parameters of the run of an apps invoke call', () => {
    expect(callLabel('apps', { command: 'invoke', parameters: '{"name": "contact-sheet", "inputs": "@a @b", "is_intermediate": true}' })).toBe('invoke contact-sheet')
    expect(callLabel('apps', { command: ' invoke ', parameters: '{"name": "contact-sheet", "parameters": {"columns": 4}}' })).toBe('invoke contact-sheet {\'columns\':4}')
  })

  it('gives the subcommand and its parameters of another call, also a bad video call', () => {
    expect(callLabel('image', { command: 'crop', parameters: '{"image": "a"}' })).toBe('crop {\'image\': \'a\'}')
    expect(callLabel('video', { command: 'join_clips', parameters: 'clips @a' })).toBe('join_clips clips @a')
    expect(callLabel('apps', { command: 'ls', parameters: '{"path": "/apps/notes"}' })).toBe('ls {\'path\': \'/apps/notes\'}')
    expect(callLabel('apps', { command: 'invoke', parameters: '{"name": 5}' })).toBe('invoke {\'name\': 5}')
  })

  it('gives no label for a call with no subcommand', () => {
    expect(callLabel('jobs_wait', {})).toBe('')
  })
})

describe('isIntermediateCall', () => {
  it('is true for a call that asks Dez to hide what its job makes', () => {
    expect(isIntermediateCall('model_invoke', { model: 'studio/paint', prompt: 'a fox', is_intermediate: true })).toBe(true)
    expect(isIntermediateCall('video', { command: 'join_clips', parameters: '{"clips": "@a @b", "is_intermediate": true}' })).toBe(true)
    expect(isIntermediateCall('apps', { command: 'invoke', parameters: '{"name": "contact-sheet", "is_intermediate": true}' })).toBe(true)
  })

  it('is false for a call with no such flag, for a call that Dez refuses, and for a tool with no such parameter', () => {
    expect(isIntermediateCall('model_invoke', { model: 'studio/paint', prompt: 'a fox' })).toBe(false)
    expect(isIntermediateCall('apps', { command: 'invoke', parameters: '{"name": "contact-sheet", "is_intermediate": false}' })).toBe(false)
    expect(isIntermediateCall('apps', { command: 'invoke', parameters: '{"name": "contact-sheet"}' })).toBe(false)
    expect(isIntermediateCall('apps', { command: 'ls', parameters: '{"is_intermediate": true}' })).toBe(false)
    expect(isIntermediateCall('apps', { command: 'invoke', parameters: '{"name": 5, "is_intermediate": true}' })).toBe(false)
    expect(isIntermediateCall('video', { command: 'join_clips', parameters: 'is_intermediate' })).toBe(false)
    expect(isIntermediateCall('image', { command: 'crop', parameters: '{"image": "a", "is_intermediate": true}' })).toBe(false)
  })
})

describe('unknownToolText', () => {
  it('names the unknown tool and every Dez tool', () => {
    const text = unknownToolText('web_search')

    expect(text).toContain('"web_search"')
    for (const { name } of TOOL_DEFINITIONS) expect(text).toContain(name)
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
