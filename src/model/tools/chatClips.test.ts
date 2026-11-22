import { describe, expect, it } from 'vitest'
import type { ChatClipRules } from '../providers/config'
import { CHAT_CLIP_MAX_BYTES, chatClipCopies, chatClipMaxBytes } from './chatClips'

// Venice's rules take a stream copy of most clips; OpenRouter's take only
// WAV and MP3 audio.
const MANY: ChatClipRules = { audioFormats: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'], videoTypes: ['video/mp4', 'video/webm'] }
const FEW: ChatClipRules = { audioFormats: ['wav', 'mp3'], videoTypes: ['video/mp4'] }

// The plan of each copy: its file name and the form that the request tells.
function plans(kind: 'audio' | 'video', type: string, rules: ChatClipRules) {
  return chatClipCopies({ kind, type }, 'c.in', rules, 1000).map(({ name, form }) => ({ name, form }))
}

describe('chatClipCopies', () => {
  it.each([
    ['audio/mpeg', MANY, 'chat_copy.mp3', 'mp3'],
    ['audio/mp3', MANY, 'chat_copy.mp3', 'mp3'],
    ['audio/x-wav', FEW, 'chat_copy.wav', 'wav'],
    ['audio/flac', MANY, 'chat_copy.flac', 'flac'],
    ['audio/x-m4a', MANY, 'chat_copy.m4a', 'm4a'],
  ])('first tries a stream copy of a %s clip that the provider takes', (type, rules, name, format) => {
    expect(plans('audio', type, rules)).toStrictEqual([
      { name, form: { type: 'audio', format } },
      { name: 'chat_converted.mp3', form: { type: 'audio', format: 'mp3' } },
    ])
  })

  it('converts an audio clip of a type that the provider does not take, to MP3 when it takes MP3, else to WAV', () => {
    expect(plans('audio', 'audio/flac', FEW)).toStrictEqual([{ name: 'chat_converted.mp3', form: { type: 'audio', format: 'mp3' } }])
    expect(plans('audio', 'audio/flac', { audioFormats: ['wav', 'ogg'] })).toStrictEqual([{ name: 'chat_converted.wav', form: { type: 'audio', format: 'wav' } }])
  })

  // Dez does not know whether a server that takes `ogg` reads Opus in it.
  it('converts an Opus clip, even for a provider that takes ogg', () => {
    expect(plans('audio', 'audio/opus', MANY)).toStrictEqual([{ name: 'chat_converted.mp3', form: { type: 'audio', format: 'mp3' } }])
  })

  it('tries a stream copy of a video clip of a type that the provider takes, then an MP4 conversion', () => {
    const converted = { name: 'chat_converted.mp4', form: { type: 'video', mediaType: 'video/mp4' } }
    expect(plans('video', 'video/webm', MANY)).toStrictEqual([{ name: 'chat_copy.webm', form: { type: 'video', mediaType: 'video/webm' } }, converted])
    expect(plans('video', 'video/webm', FEW)).toStrictEqual([converted])
    expect(plans('video', 'video/quicktime', MANY)).toStrictEqual([converted])
  })

  // The copy goes to a provider: it must hold no metadata of the file of
  // the user, and a copy that is too large must end soon.
  it('reads only the input, drops all metadata, and stops one byte over the limit', () => {
    for (const { name, args } of [...chatClipCopies({ kind: 'audio', type: 'audio/mpeg' }, 'c.mp3', MANY, 5000), ...chatClipCopies({ kind: 'video', type: 'video/mp4' }, 'e.mp4', FEW, 5000)]) {
      expect(args.filter((_arg, index) => args[index - 1] === '-i')).toHaveLength(1)
      expect(args.join(' ')).toContain('-map_metadata -1 -map_chapters -1 -bitexact -fs 5001')
      expect(args.at(-1)).toBe(name)
    }
  })

  it('maps one audio stream of an audio clip, and the first video stream that is no cover and the first audio stream of a video clip', () => {
    const [audio] = chatClipCopies({ kind: 'audio', type: 'audio/mpeg' }, 'c.mp3', MANY, 5000)
    const [video] = chatClipCopies({ kind: 'video', type: 'video/mp4' }, 'e.mp4', FEW, 5000)
    expect(audio.args.slice(0, 8)).toStrictEqual(['-nostdin', '-hide_banner', '-v', 'error', '-i', 'c.mp3', '-map', '0:a:0'])
    expect(video.args.slice(4, 10)).toStrictEqual(['-i', 'e.mp4', '-map', '0:V:0', '-map', '0:a:0?'])
  })
})

describe('chatClipMaxBytes', () => {
  it('is the lower of the provider\'s limit and Dez\'s own', () => {
    expect(chatClipMaxBytes({ maxBytes: 25_000_000 })).toBe(25_000_000)
    expect(chatClipMaxBytes({ maxBytes: CHAT_CLIP_MAX_BYTES * 2 })).toBe(CHAT_CLIP_MAX_BYTES)
    expect(chatClipMaxBytes({})).toBe(CHAT_CLIP_MAX_BYTES)
  })
})
