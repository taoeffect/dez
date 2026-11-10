import { describe, expect, it } from 'vitest'
import { SENTINEL_CHAR } from './content'
import {
  findMediaTags,
  labelMediaTags,
  mediaTagRequestText,
  mediaTagText,
  mediaTagsAsLinks,
  savedMediaTag,
  splitMediaTags,
  unsavedMediaTag,
  type MediaTagData,
} from './mediaTags'

const SAVED_VIDEO = '/home/u/.config/dez/assets/generated/video/9f3c.mp4'
const CACHED_VIDEO = '/home/u/.cache/dez/media/9f3c.mp4'
const URL = 'https://cdn.example/v.mp4?sig=1&exp=2'

const VIDEO: MediaTagData = {
  kind: 'video',
  id: 'b',
  type: 'video/mp4',
  src: SAVED_VIDEO,
  url: URL,
  expires: '2026-11-11T09:30:00.000Z',
  other: [],
}

const AUDIO: MediaTagData = {
  kind: 'audio',
  id: 'c',
  type: 'audio/mpeg',
  src: null,
  url: null,
  expires: null,
  other: [],
}

// The data of a tag in a text, with no offsets.
function read(text: string): MediaTagData[] {
  return findMediaTags(text).map(({ from: _from, to: _to, ...data }) => data)
}

describe('mediaTagText', () => {
  it('writes one self-closing line with the attributes in a fixed order', () => {
    expect(mediaTagText(VIDEO)).toBe(
      `<dez:video id="b" type="video/mp4" src="${SAVED_VIDEO}" url="https://cdn.example/v.mp4?sig=1&amp;exp=2" expires="2026-11-11T09:30:00.000Z"/>`,
    )
  })

  it('writes no attribute for a field that is null', () => {
    expect(mediaTagText(AUDIO)).toBe('<dez:audio id="c" type="audio/mpeg"/>')
  })

  it('writes the other attributes after the fields, in their order', () => {
    const tag = { ...AUDIO, other: [{ name: 'job', value: 'j-1' }, { name: 'duration', value: '8' }] }

    expect(mediaTagText(tag)).toBe('<dez:audio id="c" type="audio/mpeg" job="j-1" duration="8"/>')
  })

  it('does not write another attribute that has the name of a field', () => {
    const tag = { ...AUDIO, other: [{ name: 'src', value: '/tmp/other.mp3' }, { name: 'id', value: 'z' }] }

    expect(mediaTagText(tag)).toBe('<dez:audio id="c" type="audio/mpeg"/>')
  })

  it('keeps a value with a quote, an ampersand, or a line break on one line', () => {
    const tag = { ...AUDIO, url: 'https://x.example/a"b&c\nd\re' }
    const text = mediaTagText(tag)

    expect(text).toBe('<dez:audio id="c" type="audio/mpeg" url="https://x.example/a&quot;b&amp;c&#10;d&#13;e"/>')
    expect(read(text)).toStrictEqual([tag])
  })

  it('removes live sentinels from every value', () => {
    const text = mediaTagText({
      ...VIDEO,
      url: 'https://x.example/\u001Ea\uE002',
      other: [{ name: 'job', value: 'j\uE000id\uE001-1' }],
    })

    expect(SENTINEL_CHAR.test(text)).toBe(false)
    expect(read(text)).toStrictEqual([{ ...VIDEO, url: 'https://x.example/a', other: [{ name: 'job', value: 'j-1' }] }])
  })
})

describe('mediaTagRequestText', () => {
  it('writes only the id and the type', () => {
    const withJob: MediaTagData = { ...AUDIO, other: [{ name: 'job', value: 'j-1' }] }

    expect(mediaTagRequestText(VIDEO)).toBe('<dez:video id="b" type="video/mp4"/>')
    expect(mediaTagRequestText(withJob)).toBe('<dez:audio id="c" type="audio/mpeg"/>')
  })

  it('stays the same when the source of the clip changes', () => {
    const [tag] = findMediaTags(mediaTagText(VIDEO))
    const deleted = { ...tag, src: null, expires: null }

    expect(mediaTagRequestText(deleted)).toBe(mediaTagRequestText(tag))
  })
})

