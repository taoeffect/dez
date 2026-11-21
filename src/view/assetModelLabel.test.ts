import { describe, expect, it } from 'vitest'
import { displayNames as names } from '../model/providers/testing'
import { assetModelLabel, assetModelTexts, sameAssetModelLabel } from './assetModelLabel'

const MODEL = { providerId: 'openrouter', modelId: 'openai/gpt-image-1' }
const KEY = 'openrouter/openai/gpt-image-1'

describe('assetModelLabel', () => {
  it('gives no label for an asset that no known model made', () => {
    expect(assetModelLabel(null, names({ [KEY]: 'GPT Image' }))).toBeNull()
  })

  it('gives the model name and the provider name, with the id and the pretty name for the tooltip', () => {
    expect(assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))).toStrictEqual({
      key: KEY,
      name: 'GPT Image',
      tooltipName: 'openai/gpt-image-1 (GPT Image)',
      providerName: 'OpenRouter',
    })
  })

  it('takes the readable name for the tooltip over the shown name', () => {
    expect(assetModelLabel(MODEL, names({ [KEY]: 'openai/gpt-image-1' }, {}, { [KEY]: 'GPT Image 1' }))?.tooltipName).toBe('openai/gpt-image-1 (GPT Image 1)')
  })

  it('falls back to the model id, and has no provider name for an unknown provider', () => {
    expect(assetModelLabel(MODEL, names())).toStrictEqual({ key: KEY, name: 'openai/gpt-image-1', tooltipName: 'openai/gpt-image-1', providerName: null })
  })
})

describe('sameAssetModelLabel', () => {
  const label = assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))

  it('tells a label that the names changed from the label before', () => {
    expect(sameAssetModelLabel(label, assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' })))).toBe(true)
    expect(sameAssetModelLabel(label, assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' })))).toBe(false)
    expect(sameAssetModelLabel(label, assetModelLabel(MODEL, names({}, { openrouter: 'OpenRouter' })))).toBe(false)
  })

  it('tells a label from no label', () => {
    expect(sameAssetModelLabel(null, null)).toBe(true)
    expect(sameAssetModelLabel(label, null)).toBe(false)
    expect(sameAssetModelLabel(null, label)).toBe(false)
  })
})

describe('assetModelTexts', () => {
  it('tells the facts of the agent pill: the id with the pretty name, the provider, and the key', () => {
    const label = assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))!
    expect(assetModelTexts(label, 'video')).toStrictEqual({
      title: 'Model that made this video',
      lines: ['openai/gpt-image-1 (GPT Image)', 'OpenRouter', KEY],
      ariaLabel: 'Made by openai/gpt-image-1 (GPT Image), provider: OpenRouter',
    })
  })

  it('names an unknown provider', () => {
    const label = assetModelLabel(MODEL, names())!
    expect(assetModelTexts(label, 'image')).toMatchObject({ lines: ['openai/gpt-image-1', 'Unknown provider', KEY], ariaLabel: 'Made by openai/gpt-image-1, provider: Unknown provider' })
  })
})
