import { describe, expect, it } from 'vitest'
import { MAX_REPLY_PICTURES, ReplyPictures, type ReplyPicture } from './replyPictures'
import type { StreamMessage } from './types'

function picture(label: string): ReplyPicture {
  return { label, picture: { type: 'picture', mediaType: 'image/jpeg', bytes: new TextEncoder().encode(label) } }
}

function round(callIds: readonly string[]): StreamMessage[] {
  return [
    { role: 'agent', content: '', toolCalls: callIds.map((id) => ({ id, name: 'asset_view', arguments: {} })) },
    { role: 'tool', results: callIds.map((callId) => ({ callId, content: 'ok', isError: false })) },
  ]
}

const USER: StreamMessage = { role: 'user', content: 'Look at @a.' }

describe('ReplyPictures', () => {
  it('puts the pictures of a round right after its tool message, each after its label, and none after other rounds', () => {
    const pictures = new ReplyPictures()
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
    const pictures = new ReplyPictures()
    const messages = [USER, ...round(['call_1'])]

    expect(pictures.inMessages(messages)).toStrictEqual(messages)
    pictures.add('call_9', [picture('Gone.')])
    expect(pictures.inMessages(messages)).toStrictEqual(messages)
  })

  it(`keeps at most ${MAX_REPLY_PICTURES} pictures in a reply, the first ones`, () => {
    const pictures = new ReplyPictures()
    const many = Array.from({ length: MAX_REPLY_PICTURES - 2 }, (_, index) => picture(`Picture ${index}.`))

    pictures.add('call_1', many)
    pictures.add('call_2', [picture('Fits.'), picture('Fits too.'), picture('Too many.')])
    expect(pictures.left).toBe(0)
    pictures.add('call_3', [picture('None.')])

    const shown = pictures.inMessages([...round(['call_1']), ...round(['call_2']), ...round(['call_3'])])
    const labels = shown.flatMap((message) => (message.role === 'user' && typeof message.content !== 'string'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []))
    expect(labels).toStrictEqual([...many.map(({ label }) => label), 'Fits.', 'Fits too.'])
  })
})
