import { describe, expect, it } from 'vitest'
import { matchesInputFilter, modelInputs, type ModelInputFacts } from './modelInputs'
import type { ModelOutput } from './modelOutputs'

describe('modelInputs', () => {
  it.each<[string, ModelInputFacts, ModelOutput[]]>([
    ['a chat model whose image input is unknown', {}, ['text', 'image']],
    ['a chat model that reads images', { request: 'chat', imageInput: true }, ['text', 'image']],
    ['a chat model that reads no images', { request: 'chat', imageInput: false }, ['text']],
    // Dez sends a chat model only text and images.
    ['a chat model with clip rules', { request: 'chat', clips: { audio: { use: 'reference' } } }, ['text', 'image']],
    ['an image model with no image rules', { request: 'image' }, ['text']],
    ['an image model that takes references', { request: 'image', images: { maxImages: 4 } }, ['text', 'image']],
    ['an edit model with no image rules', { request: 'imageEdit' }, ['text', 'image']],
    ['an upscale model', { request: 'upscale' }, ['image']],
    ['a speech model', { request: 'tts' }, ['text']],
    ['an image-to-video model with no rules', { request: 'imageToVideo' }, ['text', 'image']],
    [
      'a video model with references, a reference clip, and background audio',
      { request: 'video', images: { maxImages: 4 }, clips: { audio: { use: 'background', maxClips: 1 }, video: { use: 'reference' } } },
      ['text', 'image', 'audio', 'video'],
    ],
    ['a video-to-video model', { request: 'videoToVideo', clips: { video: { use: 'source', maxClips: 1 } } }, ['text', 'video']],
    ['a voice changer', { request: 'voiceChange', clips: { audio: { use: 'source', maxClips: 1 } } }, ['audio']],
    ['a transcription model', { request: 'transcription', clips: { audio: { use: 'source', maxClips: 1 } } }, ['audio']],
  ])('gives %s what Dez sends it', (_name, model, inputs) => {
    expect(modelInputs(model)).toStrictEqual(inputs)
  })

  // A message to a model that reads no images carries none; only a kind
  // that needs exactly one image then gets the newest image of the
  // conversation (`mediaRequestInput`).
  it('gives a media model that reads no images an image only when its kind needs exactly one', () => {
    expect(modelInputs({ request: 'video', imageInput: false, images: { maxImages: 2 } })).toStrictEqual(['text'])
    expect(modelInputs({ request: 'imageEdit', imageInput: false })).toStrictEqual(['text', 'image'])
    expect(modelInputs({ request: 'imageEdit', imageInput: false, images: { maxImages: 3, minImages: 2 } })).toStrictEqual(['text'])
  })

  it('gives nothing to a model that Dez sends no request', () => {
    expect(modelInputs({ request: 'none', imageInput: true })).toStrictEqual([])
    expect(modelInputs({ request: 'image', images: { maxImages: 2 }, unstoredOutput: 'TIFF' })).toStrictEqual([])
  })
})

describe('matchesInputFilter', () => {
  const video: ModelInputFacts = { request: 'video', clips: { audio: { use: 'reference' }, video: { use: 'reference' } } }
  const voice: ModelInputFacts = { request: 'voiceChange', clips: { audio: { use: 'source' } } }
  const none: ModelInputFacts = { request: 'none' }

  it('matches every model with an empty filter, else a model that takes each of its types', () => {
    for (const model of [video, voice, none]) expect(matchesInputFilter(model, [])).toBe(true)
    expect(matchesInputFilter(video, ['audio', 'video'])).toBe(true)
    expect(matchesInputFilter(voice, ['audio'])).toBe(true)
    expect(matchesInputFilter(voice, ['audio', 'video'])).toBe(false)
    expect(matchesInputFilter(none, ['text'])).toBe(false)
  })
})