describe('findMediaTags', () => {
  it('reads back what mediaTagText writes', () => {
    for (const tag of [VIDEO, AUDIO, { ...VIDEO, src: CACHED_VIDEO, other: [{ name: 'job', value: 'j-1' }] }]) {
      expect(read(mediaTagText(tag))).toStrictEqual([tag])
    }
  })

  it('gives the offsets of each tag', () => {
    const video = mediaTagText(VIDEO)
    const audio = mediaTagText(AUDIO)
    const text = `Here it is:\n${video}\n\nAnd the sound:\n${audio}`
    const tags = findMediaTags(text)

    expect(tags.map((tag) => text.slice(tag.from, tag.to))).toStrictEqual([video, audio])
    expect(tags.map((tag) => tag.id)).toStrictEqual(['b', 'c'])
  })

  it('finds tags on lines next to each other, at the text start, and at the text end', () => {
    const text = `${mediaTagText(VIDEO)}\n${mediaTagText(AUDIO)}`

    expect(read(text)).toStrictEqual([VIDEO, AUDIO])
  })

  it('keeps the unknown attributes of a tag when one field changes', () => {
    const [tag] = findMediaTags('<dez:video id="b" job="j-1" type="video/mp4" src="https://cdn.example/v.mp4" seed="42" url="https://cdn.example/v.mp4"/>')

    expect(mediaTagText({ ...tag, src: SAVED_VIDEO })).toBe(
      `<dez:video id="b" type="video/mp4" src="${SAVED_VIDEO}" url="https://cdn.example/v.mp4" job="j-1" seed="42"/>`,
    )
  })

  it('reads an empty value as an attribute that is not there', () => {
    expect(read('<dez:audio id="c" type="audio/mpeg" src="" url="" expires=""/>')).toStrictEqual([AUDIO])
  })

  it('takes the first value of an attribute that comes twice', () => {
    expect(read('<dez:audio id="c" type="audio/mpeg" id="d" type="audio/wav"/>')).toStrictEqual([AUDIO])
  })

  it('reads a value that holds the end of a tag', () => {
    expect(read('<dez:audio id="c" type="audio/mpeg" url="https://x.example/a/>b"/>')).toStrictEqual([
      { ...AUDIO, url: 'https://x.example/a/>b' },
    ])
  })

  it('takes only a whole line as a tag', () => {
    const tag = mediaTagText(AUDIO)
    const notTags = [
      `See ${tag}`,
      ` ${tag}`,
      `${tag} and more`,
      `${tag} `,
      `${tag}\r\nnext`,
      '<dez:audio id="c"\ntype="audio/mpeg"/>',
      '<dez:audio id="c" type="audio/mpeg">',
      '<dez:audio id="c" type="audio/mpeg"></dez:audio>',
      '<\\dez:audio id="c" type="audio/mpeg"/>',
    ]

    for (const text of notTags) expect(findMediaTags(text), text).toStrictEqual([])
  })

  it('takes only the audio and video names', () => {
    for (const name of ['dez:videox', 'dez:image', 'dez:tool', 'dez:Audio', 'audio']) {
      expect(findMediaTags(`<${name} id="c" type="audio/mpeg"/>`), name).toStrictEqual([])
    }
  })

  it('takes no tag without a valid id and a type', () => {
    const notTags = [
      '<dez:audio type="audio/mpeg"/>',
      '<dez:audio id="" type="audio/mpeg"/>',
      '<dez:audio id="B2" type="audio/mpeg"/>',
      '<dez:audio id="a b" type="audio/mpeg"/>',
      '<dez:audio id="c"/>',
      '<dez:audio id="c" type=""/>',
      '<dez:audio id="c" type="  "/>',
      '<dez:audio/>',
    ]

    for (const text of notTags) expect(findMediaTags(text), text).toStrictEqual([])
  })

  it('finds a tag after a line that only looks like one', () => {
    const text = `<dez:audio id="B2" type="audio/mpeg"/>\nprose <dez:video\n${mediaTagText(AUDIO)}`

    expect(read(text)).toStrictEqual([AUDIO])
  })
})

describe('savedMediaTag and unsavedMediaTag', () => {
  const other = [{ name: 'job', value: 'q-1' }]

  it('keeps the URL and its end through a save and a delete', () => {
    const fromUrl: MediaTagData = { ...VIDEO, src: URL, other }
    const saved = savedMediaTag(fromUrl, SAVED_VIDEO)
    expect(saved).toStrictEqual({ ...fromUrl, src: SAVED_VIDEO })
    expect(unsavedMediaTag(saved)).toStrictEqual(fromUrl)
  })

  it('drops the end of a temp copy at the save, and the source at the delete', () => {
    const fromCopy: MediaTagData = { ...VIDEO, src: CACHED_VIDEO, url: null, other }
    const saved = savedMediaTag(fromCopy, SAVED_VIDEO)
    expect(saved).toStrictEqual({ ...fromCopy, src: SAVED_VIDEO, expires: null })
    expect(unsavedMediaTag(saved)).toStrictEqual({ ...fromCopy, src: null, expires: null })
  })

  it('keeps the offsets of a tag in a text', () => {
    const [tag] = findMediaTags(mediaTagText({ ...VIDEO, src: URL }))
    expect(savedMediaTag(tag, SAVED_VIDEO)).toStrictEqual({ ...tag, src: SAVED_VIDEO })
  })
})

