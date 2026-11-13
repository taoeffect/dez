import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { namedModelTarget, nearModelIds, parameterValuesArgument } from './modelArguments'
import { refusal } from './testing'
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
    const refusalWith = (advice?: string) => refusal(() => namedModelTarget(CACHE, [OPENROUTER], 'grok-video', advice))

    expect(refusalWith()).toContain('is not a full model id')
    expect(refusalWith()).not.toContain('Leave out')
    expect(refusalWith('Leave out `model`.')).toBe(`${refusalWith()} Leave out \`model\`.`)
  })

  // A model that copies an id from memory gets the id that it meant, so
  // that its next call needs no `model_list` call.
  it.each([
    ['a model id with other marks', 'venice/wan-2-6-flash-image-to-video', 'The user cannot use the model "venice/wan-2-6-flash-image-to-video". The nearest id of a model that the user can use is "venice/wan-2.6-flash-image-to-video".'],
    ['an id with no provider', 'wan-2.6-flash-image-to-video', '"wan-2.6-flash-image-to-video" is not a full model id (provider/model). The nearest id of a model that the user can use is "venice/wan-2.6-flash-image-to-video".'],
    ['an id with a provider that the user does not have', 'wan/wan-2.6-image-to-video', 'No provider has the id "wan". The nearest id of a model that the user can use is "venice/wan-2.6-image-to-video".'],
    ['a part of two ids', 'image-to-video', '"image-to-video" is not a full model id (provider/model). The nearest ids of models that the user can use are "venice/wan-2.6-image-to-video", "venice/wan-2.6-flash-image-to-video".'],
    ['an id that is near no id', 'venice/sora-9', 'The user cannot use the model "venice/sora-9".'],
  ])('names the nearest ids in the refusal of %s', (_name, named, refusal) => {
    const venice = providerInfo('venice', 'Venice')
    const models = ['wan-2.6-flash-image-to-video', 'wan-2.6-image-to-video', 'z-image-turbo'].map((id): ModelInfo => ({ id, name: id, provider: venice.id }))
    const cache: ModelCache = { version: 1, providers: { venice: { models, working: true, updatedAt: 0, lastCheckedAt: 0 } } }

    expect(() => namedModelTarget(cache, [venice], named)).toThrow(new ToolError(`${refusal} Use model_list to find the full ids of the models that the user can use.`))
  })

  // The models of another provider are no help for a call that names a
  // provider of the user.
  it('names only the near ids of the provider that the call names', () => {
    const other = providerInfo('other', 'Other')
    const cache: ModelCache = {
      version: 1,
      providers: { ...CACHE.providers, other: { models: [{ ...VIDEO, provider: other.id }], working: true, updatedAt: 0, lastCheckedAt: 0 } },
    }

    expect(() => namedModelTarget(cache, [OPENROUTER, other], 'openrouter/grok-video'))
      .toThrow('The nearest id of a model that the user can use is "openrouter/x-ai/grok-video". ')
  })

  // A model that copies an OpenRouter id leaves out `openrouter/`, and the
  // ids of the model part alone (`gpt-5`) are nearer than the id that holds
  // the whole name.
  it('names first the id that holds the whole name of a call with no known provider', () => {
    const copilot = providerInfo('copilot', 'Copilot')
    const copilotModels = ['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5-mini'].map((id): ModelInfo => ({ id, name: id, provider: copilot.id }))
    const cache: ModelCache = {
      version: 1,
      providers: {
        copilot: { models: copilotModels, working: true, updatedAt: 0, lastCheckedAt: 0 },
        openrouter: { models: [{ id: 'openai/gpt-5', name: 'GPT-5', provider: OPENROUTER.id }], working: true, updatedAt: 0, lastCheckedAt: 0 },
      },
    }

    expect(() => namedModelTarget(cache, [copilot, OPENROUTER], 'openai/gpt-5'))
      .toThrow('No provider has the id "openai". The nearest ids of models that the user can use are "copilot/gpt-5", "openrouter/openai/gpt-5", "copilot/gpt-5.1". ')
  })

  // A provider with no key lists no models: the call can mean the same
  // model at another provider.
  it('names the near ids of every provider for a provider that lists no models', () => {
    const minimax = providerInfo('minimax', 'MiniMax', false)
    const cache: ModelCache = {
      version: 1,
      providers: { openrouter: { models: [{ id: 'minimax/minimax-m2', name: 'MiniMax M2', provider: OPENROUTER.id }, PLAIN], working: true, updatedAt: 0, lastCheckedAt: 0 } },
    }

    expect(() => namedModelTarget(cache, [OPENROUTER, minimax], 'minimax/MiniMax-M2'))
      .toThrow(new ToolError('The user cannot use the model "minimax/MiniMax-M2". The nearest id of a model that the user can use is "openrouter/minimax/minimax-m2". Use model_list to find the full ids of the models that the user can use.'))
  })
})

describe('nearModelIds', () => {
  const models = (...ids: string[]) => ids.map((id): ModelInfo => ({ id, name: id, provider: 'p' }))

  it('compares only letters and digits, in any case', () => {
    expect(nearModelIds(models('wan-2.6-flash', 'plain'), ['WAN_2-6_Flash'])).toStrictEqual(['p/wan-2.6-flash'])
  })

  it('takes one change for each five characters, and at least one', () => {
    // 10 letters and digits: 2 changes are near, 3 are not.
    expect(nearModelIds(models('abcdefghij'), ['abcdefghxy'])).toStrictEqual(['p/abcdefghij'])
    expect(nearModelIds(models('abcdefghij'), ['abcdefgxyz'])).toStrictEqual([])
    expect(nearModelIds(models('gpt5'), ['gpt4'])).toStrictEqual(['p/gpt5'])
  })

  it('takes an id that holds the text, or that the text holds, from 4 letters and digits', () => {
    expect(nearModelIds(models('openai/gpt-4o', 'openai/o1-pro'), ['gpt-4o'])).toStrictEqual(['p/openai/gpt-4o'])
    expect(nearModelIds(models('gpt-4o'), ['openai/gpt-4o-2026'])).toStrictEqual(['p/gpt-4o'])
    // `o1` is in too many ids by chance.
    expect(nearModelIds(models('openai/o1-pro'), ['o1'])).toStrictEqual([])
  })

  // `flux-2-max` is no part of the text and 3 changes away; the id that
  // is the 4th nearest is left out.
  it('gives at most 3 ids, the nearest first', () => {
    expect(nearModelIds(models('flux-2-pro-ultra-max', 'flux-2-pro-ultra', 'flux-2', 'flux-2-pro', 'flux-2-max'), ['flux-2-pro']))
      .toStrictEqual(['p/flux-2-pro', 'p/flux-2', 'p/flux-2-pro-ultra'])
  })

  it('gives none for a text with no letter and no digit', () => {
    expect(nearModelIds(models('plain'), [' / '])).toStrictEqual([])
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
