import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { MODEL_INFO_SIZE_CAP, modelInfoParameterValues, modelInfoTarget, modelInfoText } from './modelInfo'

const OPENROUTER = providerInfo('openrouter', 'OpenRouter')
const CLOSED = providerInfo('closed', 'Closed', false)
const FAILING = providerInfo('failing', 'Failing')
const PROVIDERS = [OPENROUTER, CLOSED, FAILING]

// Model ids can hold `/`; provider ids cannot.
const GEMINI: ModelInfo = { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', provider: OPENROUTER.id, imageInput: true, outputs: ['text', 'image'], request: 'chat' }
const UNKNOWN: ModelInfo = { id: 'mystery', name: 'Mystery', provider: OPENROUTER.id }
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

const CACHE: ModelCache = {
  version: 1,
  providers: {
    openrouter: { models: [GEMINI, UNKNOWN], working: true, updatedAt: 0, lastCheckedAt: 0 },
    closed: { models: [{ id: 'm', name: 'M', provider: CLOSED.id }], working: true, updatedAt: 0, lastCheckedAt: 0 },
    failing: { models: [{ id: 'm', name: 'M', provider: FAILING.id }], working: false, updatedAt: 0, lastCheckedAt: 0 },
  },
}

const FIND_MODELS = 'Use model_list to find the full ids of the models that the user can use.'

describe('modelInfoTarget', () => {
  it('finds the provider and the cached model of a full id, split at the first /', () => {
    expect(modelInfoTarget(CACHE, PROVIDERS, { model: 'openrouter/google/gemini-3-pro' })).toStrictEqual({ provider: OPENROUTER, model: GEMINI })
  })

  it.each(['', 'gemini-3-pro', 'openrouter/', '/google/gemini-3-pro'])('refuses %j, which is not a full id', (model) => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model }))
      .toThrow(`${JSON.stringify(model)} is not a full model id (provider/model). ${FIND_MODELS}`)
  })

  it('refuses a provider id that no provider has', () => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model: 'google/gemini-3-pro' }))
      .toThrow(`No provider has the id "google". ${FIND_MODELS}`)
  })

  // The models that model_list lists: a configured provider whose last check
  // did not fail, and a model in its cached list.
  it.each(['closed/m', 'failing/m', 'openrouter/gemini-3-pro'])('refuses %s, which model_list does not list', (model) => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model }))
      .toThrow(`The user cannot use the model ${JSON.stringify(model)}. ${FIND_MODELS}`)
  })
})

describe('modelInfoParameterValues', () => {
  it('reads the values from the text of a JSON object', () => {
    expect(modelInfoParameterValues(VIDEO, { model: 'openrouter/x-ai/grok-video', parameters: '{"duration": 5, "aspect_ratio": "1:1", "duration_seconds": 30}' }))
      .toStrictEqual({ duration: 5, aspect_ratio: '1:1', duration_seconds: 30 })
  })

  it('names no value for a call with no `parameters`', () => {
    expect(modelInfoParameterValues(VIDEO, { model: 'openrouter/x-ai/grok-video' })).toStrictEqual({})
  })

  it.each(['duration=5', '[5]', '5', 'null', ''])('refuses %j, which is not a JSON object', (parameters) => {
    expect(() => modelInfoParameterValues(VIDEO, { parameters })).toThrow('`parameters` must be the text of a JSON object')
  })

  // A wrong value must not look like a price of the right one.
  it.each([
    ['a name that is no parameter of the model', '{"fps": 60}', 'The model has no parameter "fps". Its parameters: duration, aspect_ratio, duration_seconds.'],
    ['a value that is not an option', '{"duration": 7}', 'The parameter "duration" takes one of: 1, 5, 10.'],
    ['a text for a number option', '{"duration": "5"}', 'The parameter "duration" takes one of: 1, 5, 10.'],
    ['a number out of the range', '{"duration_seconds": 31}', 'The parameter "duration_seconds" takes a whole number from 1 to 30.'],
  ])('refuses %s, and tells what the model takes', (_name, parameters, message) => {
    expect(() => modelInfoParameterValues(VIDEO, { parameters })).toThrow(new Error(message))
  })

  it('refuses a value for a model with no parameters', () => {
    expect(() => modelInfoParameterValues(GEMINI, { parameters: '{"duration": 5}' })).toThrow(new Error('The model has no parameter "duration". It has no parameters.'))
  })
})

