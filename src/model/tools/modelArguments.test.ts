import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { namedModelTarget, parameterValuesArgument } from './modelArguments'
import { ToolError } from './types'

const OPENROUTER = providerInfo('openrouter', 'OpenRouter')

// Model ids can hold `/`; provider ids cannot.
const VIDEO: ModelInfo = {
  id: 'x-ai/grok-video',
  name: 'Grok Video',
  provider: OPENROUTER.id,
  outputs: ['video'],
  request: 'video',
  parameters: [
    { name: 'duration', label: 'Length (seconds)', options: [1, 5, 10], default: 1 },
    { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] },
    { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5 },
  ],
}
const PLAIN: ModelInfo = { id: 'plain', name: 'Plain', provider: OPENROUTER.id }

const CACHE: ModelCache = {
  version: 1,
  providers: { openrouter: { models: [VIDEO, PLAIN], working: true, updatedAt: 0, lastCheckedAt: 0 } },
}

// modelInfo.test.ts checks each refusal of a named model through
// `modelInfoTarget`, which adds the advice of a tool with an optional
// `model`.
describe('namedModelTarget', () => {
  it('finds the provider and the cached model of a full id, split at the first /', () => {
    expect(namedModelTarget(CACHE, [OPENROUTER], 'openrouter/x-ai/grok-video')).toStrictEqual({ provider: OPENROUTER, model: VIDEO })
  })

  it('tells a tool that needs `model` nothing about a call with no `model`', () => {
    const refusal = (advice?: string) => {
      try {
        namedModelTarget(CACHE, [OPENROUTER], 'grok-video', advice)
      } catch (error) {
        return (error as ToolError).message
      }
      return ''
    }

    expect(refusal()).toContain('is not a full model id')
    expect(refusal()).not.toContain('Leave out')
    expect(refusal('Leave out `model`.')).toBe(`${refusal()} Leave out \`model\`.`)
  })
})

describe('parameterValuesArgument', () => {
  it('reads the values from the text of a JSON object', () => {
    expect(parameterValuesArgument(VIDEO, { model: 'openrouter/x-ai/grok-video', parameters: '{"duration": 5, "aspect_ratio": "1:1", "duration_seconds": 30}' }))
      .toStrictEqual({ duration: 5, aspect_ratio: '1:1', duration_seconds: 30 })
  })

  it('names no value for a call with no `parameters`', () => {
    expect(parameterValuesArgument(VIDEO, { model: 'openrouter/x-ai/grok-video' })).toStrictEqual({})
  })

  it.each(['duration=5', '[5]', '5', 'null', ''])('refuses %j, which is not a JSON object', (parameters) => {
    expect(() => parameterValuesArgument(VIDEO, { parameters })).toThrow('`parameters` must be the text of a JSON object')
  })

  // A wrong value must not look like a price of the right one, and must
  // not go into a paid request.
  it.each([
    ['a name that is no parameter of the model', '{"fps": 60}', 'The model has no parameter "fps". Its parameters: duration, aspect_ratio, duration_seconds.'],
    ['a value that is not an option', '{"duration": 7}', 'The parameter "duration" takes one of: 1, 5, 10.'],
    ['a text for a number option', '{"duration": "5"}', 'The parameter "duration" takes one of: 1, 5, 10.'],
    ['a number out of the range', '{"duration_seconds": 31}', 'The parameter "duration_seconds" takes a whole number from 1 to 30.'],
  ])('refuses %s, and tells what the model takes', (_name, parameters, message) => {
    expect(() => parameterValuesArgument(VIDEO, { parameters })).toThrow(new ToolError(message))
  })

  it('refuses a value for a model with no parameters, and tells the model to leave them out', () => {
    expect(() => parameterValuesArgument(PLAIN, { parameters: '{"duration": 5}' }))
      .toThrow(new ToolError('The model has no parameter "duration". It has no parameters: leave out `parameters`.'))
  })
})
