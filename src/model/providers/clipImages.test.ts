import { describe, expect, it } from 'vitest'
import { cloneInputImageRules, inputImageRulesFor, type InputImageRules } from './clipImages'

// An OpenRouter video model that takes a first and a last frame, or 16
// references when the user chose them (mediaFormats.ts).
const REFERENCES = { maxImages: 16, references: {} }
const FRAMES_OR_REFERENCES: InputImageRules = { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: REFERENCES } }

describe('the image rules of a request', () => {
  it('are the rules of the parameter value when the request sends that value', () => {
    expect(inputImageRulesFor(FRAMES_OR_REFERENCES, { images_as: 'references', duration: 5 })).toStrictEqual(REFERENCES)
  })

  it.each([
    ['another value', { images_as: 'frames' }],
    ['no value', {}],
    ['the value as another parameter', { aspect_ratio: 'references' }],
  ])('are the model\'s own rules for %s', (_name, values) => {
    expect(inputImageRulesFor(FRAMES_OR_REFERENCES, values)).toBe(FRAMES_OR_REFERENCES)
  })

  it('are none for a model with none', () => {
    expect(inputImageRulesFor(undefined, { images_as: 'references' })).toBeUndefined()
  })
})

describe('a copy of image rules', () => {
  it('shares no object with the rules', () => {
    const rules: InputImageRules = {
      maxImages: 2,
      size: { minShortSide: 300 },
      references: { promptName: '@Image{n}' },
      whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, size: { minShortSide: 256 }, references: {} } },
    }
    const copy = cloneInputImageRules(rules)

    expect(copy).toStrictEqual(rules)
    expect([
      copy.size === rules.size,
      copy.references === rules.references,
      copy.whenParameter === rules.whenParameter,
      copy.whenParameter?.rules === rules.whenParameter?.rules,
      copy.whenParameter?.rules.size === rules.whenParameter?.rules.size,
      copy.whenParameter?.rules.references === rules.whenParameter?.rules.references,
    ]).toStrictEqual([false, false, false, false, false, false])
  })
})
