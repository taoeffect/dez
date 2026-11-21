import { describe, expect, it } from 'vitest'
import { displayNames as names } from '../model/providers/testing'
import { assetModelLabel, assetModelTexts } from './assetModelLabel'

const MODEL = { providerId: 'openrouter', modelId: 'openai/gpt-image-1' }
const KEY = 'openrouter/openai/gpt-image-1'

describe('assetModelLabel', () => {
  it('gives no label for an asset that no known model made', () => {
    expect(assetModelLabel(null, names({ [KEY]: 'GPT Image' }))).toBeNull()
  })
})

describe('assetModelTexts', () => {
  it('tells the facts of the agent pill: the id with the pretty name, the provider, and the key', () => {
    const label = assetModelLabel(MODEL, names({ [KEY]: 'GPT Image' }, { openrouter: 'OpenRouter' }))!
    expect(assetModelTexts(label, 'video')).toStrictEqual({
      title: 'Model that made this video clip',
      lines: ['openai/gpt-image-1 (GPT Image)', 'OpenRouter', KEY],
      ariaLabel: 'Made by openai/gpt-image-1 (GPT Image), Provider: OpenRouter',
    })
  })

  it('names an unknown provider, and an image as no clip', () => {
    const label = assetModelLabel(MODEL, names())!
    expect(assetModelTexts(label, 'image')).toMatchObject({ title: 'Model that made this image', lines: ['openai/gpt-image-1', 'Unknown provider', KEY], ariaLabel: 'Made by openai/gpt-image-1, Provider: Unknown provider' })
  })
})