describe('splitMediaTags', () => {
  it('gives the text and the tags in order, with the whitespace kept', () => {
    const text = `Done.\n\n${mediaTagText(VIDEO)}\n\nMore?\n`
    const pieces = splitMediaTags(text)

    expect(pieces.map((piece) => (piece.kind === 'text' ? piece.text : piece.tag.id))).toStrictEqual(['Done.\n\n', 'b', '\n\nMore?\n'])
  })

  it('leaves out empty text pieces', () => {
    expect(splitMediaTags(mediaTagText(AUDIO)).map((piece) => piece.kind)).toStrictEqual(['media'])
    expect(splitMediaTags('')).toStrictEqual([])
    expect(splitMediaTags('no tag')).toStrictEqual([{ kind: 'text', text: 'no tag' }])
  })
})

describe('labelMediaTags', () => {
  const text = `Done.\n${mediaTagText(VIDEO)}\n${mediaTagText(AUDIO)}\nEnd`

  it('puts the label of its kind in place of each tag', () => {
    expect(labelMediaTags(text)).toBe('Done.\n[video]\n[audio]\nEnd')
  })

  it('puts a given label in place of each tag', () => {
    expect(labelMediaTags(text, ' ')).toBe('Done.\n \n \nEnd')
  })
})

describe('mediaTagsAsLinks', () => {
  it('links to the saved file', () => {
    expect(mediaTagsAsLinks(`Done.\n${mediaTagText(VIDEO)}\nEnd`)).toBe(`Done.\n[video](${SAVED_VIDEO})\nEnd`)
  })

  it('puts a saved path that is no plain link destination in angle brackets', () => {
    const cases: [string, string][] = [
      ['/home/my user/.config/dez/assets/generated/audio/a1.mp3', '[audio](</home/my user/.config/dez/assets/generated/audio/a1.mp3>)'],
      ['/home/u (old)/.config/dez/assets/generated/audio/a1.mp3', '[audio](</home/u (old)/.config/dez/assets/generated/audio/a1.mp3>)'],
      ['/home/a<b>c\\d/.config/dez/assets/generated/audio/a1.mp3', '[audio](</home/a\\<b\\>c\\\\d/.config/dez/assets/generated/audio/a1.mp3>)'],
    ]

    for (const [src, link] of cases) expect(mediaTagsAsLinks(mediaTagText({ ...AUDIO, src }))).toBe(link)
  })

  it('links to the provider URL of a clip with no saved file', () => {
    expect(mediaTagsAsLinks(mediaTagText({ ...VIDEO, src: URL }))).toBe(`[video](${URL})`)
    expect(mediaTagsAsLinks(mediaTagText({ ...VIDEO, src: CACHED_VIDEO }))).toBe(`[video](${URL})`)
    expect(mediaTagsAsLinks(mediaTagText({ ...VIDEO, src: null }))).toBe(`[video](${URL})`)
  })

  it('gives only the label of a clip with no saved file and no URL', () => {
    expect(mediaTagsAsLinks(mediaTagText(AUDIO))).toBe('[audio]')
    expect(mediaTagsAsLinks(mediaTagText({ ...VIDEO, src: CACHED_VIDEO, url: null }))).toBe('[video]')
  })

  it('takes only a file directly in the media folder of the app as a saved file', () => {
    for (const src of [
      '/home/u/.config/dez/assets/generated/video/sub/9f3c.mp4',
      'home/u/.config/dez/assets/generated/video/9f3c.mp4',
      '/home/u/.config/dez/assets/generated/video/9f3c.mp4/more',
    ]) {
      expect(mediaTagsAsLinks(mediaTagText({ ...VIDEO, src, url: null })), src).toBe('[video]')
    }
  })

  it('gives only the label for a target with a line break', () => {
    expect(mediaTagsAsLinks(mediaTagText({ ...AUDIO, url: 'https://x.example/a\nb' }))).toBe('[audio]')
  })

  it('keeps a text with no tag as it is', () => {
    const text = 'A line with <dez:video id="b" type="video/mp4"/> in it.'

    expect(mediaTagsAsLinks(text)).toBe(text)
  })
})
