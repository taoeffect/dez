import { describe, expect, it } from 'vitest'
import type { ShownPicture } from '../chat/shownPictures'
import { DEFAULT_FAMILY, modelFamily, type ImageTokenRule } from '../providers/modelFamilies'
import {
  budgetAfter,
  compactedPictureLimits,
  contextImageCost,
  MAX_REQUEST_IMAGE_BYTES,
  NO_PICTURE_BUDGET,
  pictureBudgetLeft,
  pictureCost,
  pictureLimits,
  requestImageCount,
  shownPictureCost,
  totalCost,
} from './pictureBudget'
import type { StreamMessage } from './types'

const RULE = DEFAULT_FAMILY.imageTokens
// The most tokens of one picture by the default rule.
const MOST_TOKENS = 4784
const WAVE: ShownPicture = { file: 'wave.jpg', label: 'asset_view: the wave of @b.', width: 800, height: 200, bytes: 3000 }

function round(callIds: readonly string[]): StreamMessage[] {
  return [
    { role: 'agent', content: '', toolCalls: callIds.map((id) => ({ id, name: 'asset_view', arguments: {} })) },
    { role: 'tool', results: callIds.map((callId) => ({ callId, content: 'ok', isError: false })) },
  ]
}

describe('pictureLimits', () => {
  it('gives 40% of the compaction threshold of the window of the model family, the bytes, and the image limit of the model', () => {
    expect(pictureLimits({ id: 'a-model-of-no-family' })).toStrictEqual({ tokens: 52_000, bytes: 20 * 1024 ** 2, pictures: DEFAULT_FAMILY.maxImages })
  })

  it('reads the context window that the model list gave before the one of the family', () => {
    expect(pictureLimits({ id: 'a-model-of-no-family', contextWindow: 32_000 }).tokens).toBe(8320)
    // The threshold stops at 250,000 tokens.
    expect(pictureLimits({ id: 'a-model-of-no-family', contextWindow: 2_000_000 }).tokens).toBe(100_000)
  })

  // Dez has no count of its own: the limit of one message is not the limit
  // of a request.
  it.each<[string, Parameters<typeof pictureLimits>[0], number]>([
    ['the count of the model list', { id: 'a-model-of-no-family', imageLimit: 600 }, 600],
    ['the count of the family', { id: 'claude-opus-4-6' }, 600],
    ['no count for a family with no limit', { id: 'grok-4-7' }, Infinity],
    ['the count of a request for a model with a lower limit of one message', { id: 'a-model-of-no-family', messageImageLimit: 10, learnedImageLimit: { maxImages: 4, entry: 'h' } }, 20],
  ])('gives %s as the count of pictures', (_name, model, pictures) => {
    expect(pictureLimits(model).pictures).toBe(pictures)
  })
})

describe('compactedPictureLimits', () => {
  it('gives half of each limit of a request', () => {
    expect(compactedPictureLimits({ id: 'a-model-of-no-family' })).toStrictEqual({ tokens: 26_000, bytes: 10 * 1024 ** 2, pictures: 10 })
    expect(compactedPictureLimits({ id: 'a-model-of-no-family', imageLimit: 5 }).pictures).toBe(2)
  })

  // The images and the pictures of a compacted conversation go in one
  // message.
  it('gives at most the count of one message', () => {
    expect(compactedPictureLimits({ id: 'a-model-of-no-family', messageImageLimit: 4 }).pictures).toBe(4)
    expect(compactedPictureLimits({ id: 'a-model-of-no-family', messageImageLimit: 12 }).pictures).toBe(10)
    expect(compactedPictureLimits({ id: 'grok-4-7', learnedImageLimit: { maxImages: 6, entry: 'h' } }).pictures).toBe(6)
  })

  it('gives one picture to a model that takes one image, and no count to a model with no limit', () => {
    expect(compactedPictureLimits({ id: 'a-model-of-no-family', imageLimit: 1 }).pictures).toBe(1)
    expect(compactedPictureLimits({ id: 'grok-4-7' }).pictures).toBe(Infinity)
  })
})

describe('pictureCost', () => {
  it('counts the tokens by the rule of the family, the base64 text of the bytes, and one picture', () => {
    const file = { mediaType: 'image/jpeg' as const, bytes: new Uint8Array(3000) }

    expect(pictureCost(RULE, file, { width: 800, height: 200 })).toStrictEqual({ tokens: 232, bytes: 4000, pictures: 1 })
    expect(pictureCost({ rule: 'fixed', tokens: 258 }, file, { width: 800, height: 200 }).tokens).toBe(258)
  })

  it('counts a picture of an unknown size as the most tokens of the rule', () => {
    expect(pictureCost(RULE, { mediaType: 'image/jpeg', bytes: new Uint8Array(1) }, null)).toStrictEqual({ tokens: MOST_TOKENS, bytes: 4, pictures: 1 })
  })

  // 3 bytes go as 4 characters, and so do the 1 or 2 bytes at the end.
  it('rounds the base64 text up to whole groups of 4 characters', () => {
    expect([0, 1, 2, 3, 4].map((length) => pictureCost(RULE, { mediaType: 'image/png', bytes: new Uint8Array(length) }, null).bytes)).toStrictEqual([0, 4, 4, 4, 8])
  })
})

