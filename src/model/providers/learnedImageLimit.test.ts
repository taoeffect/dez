import { describe, expect, it } from 'vitest'
import { imageRulesWithLearnedLimit, learnedImagesProblem, modelEntriesFingerprint, withKeptImageLimits } from './learnedImageLimit'
import type { ModelInfo } from './types'

const ENTRY = { id: 'film', model_spec: { name: 'Film', constraints: { durations: ['5s', '10s'] } } }

describe('modelEntriesFingerprint', () => {
  it('is the same for equal entries from another parse of the list', () => {
    expect(modelEntriesFingerprint(JSON.parse(JSON.stringify(ENTRY)), undefined)).toBe(modelEntriesFingerprint(ENTRY, undefined))
  })

  it('changes when the entry or the media entry changes', () => {
    const changed = { ...ENTRY, model_spec: { ...ENTRY.model_spec, constraints: { durations: ['5s'] } } }
    const prints = new Set([
      modelEntriesFingerprint(ENTRY, undefined),
      modelEntriesFingerprint(changed, undefined),
      modelEntriesFingerprint(ENTRY, { id: 'film' }),
      modelEntriesFingerprint(undefined, ENTRY),
    ])

    expect(prints.size).toBe(4)
  })

  it('is undefined for a model with no raw entry', () => {
    expect(modelEntriesFingerprint(undefined, undefined)).toBeUndefined()
  })
})

describe('withKeptImageLimits', () => {
  const model = (id: string, fields: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, provider: 'p', request: 'imageToVideo', ...fields })
  const learned = (entry: unknown) => ({ maxImages: 1, entry: modelEntriesFingerprint(entry, undefined) ?? '' })

  it('keeps a learned limit while the model\'s entry stays the same, and gives none to a model that learned none', () => {
    const cached = [model('film', { learnedImageLimit: learned(ENTRY) }), model('other')]
    const entries = new Map<string, unknown>([['film', structuredClone(ENTRY)], ['other', { id: 'other' }]])

    expect(withKeptImageLimits([model('film'), model('other')], cached, entries, undefined))
      .toStrictEqual([model('film', { learnedImageLimit: learned(ENTRY) }), model('other')])
  })

  it('forgets a learned limit when the model\'s entry changed, or when the check gave no entry', () => {
    const cached = [model('film', { learnedImageLimit: learned(ENTRY) })]
    const changed = new Map<string, unknown>([['film', { ...ENTRY, offline: true }]])

    expect([
      withKeptImageLimits([model('film')], cached, changed, undefined),
      withKeptImageLimits([model('film')], cached, undefined, undefined),
    ]).toStrictEqual([[model('film')], [model('film')]])
  })

  it('counts the entry of a media list too', () => {
    const limit = { maxImages: 1, entry: modelEntriesFingerprint(ENTRY, { id: 'film', frames: 2 }) ?? '' }
    const cached = [model('film', { learnedImageLimit: limit })]
    const entries = new Map<string, unknown>([['film', ENTRY]])

    expect([
      withKeptImageLimits([model('film')], cached, entries, new Map([['film', { id: 'film', frames: 2 }]])),
      withKeptImageLimits([model('film')], cached, entries, new Map([['film', { id: 'film', frames: 1 }]])),
    ]).toStrictEqual([[model('film', { learnedImageLimit: limit })], [model('film')]])
  })
})

describe('learnedImagesProblem', () => {
  const limit = { maxImages: 1, entry: '0badf00d' }

  it('refuses a message with more images than the learned limit, in the words of the provider\'s refusal', () => {
    expect(learnedImagesProblem('Film', limit, 2))
      .toBe('Film takes only 1 image, and this message has 2. Keep only 1 image in the message (pasted, or named with @id), and send it again.')
  })

  it('lets a message with the learned count go, and every message to a model with no learned limit', () => {
    expect([learnedImagesProblem('Film', limit, 1), learnedImagesProblem('Film', undefined, 5)]).toStrictEqual([null, null])
  })
})

describe('imageRulesWithLearnedLimit', () => {
  const limit = { maxImages: 1, entry: '0badf00d' }

  it('lowers the most images of the rules to a lower learned limit, and keeps the other rules', () => {
    expect(imageRulesWithLearnedLimit('imageToVideo', { maxImages: 2, size: { minShortSide: 300 } }, limit))
      .toStrictEqual({ maxImages: 1, size: { minShortSide: 300 } })
  })

  it('gives an edit model with no rules, which takes every image, the learned limit', () => {
    expect(imageRulesWithLearnedLimit('imageEdit', undefined, { maxImages: 3, entry: '0badf00d' })).toStrictEqual({ maxImages: 3 })
  })

  it('keeps rules that take no more images than the learned limit', () => {
    const rules = { maxImages: 1 }

    expect([imageRulesWithLearnedLimit('imageToVideo', rules, limit), imageRulesWithLearnedLimit('imageToVideo', rules, undefined)])
      .toStrictEqual([rules, rules])
  })
})
