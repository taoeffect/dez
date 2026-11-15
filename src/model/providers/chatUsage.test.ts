import { describe, expect, it } from 'vitest'
import { chatRequestCost, failedChatRequestCost, inputTokenParts } from './chatUsage'
import { ProviderHttpError, ProviderRequestError } from './errors'
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

  it('prices the tokens that went into the cache at the cache write rate, and at the input rate when the list has none', () => {
    const written = { ...usage, cacheWriteTokens: 200 }

    // 400 uncached at $3, 400 read at $0.30, 200 written at $3.75, and 500 output at $15, per 1M.
    expect(chatRequestCost(written, { ...price, cacheWrite: 3.75 })).toBe(0.00957)
    expect(chatRequestCost(written, price)).toBe(0.00942)
  })

  it('never prices a cache write under the input rate', () => {
    expect(chatRequestCost({ ...usage, cacheWriteTokens: 200 }, { ...price, cacheWrite: 0.25 })).toBe(0.00942)
  })

  it('knows no price with no usage, no list price, a price in another unit, or a count missing', () => {
    expect(chatRequestCost(undefined, price)).toBeUndefined()
    expect(chatRequestCost(usage, undefined)).toBeUndefined()
    expect(chatRequestCost(usage, { unit: 'character', usd: 3.5 })).toBeUndefined()
    expect(chatRequestCost({ inputTokens: 1000 }, price)).toBeUndefined()
  })
})

describe('the parts of the input tokens', () => {
  it('gives the tokens that the cache gave, the ones that went into it, and the rest', () => {
    expect(inputTokenParts({ inputTokens: 1000, cachedInputTokens: 400, cacheWriteTokens: 250 })).toStrictEqual({ uncached: 350, cacheRead: 400, cacheWrite: 250 })
    expect(inputTokenParts({ inputTokens: 1000 })).toStrictEqual({ uncached: 1000, cacheRead: 0, cacheWrite: 0 })
  })

  it('cuts a part that is larger than what is left of the input count, the reads first', () => {
    expect(inputTokenParts({ inputTokens: 1000, cachedInputTokens: 900, cacheWriteTokens: 300 })).toStrictEqual({ uncached: 0, cacheRead: 900, cacheWrite: 100 })
    expect(inputTokenParts({ inputTokens: 1000, cachedInputTokens: 1200, cacheWriteTokens: 300 })).toStrictEqual({ uncached: 0, cacheRead: 1000, cacheWrite: 0 })
  })

  it('has no parts with no input count', () => {
    expect(inputTokenParts(undefined)).toBeUndefined()
    expect(inputTokenParts({ outputTokens: 5, cachedInputTokens: 400 })).toBeUndefined()
  })
})

describe('the price of a failed chat request', () => {
  const refusal = new ProviderHttpError('venice', 429, true, '', undefined, 'Venice refused the request.', 'Venice refused the request.')

  it('is 0 for a request that the provider refused with an HTTP status, also as the cause of the error for a model', () => {
    expect(failedChatRequestCost(refusal)).toBe(0)
    expect(failedChatRequestCost(new ProviderRequestError('Venice refused the request.', 'Venice refused the call.', '', { cause: refusal }))).toBe(0)
  })

  // The provider can have made a part of the answer.
  it('is unknown for a request that broke off or stopped', () => {
    expect(failedChatRequestCost(new ProviderRequestError('The connection to Venice broke.', 'The connection broke.'))).toBeNull()
    expect(failedChatRequestCost(new DOMException('Aborted', 'AbortError'))).toBeNull()
  })
})