describe('shownPictureCost', () => {
  // The budget takes the cost of a new picture, and the context of the
  // next request counts its copy: the two must agree.
  it.each<[string, ImageTokenRule]>([
    ['the default rule', RULE],
    ['a tiles rule', modelFamily('gpt-4o-mini').imageTokens],
  ])('costs a saved picture what it cost as a new one, by %s', (_name, rule) => {
    const { width, height, bytes } = WAVE as Required<ShownPicture>

    expect(shownPictureCost(rule, WAVE)).toStrictEqual(pictureCost(rule, { mediaType: 'image/jpeg', bytes: new Uint8Array(bytes) }, { width, height }))
  })

  it('counts a copy with no size as the most tokens of the rule, and a copy with no byte count as no bytes', () => {
    expect(shownPictureCost(RULE, { file: 'old.jpg', label: 'An old copy.' })).toStrictEqual({ tokens: MOST_TOKENS, bytes: 0, pictures: 1 })
    // One side alone is no size.
    expect(shownPictureCost(RULE, { file: 'old.jpg', label: 'An old copy.', width: 800 }).tokens).toBe(MOST_TOKENS)
  })
})

describe('budgetAfter', () => {
  const budget = { tokens: 232, bytes: 4000, pictures: 1 }

  it('takes the cost of a picture that fits, down to nothing left', () => {
    expect(budgetAfter(budget, { tokens: 200, bytes: 1000, pictures: 1 })).toStrictEqual({ tokens: 32, bytes: 3000, pictures: 0 })
    expect(budgetAfter(budget, budget)).toStrictEqual(NO_PICTURE_BUDGET)
  })

  it.each([
    ['tokens', { tokens: 233, bytes: 4000, pictures: 1 }],
    ['bytes', { tokens: 232, bytes: 4001, pictures: 1 }],
    ['pictures', { tokens: 232, bytes: 4000, pictures: 2 }],
  ])('gives null for a picture with too many %s', (_part, cost) => {
    expect(budgetAfter(budget, cost)).toBeNull()
  })
})

describe('totalCost', () => {
  it('adds each part of the costs, and gives no cost for none', () => {
    expect(totalCost([{ tokens: 1, bytes: 2, pictures: 3 }, { tokens: 10, bytes: 20, pictures: 30 }])).toStrictEqual({ tokens: 11, bytes: 22, pictures: 33 })
    expect(totalCost([])).toStrictEqual(NO_PICTURE_BUDGET)
  })
})

describe('contextImageCost', () => {
  const messages: StreamMessage[] = [
    { role: 'user', content: 'An older message with ![id=a](image) as text.' },
    { role: 'agent', content: 'An answer.' },
    { role: 'user', content: [{ type: 'text', text: 'Two: ' }, { type: 'image', path: '/a.png' }, { type: 'image', path: '/b.png' }] },
    ...round(['call_1']),
    { role: 'user', content: [{ type: 'text', text: WAVE.label }, { type: 'picture', picture: WAVE }] },
  ]

  it('counts each image of a user message as an image of the assumed size with the size of its file, and each picture by its copy', () => {
    // The assumed size, 1568 by 1568 pixels, is 56 by 56 squares of 28
    // pixels.
    expect(contextImageCost(messages, RULE, new Map([['/a.png', 3000], ['/b.png', 6]]))).toStrictEqual({
      tokens: 2 * 56 * 56 + 232,
      bytes: 4000 + 8 + 4000,
      pictures: 3,
    })
  })

  it('counts no bytes for an image whose file size it does not have', () => {
    expect(contextImageCost(messages, RULE, new Map()).bytes).toBe(4000)
  })

  it('costs nothing for messages with no image and no picture', () => {
    expect(contextImageCost([{ role: 'user', content: 'Hello.' }, ...round(['call_1'])], RULE, new Map())).toStrictEqual(NO_PICTURE_BUDGET)
  })
})

describe('pictureBudgetLeft', () => {
  const limits = pictureLimits({ id: 'a-model-of-no-family' })

  it('gives the limits less what the context spent', () => {
    expect(pictureBudgetLeft(limits, NO_PICTURE_BUDGET)).toStrictEqual(limits)
    expect(pictureBudgetLeft(limits, { tokens: 2000, bytes: 4000, pictures: 3 })).toStrictEqual({
      tokens: 50_000,
      bytes: MAX_REQUEST_IMAGE_BYTES - 4000,
      pictures: DEFAULT_FAMILY.maxImages - 3,
    })
  })

  // The images of a user message have no budget, so they can cost more
  // than a limit.
  it('never goes under 0 in a part, and keeps the other parts', () => {
    expect(pictureBudgetLeft(limits, { tokens: 60_000, bytes: 4000, pictures: 25 })).toStrictEqual({ tokens: 0, bytes: MAX_REQUEST_IMAGE_BYTES - 4000, pictures: 0 })
  })
})

describe('requestImageCount', () => {
  it('counts the images and pictures of the user messages, not their text', () => {
    expect(requestImageCount([
      { role: 'user', content: 'Look at @a.' },
      { role: 'user', content: [{ type: 'text', text: 'Two: ' }, { type: 'image', path: '/a.png' }, { type: 'image', path: '/b.png' }] },
      ...round(['call_1']),
      { role: 'user', content: [{ type: 'text', text: WAVE.label }, { type: 'picture', picture: WAVE }] },
    ])).toBe(3)
  })
})
