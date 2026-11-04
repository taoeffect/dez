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

  it('keeps custom provider ids and drops keys that are not valid provider ids', () => {
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        'my-server_2': { models: [], working: true, updatedAt: 0, lastCheckedAt: 0 },
        'ollama/local': { models: [], working: true, updatedAt: 0, lastCheckedAt: 0 },
        '': { models: [], working: true, updatedAt: 0, lastCheckedAt: 0 },
        zai: { models: [], working: false, updatedAt: 1, lastCheckedAt: 2 },
      },
    }))
    expect(Object.keys(parsed.providers)).toEqual(['my-server_2', 'zai'])
    expect(parsed.providers.zai).toEqual({ models: [], working: false, updatedAt: 1, lastCheckedAt: 2 })
  })

  it('drops models whose provider id is not valid', () => {
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        'my-server': {
          models: [
            { id: 'good', name: 'Good', provider: 'my-server' },
            { id: 'bad', name: 'Bad', provider: 'has space' },
          ],
          working: true,
          updatedAt: 0,
          lastCheckedAt: 0,
        },
      },
    }))
    // A model with a bad provider id is dropped individually; the rest of
    // the provider entry is preserved.
    expect(parsed.providers['my-server']?.models).toEqual([
      { id: 'good', name: 'Good', provider: 'my-server' },
    ])
  })

  it('serializes the empty cache with the current version', () => {
    expect(serializeModelCacheJson(emptyModelCache()))
      .toBe(JSON.stringify({ providers: {}, version: MODEL_CACHE_VERSION }, null, 2))
  })
})
