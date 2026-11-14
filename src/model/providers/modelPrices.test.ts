import { describe, expect, it } from 'vitest'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { freshQuote, isFreshPrice, modelTokenPrice, PRICE_LIFETIME_MS, priceText, usdText, withQuote, type PriceQuote } from './modelPrices'

const tokenPrices = (id: string) => BUILT_IN_PROVIDER_CONFIGS.find((config) => config.id === id)?.modelTokenPrices

// Entry shapes of the live model lists (2026-11-13).
describe('chat token prices', () => {
  const openRouter = tokenPrices('openrouter')
  const venice = tokenPrices('venice')
  const usd = (value: number) => ({ usd: value, diem: value })
  const TEXT = ['text'] as const

  it('gives an OpenRouter price per token in USD per 1M tokens, with the cache read price', () => {
    const entry = { id: 'm', pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000025', input_cache_write: '0.000003125' } }

    expect(modelTokenPrice(entry, openRouter, TEXT)).toStrictEqual({ unit: 'token', input: 2.5, output: 10, cachedInput: 0.25 })
  })

  it('gives a Venice price per 1M tokens as it is, and tells that a long prompt has another rate', () => {
    const entry = { id: 'm', model_spec: { pricing: { input: usd(0.5), cache_input: usd(0.05), output: usd(2), extended: { context_token_threshold: 256000, input: usd(1.5), output: usd(6) } } } }

    expect(modelTokenPrice(entry, venice, TEXT)).toStrictEqual({ unit: 'token', input: 0.5, output: 2, cachedInput: 0.05, note: 'base rate; some requests have other rates' })
  })

  it('tells the other rates of an OpenRouter model and the price of its output images, in one note', () => {
    const pricing = { prompt: '0.000002', completion: '0.000012', image_output: '0.00012', overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004' }] }

    expect(modelTokenPrice({ id: 'm', pricing }, openRouter, ['text', 'image'])).toStrictEqual({
      unit: 'token',
      input: 2,
      output: 12,
      note: 'base rate; some requests have other rates; images: $120 per 1M output tokens',
    })
  })

  it('tells the price of the output audio of an OpenRouter voice model', () => {
    const pricing = { prompt: '0.0000006', completion: '0.0000024', audio: '0.0000006', audio_output: '0.0000024' }

    expect(modelTokenPrice({ id: 'openai/gpt-audio-mini', pricing }, openRouter, ['text', 'audio']))
      .toStrictEqual({ unit: 'token', input: 0.6, output: 2.4, note: 'audio: $2.4 per 1M output tokens' })
  })

  it.each([
    ['an empty list of other rates', { overrides: [] }],
    ['no other rates', { overrides: null }],
    ['an image output price of 0', { image_output: '0' }],
  ])('gives no note for %s', (_name, more) => {
    expect(modelTokenPrice({ id: 'm', pricing: { prompt: '0.000001', completion: '0.000002', ...more } }, openRouter, TEXT))
      .toStrictEqual({ unit: 'token', input: 1, output: 2 })
  })

  it.each([
    ['a text model', { prompt: '0', completion: '0' }, TEXT],
    ['a model that makes images, with a price of 0 for them', { prompt: '0', completion: '0', image_output: '0' }, ['text', 'image'] as const],
  ])('gives a price of 0 to a free model: %s', (_name, pricing, outputs) => {
    expect(modelTokenPrice({ id: 'm', pricing }, openRouter, outputs)).toStrictEqual({ unit: 'token', input: 0, output: 0 })
  })

  // OpenRouter's Lyria models list "0" for their tokens, and tell their
  // price per clip only in their description (live, 2026-11-14).
  it.each([['audio'], ['image']] as const)('gives no price to a model with free tokens that makes %s with no price for it', (media) => {
    expect(modelTokenPrice({ id: 'google/lyria-3-clip-preview', pricing: { prompt: '0', completion: '0' } }, openRouter, ['text', media])).toBeUndefined()
  })

  // OpenRouter gives `-1` to a router, whose price is that of the model
  // that it picks.
  it.each([
    ['a router', { prompt: '-1', completion: '-1' }],
    ['no output price', { prompt: '0.000001' }],
    ['a price that is no number', { prompt: 'free', completion: '0' }],
    ['an empty price', { prompt: '', completion: '0' }],
  ])('gives no price for %s', (_name, pricing) => {
    expect(modelTokenPrice({ id: 'm', pricing }, openRouter, TEXT)).toBeUndefined()
  })

  it('gives no price for a provider whose config has no token price paths', () => {
    expect(modelTokenPrice({ id: 'm', pricing: { prompt: '0.000001', completion: '0.000002' } }, undefined, TEXT)).toBeUndefined()
  })
})

describe('price texts', () => {
  // At least 2 decimals, and 3 decimals after the first zeros of a small
  // price; never an exponent.
  it.each([
    [0.1, '$0.10'],
    [3.5, '$3.50'],
    [120, '$120.00'],
    [0.0115, '$0.0115'],
    [0.034, '$0.034'],
    [0.0001, '$0.0001'],
    [0.00000012345, '$0.0000001235'],
    [0, '$0'],
  ])('writes %s USD as %s', (usd, text) => {
    expect(usdText(usd)).toBe(text)
  })

  it('tells the unit of a price and its note', () => {
    expect(priceText({ unit: 'token', input: 0.25, output: 2 })).toBe('$0.25/$2.00 per 1M tokens')
    expect(priceText({ unit: 'character', usd: 30 })).toBe('$30.00 per 1M chars')
    expect(priceText({ unit: 'second', usd: 0.006, note: 'turbo' })).toBe('$0.006 per second (turbo)')
    expect(priceText({ unit: 'image', usd: 0.04 })).toBe('$0.04 per image')
    expect(priceText({ unit: 'clip', usd: 1.2 })).toBe('$1.20 per clip')
  })
})

describe('the quote cache', () => {
  const quote = (values: PriceQuote['values'], at: number, usd = 1): PriceQuote =>
    ({ providerId: 'venice', modelId: 'wan', kind: 'video', values, usd, at })
  const request = { providerId: 'venice', modelId: 'wan', kind: 'video' as const, values: { resolution: '720p', duration: '5s' } }

  // A clock that went back makes a price of the future: a new check is free.
  it('keeps a price fresh for PRICE_LIFETIME_MS, and a price of the future not', () => {
    expect(isFreshPrice(100, 100)).toBe(true)
    expect(isFreshPrice(100, 99 + PRICE_LIFETIME_MS)).toBe(true)
    expect(isFreshPrice(100, 100 + PRICE_LIFETIME_MS)).toBe(false)
    expect(isFreshPrice(100, 99)).toBe(false)
  })

  it('finds the newest fresh quote of the same values in any name order, and only of the same request', () => {
    const quotes = [quote({ duration: '5s', resolution: '720p' }, 10, 2), quote({ resolution: '720p', duration: '5s' }, 20, 3), quote({ resolution: '720p', duration: '5s' }, 5, 4)]
    expect(freshQuote(quotes, request, 30)?.usd).toBe(3)
    expect(freshQuote(quotes, request, 15 + PRICE_LIFETIME_MS)?.usd).toBe(3)
    expect(freshQuote(quotes, request, 20 + PRICE_LIFETIME_MS)).toBeUndefined()
    expect(freshQuote(quotes, { ...request, values: { resolution: '1080p', duration: '5s' } }, 30)).toBeUndefined()
    expect(freshQuote(quotes, { ...request, kind: 'imageToVideo' }, 30)).toBeUndefined()
    expect(freshQuote(quotes, { ...request, modelId: 'other' }, 30)).toBeUndefined()
    expect(freshQuote(quotes, { ...request, providerId: 'openrouter' }, 30)).toBeUndefined()
  })

  it('replaces the quote of the same request and drops the old quotes when it adds one', () => {
    const old = quote({ duration: '8s' }, 0)
    const other = quote({ duration: '10s' }, PRICE_LIFETIME_MS)
    const same = quote({ duration: '5s', resolution: '720p' }, PRICE_LIFETIME_MS)
    const added = quote({ resolution: '720p', duration: '5s' }, PRICE_LIFETIME_MS + 1, 9)
    expect(withQuote([old, other, same], added, PRICE_LIFETIME_MS + 1)).toStrictEqual([other, added])
  })
})
