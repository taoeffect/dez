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
    ['no metadata', `![](${PNG})`, '![](image)'],
    ['an id', `![id=a](${PNG})`, '![id=a](image)'],
    ['unknown keys and escaped values', String.raw`![id=b|desc=a \| b (c) \[d\] \\ e|x=](${PNG})`, String.raw`![id=b|desc=a \| b (c) \[d\] \\ e|x=](image)`],
    ['a home folder with spaces, parentheses, and non-ASCII names', '![id=a](</Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp>)', '![id=a](image)'],
    ['a path in <…> that needs none', `![id=a](<${PNG}>)`, '![id=a](image)'],
    ['a generated image', `![id=b](${GENERATED})`, '![id=b](image)'],
    ['items that are not the model mark but hold its key', `![id=a|desc=model=x|models=2](${PNG})`, '![id=a|desc=model=x|models=2](image)'],
  ])('sends a reference with %s as ](image) and its metadata as it is', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  it.each([
    ['the source that the Backspace rule leaves', `![id=a](${PNG}`, '![id=a](image'],
    ['the source of a path in <…> that the Backspace rule leaves', '![id=a](</Users/Zoë Ann/.config/dez/assets/images/x.png> more', '![id=a](image more'],
    ['the source after more Backspaces, with a part of the extension', `![id=a](${PNG.slice(0, -1)}`, '![id=a](image'],
    ['the link that the Delete rule leaves', `[id=a](${PNG})`, '[id=a](image)'],
    ['a reference with an id that is not valid', `![id=A](${PNG})`, '![id=A](image)'],
    ['a reference with a key given twice', `![id=a|id=b](${PNG})`, '![id=a|id=b](image)'],
    ['a reference of the old form, with the path first', `![${PNG}](id=a)`, '![image](id=a)'],
    ['a bare path', `see ${PNG} now`, 'see image now'],
    ['a bare generated path', `see ${GENERATED} now`, 'see image now'],
    ['a bare path of a copy of a shown picture', 'see /home/ann/.config/dez/assets/generated/views/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.jpg now', 'see image now'],
  ])('takes the path out of %s', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  // The model mark is for the view only (assetModels.ts): a request sends
  // the bytes of the reference with no mark.
  it.each([
    ['a reference of a reply', `![id=a|model=openai/gpt-image-1](${GENERATED})`, '![id=a](image)'],
    ['a reference of a job, whose other marks stay in their order', `![id=b|tool=model_invoke|model=venice/painter|made-by=j-k3x9|hidden=j-k3x9](${GENERATED})`, '![id=b|tool=model_invoke|made-by=j-k3x9|hidden=j-k3x9](image)'],
    ['a reference with only the mark', `![model=openai/gpt-image-1](${PNG})`, '![](image)'],
    ['a mark with an escaped char', String.raw`![model=a/b\|c|id=a](${PNG})`, '![id=a](image)'],
    ['a linked image in <…>', '![id=a|model=x/y](</home/ann/My photo.png>)', '![id=a](image)'],
    ['the source that the Backspace rule leaves', `![id=a|model=openai/gpt-image-1](${PNG.slice(0, -1)}`, '![id=a](image'],
    ['the source of a path in <…> that the Backspace rule leaves', '![id=a|model=x/y](</Users/Zoë Ann/.config/dez/assets/images/x.png> more', '![id=a](image more'],
  ])('leaves the model mark out of %s', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
  })

  it('takes the paths in metadata values and every path on a line, also of another home', () => {
    expect(withoutStoredFilePaths(`![id=a|desc=a /home/bob/.config/dez/assets/images/b.png](${PNG}) and ![id=b](${JPG})`))
      .toBe('![id=a|desc=a image](image) and ![id=b](image)')
  })

  it.each(['jpg', 'jpeg', 'gif', 'webp'])('takes a path with the extension %s', (extension) => {
    expect(withoutStoredFilePaths(`![id=a](/home/ann/.config/dez/assets/images/x.${extension})`)).toBe('![id=a](image)')
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
    expect(withoutStoredFilePaths(`![id=a](${PNG}) then ${AUDIO}`)).toBe('![id=a](image) then audio')
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

  it('takes the path of a linked image from every image reference and markdown link, also one that is not valid, and from the alt text of the old form', () => {
    const cases = [
      ['![id=a](</home/ann/Pictures/My photo (1).JPG>)', '![id=a](image)'],
      ['Back ![id=a](/home/ann/a.png', 'Back ![id=a](image'],
      ['Back ![id=a](</home/ann/My photo (1).png', 'Back ![id=a](image'],
      ['Back ![id=a](</home/ann/My photo (1).p\nmore', 'Back ![id=a](image\nmore'],
      ['Back ![id=a](/home/ann/a.pn more', 'Back ![id=a](image more'],
      ['Back ![](/home/', 'Back ![](image'],
      ['Back ![id=a](/home/ann/a.pngand more', 'Back ![id=a](imageand more'],
      ['Gone [id=a](</home/ann/My photo.png>)', 'Gone [id=a](image)'],
      ['Here ![id=b|tool=image](/home/ann/x.webp) and ![](/home/ann/y.svg)', 'Here ![id=b|tool=image](image) and ![](image)'],
      ['[x.png](/home/ann/x.png)', '[x.png](image)'],
      ['![/home/ann/Pictures/My photo (1).JPG](id=a)', '![image](id=a)'],
      ['[/home/ann/a.gif](https://example.com/a.gif)', '[image](https://example.com/a.gif)'],
    ]
    for (const [text, sent] of cases) expect(withoutStoredFilePaths(text), text).toBe(sent)
  })

  it('takes the path of a linked clip from the src of a media tag line, valid or not', () => {
    const cases = [
      ['<dez:video id="b" type="video/mp4" src="/home/ann/Videos/a b.mp4"/>', '<dez:video id="b" type="video/mp4" src="video"/>'],
      ['Hi\n<dez:audio id="c" src = "/home/ann/x.mp3" type=audio/mpeg>\nmore', 'Hi\n<dez:audio id="c" src = "audio" type=audio/mpeg>\nmore'],
    ]
    for (const [text, sent] of cases) expect(withoutStoredFilePaths(text), text).toBe(sent)
  })

  it('leaves a linked path that the user typed out of a reference, a link, or a tag as it is', () => {
    for (const text of ['Open /home/ann/Pictures/x.png', 'img src="/home/ann/a.png"', '<dez:image src="/home/ann/a.png"/>', '(/home/ann/x.png)']) {
      expect(withoutStoredFilePaths(text)).toBe(text)
    }
  })

  it('leaves a destination with no image path that a ) or a > ends, a link, and code as they are', () => {
    for (const text of ['![id=a](/home/ann/notes.txt)', '![id=a](</home/ann/My notes.txt>) more', '[docs](/api/v1 "Title")', 'f[0](/a b/)']) {
      expect(withoutStoredFilePaths(text)).toBe(text)
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

  // The code of an app can write the real path of its folder into a file,
  // which `apps read` shows.
  it.each([
    ['a file of an app', 'state: /home/ann/.config/dez/apps/notes/data/state.json (3 notes)', 'state: /apps/notes/data/state.json (3 notes)'],
    ['the folder of an app in a home folder with spaces', 'in /Users/Zoë Ann/.config/dez/apps/notes', 'in /apps/notes'],
    ['the folder of the apps itself', '"/home/ann/.config/dez/apps"', '"/apps"'],
    ['a file URL of a file of an app', 'at file:///home/ann/.config/dez/apps/notes/main.ts:12:3', 'at file:/apps/notes/main.ts:12:3'],
  ])('sends the path of %s as the path that the apps tool takes', (_case, text, sent) => {
    expect(withoutStoredFilePaths(text)).toBe(sent)
    expect(withoutStoredFilePaths(sent)).toBe(sent)
  })

  it('leaves the path of a folder next to the folder of the apps as it is', () => {
    for (const text of ['/home/ann/.config/dez/apps-old/notes/main.ts', '/home/ann/.config/dez/apps.zip', '/home/ann/.config/dez2/apps/notes']) {
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
      expect(holdsStoredFilePath(`a ![id=a](${PNG})`)).toBe(true)
      expect(holdsStoredFilePath(`a [id=a](${PNG})`)).toBe(true)
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
