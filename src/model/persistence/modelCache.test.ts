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

  it('round-trips capability flags and reads a model without one as unknown', () => {
    const models = [
      { id: 'vision', name: 'Vision', provider: 'venice', imageInput: true, toolCalling: true, thinking: true },
      { id: 'text', name: 'Text', provider: 'venice', imageInput: false, toolCalling: false, thinking: false, unsupportedSettings: ['xSearch'] },
      // A cache written before the thinking flag and the unsupported toggles
      // existed.
      { id: 'tools-only', name: 'Tools only', provider: 'venice', imageInput: true, toolCalling: true },
      // A cache written before the tool flag existed.
      { id: 'image-only', name: 'Image only', provider: 'venice', imageInput: true },
      // A cache written before the flags existed.
      { id: 'old', name: 'Old', provider: 'venice' },
    ]
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: { venice: { models, working: true, updatedAt: 1, lastCheckedAt: 2 } },
    }))

    expect(parsed.providers.venice?.models).toStrictEqual(models)
    expect(parseModelCacheJson(serializeModelCacheJson(parsed))).toStrictEqual(parsed)
  })

  it('round-trips outputs and request kinds, and drops only a model with an unknown one', () => {
    const models = [
      { id: 'edit', name: 'Edit', provider: 'venice', outputs: ['image'], request: 'imageEdit' },
      { id: 'chat', name: 'Chat', provider: 'venice', imageInput: true, outputs: ['text', 'image'], request: 'chat' },
      // Known to make none of the types.
      { id: 'embed', name: 'Embed', provider: 'venice', outputs: [], request: 'none' },
      // A cache written before outputs and request kinds existed.
      { id: 'old', name: 'Old', provider: 'venice' },
    ]
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            ...models,
            { id: 'new-output', name: 'New output', provider: 'venice', outputs: ['text', 'embedding'] },
            { id: 'new-request', name: 'New request', provider: 'venice', request: 'speech' },
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models).toStrictEqual(models)
    expect(parseModelCacheJson(serializeModelCacheJson(parsed))).toStrictEqual(parsed)
  })

  it('round-trips the parameters, text rules, and image rules of a model, and drops only a model whose data is not valid', () => {
    const models = [
      {
        id: 'film',
        name: 'Film',
        provider: 'venice',
        request: 'video',
        parameters: [
          { name: 'duration', label: 'Length', options: ['5s', '10s'], default: '5s' },
          { name: 'seconds', label: 'Length (seconds)', options: [1, 5] },
          { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5 },
          { name: 'steps', label: 'Steps', min: 1, max: 8 },
          { name: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05, default: 1 },
          { name: 'loop', label: 'Loop' },
          { name: 'enhance', label: 'Enhance', default: true },
        ],
      },
      {
        id: 'song',
        name: 'Song',
        provider: 'venice',
        request: 'music',
        text: { minPromptLength: 10, maxPromptLength: 300, lyrics: { required: true, maxLength: 3000 } },
      },
      { id: 'sound', name: 'Sound', provider: 'venice', request: 'music', text: { lyrics: { required: false } } },
      { id: 'frames', name: 'Frames', provider: 'venice', request: 'imageToVideo', images: { maxFrames: 2 } },
      // A cache written before parameters existed.
      { id: 'old', name: 'Old', provider: 'venice', request: 'video' },
    ]
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            ...models,
            { id: 'no-options', name: 'No options', provider: 'venice', parameters: [{ name: 'voice', label: 'Voice', options: [] }] },
            { id: 'bad-option', name: 'Bad option', provider: 'venice', parameters: [{ name: 'loop', label: 'Loop', options: [true, false] }] },
            { id: 'half-range', name: 'Half range', provider: 'venice', parameters: [{ name: 'seconds', label: 'Length', min: 1 }] },
            { id: 'no-list', name: 'No list', provider: 'venice', parameters: { name: 'voice', label: 'Voice', options: ['a'] } },
            { id: 'no-step', name: 'No step', provider: 'venice', parameters: [{ name: 'speed', label: 'Speed', min: 1, max: 2, step: 0 }] },
            { id: 'bad-switch', name: 'Bad switch', provider: 'venice', parameters: [{ name: 'loop', label: 'Loop', default: 'on' }] },
            { id: 'bad-limit', name: 'Bad limit', provider: 'venice', text: { maxPromptLength: -1 } },
            { id: 'bad-lyrics', name: 'Bad lyrics', provider: 'venice', text: { lyrics: true } },
            { id: 'no-frame', name: 'No frame', provider: 'venice', images: { maxFrames: 0 } },
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models).toStrictEqual(models)
    expect(parseModelCacheJson(serializeModelCacheJson(parsed))).toStrictEqual(parsed)
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
