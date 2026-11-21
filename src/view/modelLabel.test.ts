import { describe, expect, it } from 'vitest'
import { displayNames as names } from '../model/providers/testing'
import { modelFactLines, modelFacts, sameModelFacts } from './modelLabel'

const MODEL = { providerId: 'openrouter', modelId: 'openai/gpt-image-1' }
const KEY = 'openrouter/openai/gpt-image-1'

describe('modelFacts', () => {
  it('gives the model name and the provider name, with the id and the pretty name for the tooltip', () => {
    expect(modelFacts(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))).toStrictEqual({
      key: KEY,
      name: 'GPT Image',
      tooltipName: 'openai/gpt-image-1 (GPT Image)',
      providerName: 'OpenRouter',
    })
  })

  it('takes the readable name for the tooltip over the shown name', () => {
    expect(modelFacts(MODEL, names({ [KEY]: 'openai/gpt-image-1' }, {}, { [KEY]: 'GPT Image 1' })).tooltipName).toBe('openai/gpt-image-1 (GPT Image 1)')
  })

  it('falls back to the model id, and has no provider name for an unknown provider', () => {
    expect(modelFacts(MODEL, names())).toStrictEqual({ key: KEY, name: 'openai/gpt-image-1', tooltipName: 'openai/gpt-image-1', providerName: null })
  })
})

describe('sameModelFacts', () => {
  const facts = modelFacts(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))

  it('tells facts that the names changed from the facts before', () => {
    expect(sameModelFacts(facts, modelFacts(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' })))).toBe(true)
    expect(sameModelFacts(facts, modelFacts(MODEL, names({ [KEY]: 'GPT Image' })))).toBe(false)
    expect(sameModelFacts(facts, modelFacts(MODEL, names({}, { openrouter: 'OpenRouter' })))).toBe(false)
    expect(sameModelFacts(facts, modelFacts(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }, { [KEY]: 'GPT Image 1' })))).toBe(false)
  })

  it('tells facts from no facts', () => {
    expect(sameModelFacts(null, null)).toBe(true)
    expect(sameModelFacts(facts, null)).toBe(false)
    expect(sameModelFacts(null, facts)).toBe(false)
  })
})

describe('modelFactLines', () => {
  it('gives the id with the pretty name, the provider, and the key', () => {
    expect(modelFactLines(modelFacts(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' })))).toStrictEqual(['openai/gpt-image-1 (GPT Image)', 'OpenRouter', KEY])
  })

  it('names an unknown provider', () => {
    expect(modelFactLines(modelFacts(MODEL, names()))).toStrictEqual(['openai/gpt-image-1', 'Unknown provider', KEY])
  })
})
