import { describe, expect, it } from 'vitest'
import { chatRequestCost } from './chatUsage'
import type { ModelPrice } from './modelPrices'

describe('the price of a chat request', () => {
  const price: ModelPrice = { unit: 'token', input: 3, output: 15, cachedInput: 0.3 }
  const usage = { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500 }

  it('takes the provider\'s own price over the list price, a free request too', () => {
    expect(chatRequestCost({ ...usage, providerCost: 0.0021 }, price)).toBe(0.0021)
    expect(chatRequestCost({ ...usage, providerCost: 0 }, price)).toBe(0)
  })

  it('prices the cached input tokens at the cached rate, and at the input rate when the list has none', () => {
    expect(chatRequestCost(usage, price)).toBe(0.00942)
    expect(chatRequestCost(usage, { unit: 'token', input: 3, output: 15 })).toBe(0.0105)
  })

  it('knows no price with no usage, no list price, a price in another unit, or a count missing', () => {
    expect(chatRequestCost(undefined, price)).toBeUndefined()
    expect(chatRequestCost(usage, undefined)).toBeUndefined()
    expect(chatRequestCost(usage, { unit: 'character', usd: 3.5 })).toBeUndefined()
    expect(chatRequestCost({ inputTokens: 1000 }, price)).toBeUndefined()
  })
})
