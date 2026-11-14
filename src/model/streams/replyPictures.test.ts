import { describe, expect, it } from 'vitest'
import type { ImageSize } from '../chat/imageDrawing'
import {
  MAX_PICTURE_TOKENS,
  MAX_REPLY_PICTURE_BYTES,
  MAX_REPLY_PICTURE_TOKENS,
  MAX_REQUEST_IMAGES,
  pictureTokens,
  ReplyPictures,
  requestImageCount,
  type ReplyPicture,
} from './replyPictures'
import type { StreamMessage } from './types'

function picture(label: string, size: ImageSize | null = { width: 800, height: 200 }, bytes = new TextEncoder().encode(label)): ReplyPicture {
  return { label, picture: { type: 'picture', mediaType: 'image/jpeg', bytes }, size }
}

function round(callIds: readonly string[]): StreamMessage[] {
  return [
    { role: 'agent', content: '', toolCalls: callIds.map((id) => ({ id, name: 'asset_view', arguments: {} })) },
    { role: 'tool', results: callIds.map((callId) => ({ callId, content: 'ok', isError: false })) },
  ]
}

// The labels of the pictures that a request of the reply sends, after the
// rounds of `callIds`.
function shownLabels(pictures: ReplyPictures, callIds: readonly string[]): string[] {
  return pictures.inMessages(callIds.flatMap((id) => round([id]))).flatMap((message) => (message.role === 'user' && typeof message.content !== 'string'
    ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    : []))
}

const USER: StreamMessage = { role: 'user', content: 'Look at @a.' }

describe('pictureTokens', () => {
  it('counts the squares of 28 pixels that the picture touches, at most the tokens of one picture, and the most for an unknown size', () => {
    expect([
      { width: 28, height: 28 },
      { width: 29, height: 28 },
      { width: 800, height: 200 },
      { width: 1920, height: 1080 },
      { width: 2048, height: 2048 },
      null,
    ].map(pictureTokens)).toStrictEqual([1, 2, 232, 2691, MAX_PICTURE_TOKENS, MAX_PICTURE_TOKENS])
  })
})

describe('requestImageCount', () => {
  it('counts the images and pictures of the user messages, not their text', () => {
    expect(requestImageCount([
      USER,
      { role: 'user', content: [{ type: 'text', text: 'Two: ' }, { type: 'image', path: '/a.png' }, { type: 'image', path: '/b.png' }] },
      ...round(['call_1']),
      { role: 'user', content: [{ type: 'text', text: 'asset_view: the image @a.' }, picture('@a').picture] },
    ])).toBe(3)
  })
})

describe('ReplyPictures', () => {
  it('puts the pictures of a round right after its tool message, each after its label, and none after other rounds', () => {
    const pictures = new ReplyPictures(0)
    const sheet = picture('The frame sheet of @f.')
    const wave = picture('The wave of @g.')
    pictures.add('call_2', [sheet])
    pictures.add('call_2', [wave])
    const messages = [USER, ...round(['call_1']), ...round(['call_2', 'call_3'])]

    expect(pictures.inMessages(messages)).toStrictEqual([
      ...messages,
      { role: 'user', content: [{ type: 'text', text: sheet.label }, sheet.picture, { type: 'text', text: wave.label }, wave.picture] },
    ])
  })

  it('keeps the messages as they are with no pictures, and for a round whose tool message is not there', () => {
    const pictures = new ReplyPictures(0)
    const messages = [USER, ...round(['call_1'])]

    expect(pictures.inMessages(messages)).toStrictEqual(messages)
    pictures.add('call_9', [picture('Gone.')])
    expect(pictures.inMessages(messages)).toStrictEqual(messages)
  })

  it('keeps each picture, in order, whose tokens fit in what is left, so a smaller one after a picture that does not fit still goes', () => {
    const pictures = new ReplyPictures(0)
    const most = Array.from({ length: MAX_REPLY_PICTURE_TOKENS / MAX_PICTURE_TOKENS - 1 }, (_, index) => picture(`Most ${index}.`, null))

    pictures.add('call_1', [...most, picture('Square.', { width: 1000, height: 1000 })])
    expect(pictures.left.tokens).toBe(MAX_PICTURE_TOKENS - 36 * 36)
    pictures.add('call_2', [picture('Too many tokens.', null), picture('Wave.')])

    expect(shownLabels(pictures, ['call_1', 'call_2'])).toStrictEqual([...most.map(({ label }) => label), 'Square.', 'Wave.'])
    expect(pictures.left.tokens).toBe(MAX_PICTURE_TOKENS - 36 * 36 - 232)
  })

  it('keeps no more base64 bytes than the budget', () => {
    const pictures = new ReplyPictures(0)
    // 3 bytes go as 4 base64 characters.
    const fills = MAX_REPLY_PICTURE_BYTES / 4 * 3

    pictures.add('call_1', [picture('One byte too many.', null, new Uint8Array(fills + 1)), picture('Fills.', null, new Uint8Array(fills)), picture('One more.', null, new Uint8Array(1))])

    expect(shownLabels(pictures, ['call_1'])).toStrictEqual(['Fills.'])
    expect(pictures.left).toStrictEqual({ tokens: MAX_REPLY_PICTURE_TOKENS - MAX_PICTURE_TOKENS, bytes: 0, pictures: MAX_REQUEST_IMAGES - 1 })
  })

  it('counts the images of the user message against the pictures of a request', () => {
    const pictures = new ReplyPictures(MAX_REQUEST_IMAGES - 2)

    pictures.add('call_1', [picture('First.'), picture('Second.'), picture('Third.')])

    expect(shownLabels(pictures, ['call_1'])).toStrictEqual(['First.', 'Second.'])
    expect(pictures.left.pictures).toBe(0)
    expect(new ReplyPictures(MAX_REQUEST_IMAGES + 3).left.pictures).toBe(0)
  })
})
