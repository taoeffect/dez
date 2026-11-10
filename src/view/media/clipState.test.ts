import { describe, expect, it } from 'vitest'
import { clipSourceKind, expiryNotice } from './clipState'

describe('clipSourceKind', () => {
  it('tells a saved file, a temp copy, and a URL apart', () => {
    expect(clipSourceKind('/home/u/.config/dez/assets/generated/video/9f3c.mp4')).toBe('saved')
    expect(clipSourceKind('/home/u/.config/dez/assets/generated/audio/9f3c.mp3')).toBe('saved')
    expect(clipSourceKind('/home/u/.cache/dez/media/9f3c.mp4')).toBe('temp')
    expect(clipSourceKind('https://cdn.example/v.mp4?sig=1')).toBe('remote')
    expect(clipSourceKind('HTTP://cdn.example/v.mp4')).toBe('remote')
  })

  it('gives no source for a tag with no src', () => {
    expect(clipSourceKind(null)).toBe('none')
  })

  it('takes no other file and no other URL scheme as a source', () => {
    const sources = [
      '/home/u/Videos/clip.mp4',
      '/home/u/.config/dez/assets/images/9f3c.png',
      '/home/u/.config/dez/assets/generated/video/sub/9f3c.mp4',
      'assets/generated/video/9f3c.mp4',
      'file:///home/u/.cache/dez/media/9f3c.mp4',
      'data:video/mp4;base64,AAAA',
      'javascript:alert(1)',
      'asset://localhost/home/u/.cache/dez/media/9f3c.mp4',
      'https://',
      'https://cdn.example/a b.mp4',
    ]
    for (const src of sources) expect(clipSourceKind(src), src).toBe('none')
  })
})

describe('expiryNotice', () => {
  const expires = '2026-11-11T09:30:00.000Z'
  const at = Date.parse(expires)
  const formatTime = (time: Date) => `<${time.toISOString()}>`

  it('tells until when a clip is available', () => {
    expect(expiryNotice(expires, at - 1, formatTime)).toStrictEqual({
      expired: false,
      title: 'Not saved',
      text: `This clip is available until <${expires}>. Save it to keep it.`,
    })
  })

  it('tells that the time is over, from the expiry time on', () => {
    const expired = {
      expired: true,
      title: 'Expired',
      text: `This clip was available until <${expires}>. It can stop playing at any time.`,
    }
    expect(expiryNotice(expires, at, formatTime)).toStrictEqual(expired)
    expect(expiryNotice(expires, at + 86_400_000, formatTime)).toStrictEqual(expired)
  })

  it('gives no notice for a tag with no time or with a time that is not valid', () => {
    expect(expiryNotice(null, at, formatTime)).toBeNull()
    expect(expiryNotice('soon', at, formatTime)).toBeNull()
    expect(expiryNotice('', at, formatTime)).toBeNull()
  })
})
