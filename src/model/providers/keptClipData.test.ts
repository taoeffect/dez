import { describe, expect, it } from 'vitest'
import { withKeptClipData } from './keptClipData'
import type { ModelInfo } from './types'

describe('withKeptClipData', () => {
  const lengths = [{ name: 'duration', label: 'Length (seconds)', options: [4, 8], default: 4 }]
  const voices = [{ name: 'voice', label: 'Voice', options: ['alloy', 'bella'], default: 'alloy' }]
  const text = { maxPromptLength: 300 }
  const images = { maxImages: 2 }
  const clips = { audio: { use: 'background' as const, maxClips: 1 } }
  const model = (id: string, fields: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, provider: 'p', ...fields })

  it('gives a model the parameters, text rules, image rules, and clip rules that the cache has and the new list lacks', () => {
    const cached = [model('film', { request: 'video', parameters: lengths, text, images, clips })]

    expect(withKeptClipData([model('film', { request: 'video' })], cached))
      .toStrictEqual([model('film', { request: 'video', parameters: lengths, text, images, clips })])
  })

  // Else a request would go to it after a failed image list, and the
  // provider would bill an image that Dez cannot store.
  it('gives an image model the file type that Dez cannot store, which the cache has and the new list lacks', () => {
    const cached = [model('vector', { request: 'image', images, unstoredOutput: 'SVG' })]

    expect(withKeptClipData([model('vector', { request: 'image' })], cached)).toStrictEqual(cached)
  })

  // The voices of a speech model come from the provider's own list, which
  // did load.
  it('lets the data of the new list win, field by field', () => {
    const cached = [model('speech', { request: 'tts', parameters: lengths, text, images })]
    const fresh = model('speech', { request: 'tts', parameters: voices })

    expect(withKeptClipData([fresh], cached)).toStrictEqual([model('speech', { request: 'tts', parameters: voices, text, images })])
  })

  it('keeps the new name and flags of a model, and the order of the new list', () => {
    const cached = [model('film', { name: 'Old name', request: 'video', toolCalling: true, parameters: lengths }), model('gone', { request: 'video', parameters: lengths })]
    const fresh = [model('chat'), model('film', { name: 'New name', request: 'video', imageInput: false })]

    expect(withKeptClipData(fresh, cached)).toStrictEqual([
      model('chat'),
      model('film', { name: 'New name', request: 'video', imageInput: false, parameters: lengths }),
    ])
  })

  // The parameters of another request kind are not fields of its request.
  it.each([
    ['another request kind', model('m', { request: 'imageToVideo' }), model('m', { request: 'video', parameters: lengths })],
    ['a request kind where it had none', model('m', { request: 'video' }), model('m', { parameters: lengths })],
    ['no request any more', model('m', { request: 'none' }), model('m', { request: 'video', parameters: lengths })],
    ['another id', model('m', { request: 'video' }), model('other', { request: 'video', parameters: lengths })],
  ])('keeps nothing for a model that now has %s', (_name, fresh, cached) => {
    expect(withKeptClipData([fresh], [cached])).toStrictEqual([fresh])
  })

  it('keeps nothing when the cache has no model', () => {
    const fresh = [model('film', { request: 'video' })]

    expect(withKeptClipData(fresh, [])).toStrictEqual(fresh)
  })
})
