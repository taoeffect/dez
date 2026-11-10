import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { MODEL_INFO_SIZE_CAP, modelInfoTarget, modelInfoText } from './modelInfo'

const OPENROUTER = providerInfo('openrouter', 'OpenRouter')
const CLOSED = providerInfo('closed', 'Closed', false)
const FAILING = providerInfo('failing', 'Failing')
const PROVIDERS = [OPENROUTER, CLOSED, FAILING]

// Model ids can hold `/`; provider ids cannot.
const GEMINI: ModelInfo = { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', provider: OPENROUTER.id, imageInput: true, outputs: ['text', 'image'], request: 'chat' }
const UNKNOWN: ModelInfo = { id: 'mystery', name: 'Mystery', provider: OPENROUTER.id }

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
    expect(result.note).toBe('Dez has no entry from the provider for this model now. Try again later.')
  })

  it(`keeps the provider entry up to ${MODEL_INFO_SIZE_CAP} characters, and leaves it out with a note over that`, () => {
    const withPadding = (padding: string) => modelInfoText(OPENROUTER, GEMINI, { ...entry, description: padding })
    const fitting = 'x'.repeat(MODEL_INFO_SIZE_CAP - withPadding('').length)

    expect(withPadding(fitting)).toHaveLength(MODEL_INFO_SIZE_CAP)
    expect(JSON.parse(withPadding(fitting)).providerEntry.description).toBe(fitting)

    const over = JSON.parse(withPadding(`${fitting}x`)) as Record<string, unknown>
    expect(over).not.toHaveProperty('providerEntry')
    expect(over.note).toBe(`providerEntry is left out: with it, the result has ${MODEL_INFO_SIZE_CAP + 1} characters, over the limit of ${MODEL_INFO_SIZE_CAP}.`)
    expect(over.dez).toStrictEqual({ outputs: ['text', 'image'], request: 'chat', imageInput: true })
  })
})
