import { describe, expect, it } from 'vitest'
import {
  effectiveOutputs,
  matchesOutputFilter,
  normalizeOutputs,
  outputLetters,
  parseOutputTypes,
  toggleOutputFilter,
  type ModelOutput,
} from './modelOutputs'

describe('model outputs', () => {
  it('writes the letters in table order, whatever the list order', () => {
    expect(outputLetters(['video', 'text', 'image'])).toBe('t,i,v')
    expect(outputLetters(['audio'])).toBe('a')
    expect(outputLetters([])).toBe('')
  })

  it('reads type ids with any case, commas, and white space, in table order and once each', () => {
    expect(parseOutputTypes('image,video')).toStrictEqual({ ok: true, types: ['image', 'video'] })
    expect(parseOutputTypes(' Video, image ,\tAUDIO ')).toStrictEqual({ ok: true, types: ['image', 'audio', 'video'] })
    expect(parseOutputTypes('text image audio video')).toStrictEqual({ ok: true, types: ['text', 'image', 'audio', 'video'] })
    expect(parseOutputTypes('image,Image')).toStrictEqual({ ok: true, types: ['image'] })
    expect(parseOutputTypes(' , ')).toStrictEqual({ ok: true, types: [] })
  })

  it('gives each word that is no type id once, in text order', () => {
    // The letters of the `model_list` columns are no type ids.
    expect(parseOutputTypes('i,v')).toStrictEqual({ ok: false, unknown: ['i', 'v'] })
    expect(parseOutputTypes('image, speech, Speech, img')).toStrictEqual({ ok: false, unknown: ['speech', 'img'] })
    expect(parseOutputTypes('image;video')).toStrictEqual({ ok: false, unknown: ['image;video'] })
  })

  it('counts a model with unknown outputs as a text model', () => {
    expect(effectiveOutputs({})).toStrictEqual(['text'])
    expect(effectiveOutputs({ outputs: ['image'] })).toStrictEqual(['image'])
    // Known to make none of the types: not a text model.
    expect(effectiveOutputs({ outputs: [] })).toStrictEqual([])
  })

  it('matches every model with an empty filter, else any model that makes one of its types', () => {
    const imageAndText = { outputs: ['text', 'image'] as ModelOutput[] }
    const video = { outputs: ['video'] as ModelOutput[] }
    const unknown = {}
    const none = { outputs: [] as ModelOutput[] }

    for (const model of [imageAndText, video, unknown, none]) {
      expect(matchesOutputFilter(model, [])).toBe(true)
    }
    expect(matchesOutputFilter(imageAndText, ['image'])).toBe(true)
    expect(matchesOutputFilter(imageAndText, ['audio', 'video'])).toBe(false)
    expect(matchesOutputFilter(video, ['audio', 'video'])).toBe(true)
    expect(matchesOutputFilter(unknown, ['text'])).toBe(true)
    expect(matchesOutputFilter(unknown, ['image'])).toBe(false)
    expect(matchesOutputFilter(none, ['text', 'image', 'audio', 'video'])).toBe(false)
  })

  it('toggles one type of the filter; an empty filter is "All"', () => {
    // A first type replaces "All".
    expect(toggleOutputFilter([], 'video')).toStrictEqual(['video'])
    // More types stay in table order.
    expect(toggleOutputFilter(['video'], 'text')).toStrictEqual(['text', 'video'])
    expect(toggleOutputFilter(['text', 'video'], 'text')).toStrictEqual(['video'])
    // The removal of the last type gives "All" again.
    expect(toggleOutputFilter(['video'], 'video')).toStrictEqual([])
  })

  it('normalizes a list to known outputs, once each, in table order', () => {
    expect(normalizeOutputs(['video', 'speech', 'text', 'video', 1, null, 'Image'])).toStrictEqual(['text', 'video'])
    expect(normalizeOutputs([])).toStrictEqual([])
  })
})
