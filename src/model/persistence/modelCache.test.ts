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
      { id: 'listen', name: 'Listen', provider: 'venice', outputs: ['text'], request: 'transcription' },
      // A cache written before outputs and request kinds existed.
      { id: 'old', name: 'Old', provider: 'venice' },
    ]
    // A cache of an older Dez told the clip that a model with no request
    // needed; the next model check gives the model its request.
    const oldClipInput = { id: 'old-listen', name: 'Old listen', provider: 'venice', outputs: ['text'], request: 'none' }
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            ...models,
            { id: 'new-output', name: 'New output', provider: 'venice', outputs: ['text', 'embedding'] },
            { id: 'new-request', name: 'New request', provider: 'venice', request: 'speech' },
            { ...oldClipInput, clipInput: 'audio' },
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models).toStrictEqual([...models, oldClipInput])
    expect(parseModelCacheJson(serializeModelCacheJson(parsed))).toStrictEqual(parsed)
  })

  it('round-trips the parameters, text rules, image rules, clip rules, and unstored file type of a model, and drops only a model whose data is not valid', () => {
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
      { id: 'frames', name: 'Frames', provider: 'venice', request: 'imageToVideo', images: { maxImages: 2 } },
      {
        id: 'sized',
        name: 'Sized',
        provider: 'venice',
        request: 'imageToVideo',
        images: { maxImages: 2, size: { minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 } },
      },
      { id: 'styles', name: 'Styles', provider: 'venice', request: 'image', images: { maxImages: 1, minImages: 1 }, unstoredOutput: 'SVG' },
      { id: 'references', name: 'References', provider: 'venice', request: 'imageToVideo', images: { maxImages: 7, references: { promptName: '@Image{n}' } } },
      {
        id: 'frames-or-references',
        name: 'Frames or references',
        provider: 'venice',
        request: 'video',
        images: { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, references: {} } } },
      },
      {
        id: 'clip-references',
        name: 'Clip references',
        provider: 'venice',
        request: 'video',
        clips: {
          audio: { use: 'reference', maxClips: 3, minSeconds: 0.5, maxSeconds: 15, maxTotalSeconds: 15, maxBytes: 15_000_000, types: ['audio/wav', 'audio/mpeg'], promptName: '@Audio{n}' },
          // One length only: the least length is the most length.
          video: { use: 'reference', maxClips: 3, minSeconds: 2, maxSeconds: 2, maxBytes: 50_000_000, types: ['video/mp4'] },
          audioNeedsVisual: true,
        },
      },
      { id: 'voices', name: 'Voices', provider: 'venice', request: 'video', clips: { audio: { use: 'voice', types: ['audio/wav'] } } },
      { id: 'by-address', name: 'By address', provider: 'venice', request: 'video', clips: { audio: { use: 'reference', urlOnly: true }, video: { use: 'reference', urlOnly: true } } },
      { id: 'soundtrack', name: 'Soundtrack', provider: 'venice', request: 'imageToVideo', clips: { audio: { use: 'background', maxClips: 1, maxSeconds: 30 } } },
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
            { id: 'no-frame', name: 'No frame', provider: 'venice', images: { maxImages: 0 } },
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

  it('drops a size rule or a fewest count of the input images that is not valid, and keeps the model and its other rules', () => {
    const model = (id: string, size: unknown, minImages?: unknown) => ({ id, name: id, provider: 'venice', request: 'imageToVideo', images: { maxImages: 2, size, minImages } })
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            model('one-bad', { minShortSide: -5, maxAspectRatio: 2.5 }),
            model('all-bad', { minShortSide: 'wide', maxPixels: 1.5 }),
            model('no-object', 300),
            model('ratios-apart', { minAspectRatio: 2.5, maxAspectRatio: 0.4, minShortSide: 240 }),
            model('more-than-most', undefined, 3),
            model('part-image', undefined, 1.5),
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models.map(({ id, images }) => [id, images])).toStrictEqual([
      ['one-bad', { maxImages: 2, size: { maxAspectRatio: 2.5 } }],
      ['all-bad', { maxImages: 2 }],
      ['no-object', { maxImages: 2 }],
      ['ratios-apart', { maxImages: 2, size: { minShortSide: 240 } }],
      ['more-than-most', { maxImages: 2 }],
      ['part-image', { maxImages: 2 }],
    ])
  })

  it('drops a prompt name with no number or a parameter rule that is not valid, and keeps the model and its other rules', () => {
    const model = (id: string, images: Record<string, unknown>) => ({ id, name: id, provider: 'venice', request: 'video', images: { maxImages: 2, ...images } })
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            model('no-number', { references: { promptName: '@Image' } }),
            model('name-not-text', { references: { promptName: 1 } }),
            model('no-name', { whenParameter: { value: 'references', rules: { maxImages: 16 } } }),
            model('bad-value', { whenParameter: { name: 'images_as', value: true, rules: { maxImages: 16 } } }),
            model('no-count', { whenParameter: { name: 'images_as', value: 'references', rules: { references: {} } } }),
            // A bad part of the other rules is dropped alone, as in the
            // model's own rules.
            model('bad-name-inside', { whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, references: { promptName: '@Image' } } } }),
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models.map(({ id, images }) => [id, images])).toStrictEqual([
      ['no-number', { maxImages: 2, references: {} }],
      ['name-not-text', { maxImages: 2, references: {} }],
      ['no-name', { maxImages: 2 }],
      ['bad-value', { maxImages: 2 }],
      ['no-count', { maxImages: 2 }],
      ['bad-name-inside', { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, references: {} } } }],
    ])
  })

  it('drops a clip rule that is not valid alone, and keeps the model, the kind, and its other rules', () => {
    const model = (id: string, audio: Record<string, unknown>) => ({ id, name: id, provider: 'venice', request: 'video', clips: { audio: { use: 'reference', maxSeconds: 10, ...audio } } })
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            model('no-count', { maxClips: 0 }),
            model('part-count', { maxClips: 1.5 }),
            model('type-not-text', { types: ['audio/wav', 3] }),
            model('no-types', { types: [] }),
            model('least-above-most', { minSeconds: 20 }),
            model('no-number', { promptName: '@Audio' }),
            model('url-only-not-true', { urlOnly: 'yes' }),
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    const kept = { audio: { use: 'reference', maxSeconds: 10 } }
    expect(parsed.providers.venice?.models.map(({ id, clips }) => [id, clips])).toStrictEqual([
      ['no-count', kept],
      ['part-count', kept],
      ['type-not-text', kept],
      ['no-types', kept],
      ['least-above-most', kept],
      ['no-number', kept],
      ['url-only-not-true', kept],
    ])
  })

  it('drops a clip kind that is not valid alone, and keeps the model and its other kind', () => {
    const video = { use: 'reference', maxClips: 2 }
    const model = (id: string, clips: Record<string, unknown>) => ({ id, name: id, provider: 'venice', request: 'video', clips })
    const parsed = parseModelCacheJson(JSON.stringify({
      version: MODEL_CACHE_VERSION,
      providers: {
        venice: {
          models: [
            model('unknown-use', { audio: { use: 'lipsync', maxClips: 1 }, video }),
            model('no-object', { audio: 'wav', video }),
            // The rule of the audio clips goes with them.
            model('needs-visual', { audio: { use: 'lipsync' }, video, audioNeedsVisual: true }),
            // As a model with no clip rules, it takes no clip.
            model('no-kind', { audio: { use: 'lipsync' }, audioNeedsVisual: true }),
          ],
          working: true,
          updatedAt: 1,
          lastCheckedAt: 2,
        },
      },
    }))

    expect(parsed.providers.venice?.models.map((model) => [model.id, 'clips' in model ? model.clips : 'no field'])).toStrictEqual([
      ['unknown-use', { video }],
      ['no-object', { video }],
      ['needs-visual', { video }],
      ['no-kind', 'no field'],
    ])
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
