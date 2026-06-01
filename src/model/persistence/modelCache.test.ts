import { describe, expect, it } from 'vitest'
import { emptyModelCache, MODEL_CACHE_VERSION, parseModelCacheJson, serializeModelCacheJson } from './modelCache'

describe('model cache persistence format', () => {
  it('falls back to an empty cache when JSON is malformed', () => {
    expect(parseModelCacheJson('{')).toEqual(emptyModelCache())
  })

  it('falls back to an empty cache for non-object JSON', () => {
    expect(parseModelCacheJson('[]')).toEqual(emptyModelCache())
  })

  it('parses valid providers and round-trips', () => {
    const cache = {
      version: MODEL_CACHE_VERSION,
      providers: {
        openrouter: {
          models: [{ id: 'm1', name: 'Model 1', provider: 'openrouter' }],
          working: true,
          updatedAt: 100,
          lastCheckedAt: 200,
        },
      },
    }
    const parsed = parseModelCacheJson(JSON.stringify(cache))
    expect(parsed).toEqual(cache)
    expect(serializeModelCacheJson(parsed)).toBe(JSON.stringify(parsed, null, 2))
  })

  it('drops unknown providers', () => {
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        bogus: { models: [], working: true, updatedAt: 0, lastCheckedAt: 0 },
        zai: { models: [], working: false, updatedAt: 1, lastCheckedAt: 2 },
      },
    }))
    expect(Object.keys(parsed.providers)).toEqual(['zai'])
    expect(parsed.providers.zai).toEqual({ models: [], working: false, updatedAt: 1, lastCheckedAt: 2 })
  })

  it('drops models referencing unknown providers', () => {
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        openrouter: {
          models: [
            { id: 'good', name: 'Good', provider: 'openrouter' },
            { id: 'bad', name: 'Bad', provider: 'nope' },
          ],
          working: true,
          updatedAt: 0,
          lastCheckedAt: 0,
        },
      },
    }))
    // A model with an unknown provider is dropped individually; the rest of
    // the provider entry is preserved.
    expect(parsed.providers.openrouter?.models).toEqual([
      { id: 'good', name: 'Good', provider: 'openrouter' },
    ])
  })

  it('serializes the empty cache with the current version', () => {
    expect(serializeModelCacheJson(emptyModelCache()))
      .toBe(JSON.stringify({ providers: {}, version: MODEL_CACHE_VERSION }, null, 2))
  })
})