describe('modelInfoText', () => {
  const entry = { id: 'google/gemini-3-pro', pricing: { prompt: '0.000002' }, context_length: 1048576 }

  it('gives the full id, the provider, the fields that Dez knows, and the provider entry as pretty JSON', () => {
    expect(modelInfoText(OPENROUTER, GEMINI, entry)).toBe(JSON.stringify({
      id: 'openrouter/google/gemini-3-pro',
      name: 'Gemini 3 Pro',
      provider: { id: 'openrouter', name: 'OpenRouter' },
      dez: { outputs: ['text', 'image'], request: 'chat', imageInput: true },
      providerEntry: entry,
    }, null, 2))
  })

  it('leaves out every field that Dez does not know', () => {
    expect(JSON.parse(modelInfoText(OPENROUTER, UNKNOWN, { id: 'mystery' })).dez).toStrictEqual({})
  })

  it('says so in a note when Dez has no provider entry', () => {
    const result = JSON.parse(modelInfoText(OPENROUTER, GEMINI, undefined)) as Record<string, unknown>

    expect(result).not.toHaveProperty('providerEntry')
    expect(result.note).toBeTypeOf('string')
  })

  it(`keeps the provider entry up to ${MODEL_INFO_SIZE_CAP} characters, and leaves it out with a note over that`, () => {
    const withPadding = (padding: string) => modelInfoText(OPENROUTER, GEMINI, { ...entry, description: padding })
    const fitting = 'x'.repeat(MODEL_INFO_SIZE_CAP - withPadding('').length)

    expect(withPadding(fitting)).toHaveLength(MODEL_INFO_SIZE_CAP)
    expect(JSON.parse(withPadding(fitting)).providerEntry.description).toBe(fitting)

    const over = JSON.parse(withPadding(`${fitting}x`)) as Record<string, unknown>
    expect(over).not.toHaveProperty('providerEntry')
    expect(over.note).toContain(`${MODEL_INFO_SIZE_CAP + 1} characters`)
    expect(over.dez).toStrictEqual({ outputs: ['text', 'image'], request: 'chat', imageInput: true })
  })

  describe('for a model with parameters', () => {
    const videoEntry = { id: 'x-ai/grok-video' }
    const mediaEntry = { id: 'x-ai/grok-video', pricing_skus: { cents_per_video_output_second_480p: '2' } }

    it('gives each parameter with the value that a request sends, the price, and the entry of the media list', () => {
      const result = modelInfoText(OPENROUTER, VIDEO, videoEntry, { values: { duration: 5, duration_seconds: 5 }, cost: { usd: 0.1 }, mediaEntry })

      expect(JSON.parse(result)).toStrictEqual({
        id: 'openrouter/x-ai/grok-video',
        name: 'Grok Video',
        provider: { id: 'openrouter', name: 'OpenRouter' },
        dez: {
          outputs: ['video'],
          request: 'video',
          parameters: [
            { name: 'duration', label: 'Length (seconds)', options: [1, 5, 10], default: 1, value: 5 },
            // No value: the provider's own default applies.
            { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] },
            { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5, value: 5 },
          ],
          cost: { usd: 0.1 },
        },
        providerEntry: videoEntry,
        mediaEntry,
      })
    })

    it('tells that the provider gave no price, and has no media entry for a provider with no media list', () => {
      const result = JSON.parse(modelInfoText(OPENROUTER, VIDEO, videoEntry, { values: {}, cost: { error: 'No answer' } })) as { dez: Record<string, unknown> }

      expect(result.dez.cost).toStrictEqual({ error: 'No answer' })
      expect(result).not.toHaveProperty('mediaEntry')
    })

    it('leaves both entries out of a result over the limit, and keeps the parameters and the price', () => {
      const request = { values: { duration: 1 }, cost: { usd: 0.02 }, mediaEntry: { id: 'x-ai/grok-video', description: 'x'.repeat(MODEL_INFO_SIZE_CAP) } }
      const result = JSON.parse(modelInfoText(OPENROUTER, VIDEO, videoEntry, request)) as { dez: Record<string, unknown>, note: string }

      expect(result).not.toHaveProperty('providerEntry')
      expect(result).not.toHaveProperty('mediaEntry')
      expect(result.note).toBeTypeOf('string')
      expect(result.dez.cost).toStrictEqual({ usd: 0.02 })
      expect(result.dez.parameters).toHaveLength(3)
    })

    it('sends a stand-in for a local file path in an option and in the media entry', () => {
      const local: ModelInfo = { ...VIDEO, parameters: [{ name: 'voice', label: 'Voice', options: ['/home/alice/voices/a.bin', 'af_alloy'] }] }
      const result = JSON.parse(modelInfoText(OPENROUTER, local, videoEntry, { values: {}, mediaEntry: { root: '/home/alice/acme-bot' } })) as { dez: Record<string, unknown>, mediaEntry: unknown }

      expect(result.dez.parameters).toStrictEqual([{ name: 'voice', label: 'Voice', options: ['/home/…', 'af_alloy'] }])
      expect(result.mediaEntry).toStrictEqual({ root: '/home/…' })
    })
  })

  // A local server can use a file path as the model id, and its entry can
  // hold more paths (vLLM's `root`).
  describe('with local file paths in the provider entry', () => {
    const LOCAL = providerInfo('local', 'Local')
    const path = '/home/alice/acme-bot/llama-3'
    const served: ModelInfo = { id: path, name: path, provider: LOCAL.id }

    it('sends a stand-in for each path of the entry, and keeps the model\'s own id and name', () => {
      const result = modelInfoText(LOCAL, served, { id: path, object: 'model', root: path, parent: null, max_model_len: 8192 })

      expect(JSON.parse(result)).toStrictEqual({
        id: `local/${path}`,
        name: path,
        provider: { id: 'local', name: 'Local' },
        dez: {},
        providerEntry: { id: '/home/…', object: 'model', root: '/home/…', parent: null, max_model_len: 8192 },
      })
    })

    it('counts the stand-ins, not the paths, for the size limit', () => {
      const result = JSON.parse(modelInfoText(LOCAL, served, { root: `${path}/${'x'.repeat(MODEL_INFO_SIZE_CAP)}` })) as Record<string, unknown>

      expect(result.providerEntry).toStrictEqual({ root: '/home/…' })
      expect(result).not.toHaveProperty('note')
    })
  })
})
