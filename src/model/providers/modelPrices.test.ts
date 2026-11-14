import { describe, expect, it } from 'vitest'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { modelTokenPrice } from './modelPrices'

const tokenPrices = (id: string) => BUILT_IN_PROVIDER_CONFIGS.find((config) => config.id === id)?.modelTokenPrices

// Entry shapes of the live model lists (2026-11-13).
describe('chat token prices', () => {
  const openRouter = tokenPrices('openrouter')
  const venice = tokenPrices('venice')
  const usd = (value: number) => ({ usd: value, diem: value })

  it('gives an OpenRouter price per token in USD per 1M tokens, with the cache read price', () => {
    const entry = { id: 'm', pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000025', input_cache_write: '0.000003125' } }

    expect(modelTokenPrice(entry, openRouter)).toStrictEqual({ unit: 'token', input: 2.5, output: 10, cachedInput: 0.25 })
  })

  it('gives a Venice price per 1M tokens as it is, and tells that a long prompt has another rate', () => {
    const entry = { id: 'm', model_spec: { pricing: { input: usd(0.5), cache_input: usd(0.05), output: usd(2), extended: { context_token_threshold: 256000, input: usd(1.5), output: usd(6) } } } }

    expect(modelTokenPrice(entry, venice)).toStrictEqual({ unit: 'token', input: 0.5, output: 2, cachedInput: 0.05, note: 'base rate; some requests have other rates' })
  })

  it('tells the other rates of an OpenRouter model and the price of its output images, in one note', () => {
    const pricing = { prompt: '0.000002', completion: '0.000012', image_output: '0.00012', overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004' }] }

    expect(modelTokenPrice({ id: 'm', pricing }, openRouter)).toStrictEqual({
      unit: 'token',
      input: 2,
      output: 12,
      note: 'base rate; some requests have other rates; images: $120 per 1M output tokens',
    })
  })

  it.each([
    ['an empty list of other rates', { overrides: [] }],
    ['no other rates', { overrides: null }],
    ['an image output price of 0', { image_output: '0' }],
  ])('gives no note for %s', (_name, more) => {
    expect(modelTokenPrice({ id: 'm', pricing: { prompt: '0.000001', completion: '0.000002', ...more } }, openRouter))
      .toStrictEqual({ unit: 'token', input: 1, output: 2 })
  })

  it('gives a free model a price of 0', () => {
    expect(modelTokenPrice({ id: 'm', pricing: { prompt: '0', completion: '0' } }, openRouter)).toStrictEqual({ unit: 'token', input: 0, output: 0 })
  })

  // OpenRouter gives `-1` to a router, whose price is that of the model
  // that it picks.
  it.each([
    ['a router', { prompt: '-1', completion: '-1' }],
    ['no output price', { prompt: '0.000001' }],
    ['a price that is no number', { prompt: 'free', completion: '0' }],
    ['an empty price', { prompt: '', completion: '0' }],
  ])('gives no price for %s', (_name, pricing) => {
    expect(modelTokenPrice({ id: 'm', pricing }, openRouter)).toBeUndefined()
  })

  it('gives no price for a provider whose config has no token price paths', () => {
    expect(modelTokenPrice({ id: 'm', pricing: { prompt: '0.000001', completion: '0.000002' } }, undefined)).toBeUndefined()
  })
})
