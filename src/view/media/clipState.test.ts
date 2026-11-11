import { describe, expect, it } from 'vitest'
import { clipProblem, clipSourceKind, expiryNotice, problemCard, type ClipSourceKind } from './clipState'

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

describe('clipProblem', () => {
  const LOCAL: ClipSourceKind[] = ['saved', 'temp']
  const USABLE: ClipSourceKind[] = [...LOCAL, 'remote']

  it('tells that a clip with no usable source is gone, whatever failed', () => {
    expect(clipProblem('none', null)).toBe('gone')
    expect(clipProblem('none', { step: 'play', code: 3 })).toBe('gone')
    expect(clipProblem('none', { step: 'ask', answers: true })).toBe('gone')
  })

  it('gives no problem while nothing failed', () => {
    for (const source of USABLE) expect(clipProblem(source, null), source).toBeNull()
  })

  it('tells that a local clip whose file cannot be read is gone', () => {
    for (const source of LOCAL) expect(clipProblem(source, { step: 'read' }), source).toBe('gone')
  })

  it('tells that this computer cannot play a local file that was read, for any media error', () => {
    for (const source of LOCAL) {
      for (const code of [1, 2, 3, 4, undefined]) {
        expect(clipProblem(source, { step: 'play', code }), `${source} ${code}`).toBe('cannot-play')
      }
    }
  })

  it('tells that this computer cannot play a URL that gave a decode error', () => {
    expect(clipProblem('remote', { step: 'play', code: 3 })).toBe('cannot-play')
  })

  it('tells that a URL that gave a network error, or an error with no known code, is gone', () => {
    for (const code of [1, 2, undefined]) expect(clipProblem('remote', { step: 'play', code }), String(code)).toBe('gone')
  })

  it('asks the URL when it was "not supported", and decides by its answer', () => {
    expect(clipProblem('remote', { step: 'play', code: 4 })).toBe('ask')
    expect(clipProblem('remote', { step: 'ask', answers: true })).toBe('cannot-play')
    expect(clipProblem('remote', { step: 'ask', answers: false })).toBe('gone')
  })
})

describe('problemCard', () => {
  const GONE = { text: 'This clip is no longer available.', hint: null, file: null }
  const CANNOT_PLAY = 'This computer cannot play the format of this clip (video/webm).'
  const SAVE_HINT = 'Its file is still there. Save the clip to keep the file, then open the file with another app.'
  const OPEN_HINT = 'Its file is still there. Open the file with another app.'

  it('tells only that a gone clip is no longer available, saved or not', () => {
    expect(problemCard('gone', { type: 'video/webm', saved: false, savedPath: null })).toStrictEqual(GONE)
    expect(problemCard('gone', { type: 'video/webm', saved: true, savedPath: '~/v.webm' })).toStrictEqual(GONE)
  })

  it('names the format of a clip that cannot play, and tells to save it', () => {
    expect(problemCard('cannot-play', { type: 'video/webm', saved: false, savedPath: null })).toStrictEqual({
      text: CANNOT_PLAY,
      hint: SAVE_HINT,
      file: null,
    })
  })

  it('names no format when the tag gives none', () => {
    const text = 'This computer cannot play the format of this clip.'
    expect(problemCard('cannot-play', { type: null, saved: false, savedPath: null }).text).toBe(text)
    expect(problemCard('cannot-play', { type: ' ', saved: false, savedPath: null }).text).toBe(text)
  })

  it('names the saved file of a clip that cannot play, once its path is read', () => {
    const savedPath = '~/.config/dez/assets/generated/video/9f3c.webm'
    expect(problemCard('cannot-play', { type: 'video/webm', saved: true, savedPath })).toStrictEqual({
      text: CANNOT_PLAY,
      hint: OPEN_HINT,
      file: 'Saved file: ~/.config/dez/assets/generated/video/9f3c.webm',
    })
    expect(problemCard('cannot-play', { type: 'video/webm', saved: true, savedPath: null })).toStrictEqual({
      text: CANNOT_PLAY,
      hint: OPEN_HINT,
      file: null,
    })
  })
})

describe('expiryNotice', () => {
  const expires = '2026-11-11T09:30:00.000Z'
  const at = Date.parse(expires)
  const formatTime = (time: Date) => `<${time.toISOString()}>`

  it('tells until when a clip is available', () => {
    expect(expiryNotice(expires, at - 1, null, formatTime)).toStrictEqual({
      expired: false,
      title: 'Not saved',
      text: `This clip is available until <${expires}>. Save it to keep it.`,
      file: null,
    })
  })

  it('tells that the time is over, from the expiry time on', () => {
    const expired = {
      expired: true,
      title: 'Expired',
      text: `This clip was available until <${expires}>. It can stop playing at any time.`,
      file: null,
    }
    expect(expiryNotice(expires, at, null, formatTime)).toStrictEqual(expired)
    expect(expiryNotice(expires, at + 86_400_000, null, formatTime)).toStrictEqual(expired)
  })

  it('names the temp copy of a clip, before and after its time is over', () => {
    const tempPath = '~/.cache/dez/media/9f3c.mp4'
    expect(expiryNotice(expires, at - 1, tempPath, formatTime)).toStrictEqual({
      expired: false,
      title: 'Not saved',
      text: `This clip is available until <${expires}>. Save it to keep it.`,
      file: 'Temporary file: ~/.cache/dez/media/9f3c.mp4',
    })
    expect(expiryNotice(expires, at, tempPath, formatTime)?.file).toBe('Temporary file: ~/.cache/dez/media/9f3c.mp4')
  })

  it('gives no notice for a tag with no time or with a time that is not valid', () => {
    expect(expiryNotice(null, at, null, formatTime)).toBeNull()
    expect(expiryNotice('soon', at, null, formatTime)).toBeNull()
    expect(expiryNotice('', at, '~/.cache/dez/media/9f3c.mp4', formatTime)).toBeNull()
  })
})
