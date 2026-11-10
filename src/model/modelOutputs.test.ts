import { describe, expect, it } from 'vitest'
import {
  effectiveOutputs,
  matchesOutputFilter,
  normalizeOutputs,
  outputLetters,
  parseOutputLetters,
  toggleOutputFilter,
  type ModelOutput,
} from './modelOutputs'

describe('model outputs', () => {
  it('writes the letters in table order, whatever the list order', () => {
    expect(outputLetters(['video', 'text', 'image'])).toBe('t,i,v')
    expect(outputLetters(['audio'])).toBe('a')
    expect(outputLetters([])).toBe('')
  })

  it('reads letters with any case, commas, and white space, in table order and once each', () => {
    expect(parseOutputLetters('iv')).toStrictEqual({ ok: true, outputs: ['image', 'video'] })
    expect(parseOutputLetters(' V, i ,\tA ')).toStrictEqual({ ok: true, outputs: ['image', 'audio', 'video'] })
    expect(parseOutputLetters('t,i,a,v')).toStrictEqual({ ok: true, outputs: ['text', 'image', 'audio', 'video'] })
    expect(parseOutputLetters('iiI')).toStrictEqual({ ok: true, outputs: ['image'] })
    expect(parseOutputLetters(' , ')).toStrictEqual({ ok: true, outputs: [] })
  })

  it('reads back the letters it writes', () => {
    const outputs: ModelOutput[] = ['text', 'audio', 'video']
    expect(parseOutputLetters(outputLetters(outputs))).toStrictEqual({ ok: true, outputs })
  })

  it('refuses unknown letters, naming each once and the valid letters', () => {
    expect(parseOutputLetters('ix')).toStrictEqual({
      ok: false,
      error: 'Unknown output letter "x". Valid letters: t text, i image, a audio, v video.',
    })
    // A word is read letter by letter: "image" holds "m", "g", and "e".
    expect(parseOutputLetters('image')).toStrictEqual({
      ok: false,
      error: 'Unknown output letters "m", "g", "e". Valid letters: t text, i image, a audio, v video.',
    })
    expect(parseOutputLetters('i;v').ok).toBe(false)
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
