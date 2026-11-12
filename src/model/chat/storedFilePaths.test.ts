import { describe, expect, it } from 'vitest'
import { mediaTagText } from './mediaTags'
import { holdsStoredFilePath, withoutStoredFilePaths } from './storedFilePaths'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const JPG = '/home/ann/.config/dez/assets/images/a1.jpg'
const GENERATED = '/home/ann/.config/dez/assets/generated/images/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.webp'
const AUDIO = '/home/ann/.config/dez/assets/generated/audio/7b1e-22.mp3'
const VIDEO = '/home/ann/.config/dez/assets/generated/video/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.mp4'
const CACHED = '/home/ann/.cache/dez/media/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.mp4'
const PASTED_AUDIO = '/home/ann/.config/dez/assets/audio/1d2e-3f.wav'
const PASTED_VIDEO = '/home/ann/.config/dez/assets/video/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.mov'

describe('withoutStoredFilePaths', () => {
  it.each([
    ['empty parens', `![${PNG}]()`, '![image]()'],
    ['an id', `![${PNG}](id=a)`, '![image](id=a)'],
    ['unknown keys and escaped values', String.raw`![${PNG}](id=b|desc=a \| b \(c\) \\ d|x=)`, String.raw`![image](id=b|desc=a \| b \(c\) \\ d|x=)`],
    ['a home folder with spaces, parentheses, and non-ASCII names', '![/Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp](id=a)', '![image](id=a)'],
    ['a generated image', `![${GENERATED}](id=b)`, '![image](id=b)'],
  ])('sends a reference with %s as ![image] and its metadata as it is', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  it.each([
    ['the source that the Backspace rule leaves', `![${PNG}](id=a`, '![image](id=a'],
    ['the link that the Delete rule leaves', `[${PNG}](id=a)`, '[image](id=a)'],
    ['a reference with an id that is not valid', `![${PNG}](id=A)`, '![image](id=A)'],
    ['a reference with a key given twice', `![${PNG}](id=a|id=b)`, '![image](id=a|id=b)'],
    ['a bare path', `see ${PNG} now`, 'see image now'],
    ['a bare generated path', `see ${GENERATED} now`, 'see image now'],
  ])('takes the path out of %s', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  it('takes the paths in metadata values and every path on a line, also of another home', () => {
    expect(withoutStoredFilePaths(`![${PNG}](id=a|desc=a /home/bob/.config/dez/assets/images/b.png) and ![${JPG}](id=b)`))
      .toBe('![image](id=a|desc=a image) and ![image](id=b)')
  })

  it.each(['jpg', 'jpeg', 'gif', 'webp'])('takes a path with the extension %s', (extension) => {
    expect(withoutStoredFilePaths(`![/home/ann/.config/dez/assets/images/x.${extension}](id=a)`)).toBe('![image](id=a)')
  })

  it.each([
    ['a saved audio clip', `play ${AUDIO} now`, 'play audio now'],
    ['a saved video clip', `play ${VIDEO} now`, 'play video now'],
    ['a pasted audio clip', `play ${PASTED_AUDIO} now`, 'play audio now'],
    ['a pasted video clip', `play ${PASTED_VIDEO} now`, 'play video now'],
    ['a temp copy of a clip', `play ${CACHED} now`, 'play media now'],
    ['a temp copy in another cache folder', 'play /Users/Zoë Ann/Library/Caches/dez/media/x_1-2.webm now', 'play media now'],
    ['a saved clip with an extension that Dez does not know', 'play /home/ann/.config/dez/assets/generated/audio/x.opus7 now', 'play audio now'],
    ['a saved clip in a Markdown link', `[video](${VIDEO}) and [audio](<${AUDIO}>)`, '[video](video) and [audio](<audio>)'],
  ])('takes the path out of %s', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  it('puts the word of the last path in a run in place of all the paths in it', () => {
    expect(withoutStoredFilePaths(`${PNG} then ${VIDEO}`)).toBe('video')
    expect(withoutStoredFilePaths(`${VIDEO} then ${CACHED} then ${PNG}`)).toBe('image')
    expect(withoutStoredFilePaths(`![${PNG}](id=a) then ${AUDIO}`)).toBe('![image](id=a) then audio')
  })

  it('leaves no path of a media tag that goes as plain text', () => {
    for (const src of [AUDIO, VIDEO, CACHED, PASTED_AUDIO, PASTED_VIDEO]) {
      const tag = mediaTagText({ kind: 'video', id: 'b', type: 'video/mp4', src, url: null, expires: null, other: [{ name: 'poster', value: PNG }] })
      const sent = withoutStoredFilePaths(`User text\n${tag}\nmore`)

      expect(sent, tag).not.toContain('/home/ann')
      expect(sent, tag).not.toContain('.config')
      expect(sent, tag).not.toContain('dez/media')
    }
  })

  it('leaves no part of a path in prose, also when it takes the prose before it', () => {
    for (const text of [`Compare a/b with ${PNG}.`, `See https://example.com/x and ${JPG}`, `file://${PNG}`, `${PNG}\n${JPG}`, `file://${VIDEO}`, `${AUDIO}\n${CACHED}`]) {
      const sent = withoutStoredFilePaths(text)
      expect(sent, text).not.toContain('assets/')
      expect(sent, text).not.toContain('dez/media')
      expect(sent, text).not.toContain('/home/ann')
    }
  })

  it('gives a text with no stored file path back as it is', () => {
    for (const text of ['', 'Hi\n', '![x](https://example.com/x.png)', '/home/ann/Pictures/x.png', 'assets/images/x.png', 'https://cdn.example/video/x.mp4']) {
      expect(withoutStoredFilePaths(text)).toBe(text)
    }
  })

  // Many web projects have an `assets/images` folder; only Dez's own folder
  // is private.
  it('leaves the paths of an assets folder that is not Dez\'s as they are', () => {
    for (const text of [
      'import logo from \'../assets/images/logo.png\'',
      'cp ~/Downloads/hero.jpg app/assets/images/hero.jpg',
      '<link href="/css/main.css"><img src="/assets/images/logo.png" alt="logo">',
      'my logo at src/assets/images/logo.png doesn\'t load',
      'https://example.com/assets/images/logo.png',
      '/home/ann/.config/dez2/assets/images/a1.jpg',
      'public/assets/generated/video/intro.mp4',
      '/home/ann/.config/dez/assets/generated/video/sub/intro.mp4',
      '/home/ann/.config/dez/assets/generated/audio/',
      'see mydez/media/x.mp4 and dez/media/x.mp4 and /dez/media/x',
    ]) {
      expect(withoutStoredFilePaths(text)).toBe(text)
    }
  })

  // A regex that rescans a line from each `/` takes seconds on a long line,
  // and every send scrubs every message.
  it('takes linear time on a long line with many slashes', () => {
    const line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(16 * 1024)
    const started = performance.now()
    const sent = withoutStoredFilePaths(`${line} ${PNG}`)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(sent).toBe(`${line.slice(0, line.indexOf('/'))}image`)
  })
})

describe('holdsStoredFilePath', () => {
  it('finds an image path in a reference, in prose, and in JSON, on every call', () => {
    for (let call = 0; call < 2; call++) {
      expect(holdsStoredFilePath(`a ![${PNG}](id=a)`)).toBe(true)
      expect(holdsStoredFilePath(`a [${PNG}](id=a)`)).toBe(true)
      expect(holdsStoredFilePath(JSON.stringify({ thinking: `The user sent\n${JPG}` }))).toBe(true)
      expect(holdsStoredFilePath(`made ${GENERATED}`)).toBe(true)
    }
  })

  it('finds the path of a saved clip and of a temp copy', () => {
    for (const path of [AUDIO, VIDEO, CACHED, PASTED_AUDIO, PASTED_VIDEO]) {
      expect(holdsStoredFilePath(JSON.stringify({ thinking: `I made\n${path}` })), path).toBe(true)
    }
  })

  it('finds no path in other text', () => {
    expect(holdsStoredFilePath('/home/ann/Pictures/x.png and assets/images/x.png')).toBe(false)
    expect(holdsStoredFilePath(JSON.stringify({ thinking: 'The logo is in /var/www/app/assets/images/logo.png' }))).toBe(false)
    expect(holdsStoredFilePath('https://cdn.example/assets/generated/video/x.mp4 and media/x.mp4')).toBe(false)
  })
})
