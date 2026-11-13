import { describe, expect, it } from 'vitest'
import { messageClips, sectionsToStreamMessages } from '../streams/messages'
import { assetTextPieces, namedMentions, type MentionSection, type NamedMention } from './assetMentions'
import { sectionPlainText } from './content'
import { findImageReferences, imageMarkdown } from './images'
import { findMediaTags, mediaTagText, type MediaTagData } from './mediaTags'
import type { ModelRef, Section } from './types'

const RED = '/home/u/.config/dez/assets/images/red.png'
const FOX = '/home/u/.config/dez/assets/generated/images/fox.webp'
const LINKED = '/home/u/Pictures/@b/cat.png'
const image = (path: string, id: string) => imageMarkdown(path, [{ key: 'id', value: id }])
const SONG: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: null, other: [] }
const DANCE: MediaTagData = { kind: 'video', id: 'd', type: 'video/mp4', src: null, url: 'https://cdn.example/d.mp4', expires: '2026-12-01T00:00:00.000Z', other: [] }

const user = (text: string): MentionSection => ({ role: 'user', text })
const agent = (text: string): MentionSection => ({ role: 'agent', text })

/** The mentions of each section as the words that they cover, each with its
 *  kind. */
function named(sections: MentionSection[]): string[][] {
  return namedMentions(sections).map((mentions, index) => mentions.map(({ from, to, kind }) => `${sections[index].text.slice(from, to)}=${kind}`))
}

describe('assetTextPieces', () => {
  it('gives the tags, the references, and the gaps between them, in order, with their offsets', () => {
    const tag = mediaTagText(SONG)
    const text = `See ${image(RED, 'a')} and\n${tag}\n@a`

    expect(assetTextPieces(text, 'user').map((piece) => piece.kind === 'media' ? { kind: piece.kind, text: text.slice(piece.tag.from, piece.tag.to) } : { kind: piece.kind, text: text.slice(piece.from, piece.to) })).toStrictEqual([
      { kind: 'gap', text: 'See ' },
      { kind: 'reference', text: image(RED, 'a') },
      { kind: 'gap', text: ' and\n' },
      { kind: 'media', text: tag },
      { kind: 'gap', text: '\n@a' },
    ])
  })

  it('has no empty gap', () => {
    const text = `${image(RED, 'a')}${image(FOX, 'b')}`

    expect(assetTextPieces(text, 'user').map((piece) => piece.kind)).toStrictEqual(['reference', 'reference'])
    expect(assetTextPieces('', 'user')).toStrictEqual([])
  })

  it('reads a linked reference as a reference only in a user section', () => {
    const text = image(LINKED, 'a')

    expect(assetTextPieces(text, 'user')).toStrictEqual([{ kind: 'reference', from: 0, to: text.length, path: LINKED }])
    expect(assetTextPieces(text, 'agent')).toStrictEqual([{ kind: 'gap', from: 0, to: text.length }])
  })
})

describe('namedMentions', () => {
  it('gives the mentions that name an image or a clip of their own or an earlier section, with offsets and kinds', () => {
    const sections = [
      user(`${image(RED, 'a')}\nMake @a blue.`),
      agent(`Done: ${image(FOX, 'b')}\n${mediaTagText(SONG)}\n${mediaTagText(DANCE)}\nI put @a in @b.`),
      user('Put @b on (@a), with @c, as in @d.'),
    ]
    const first = sections[0].text.indexOf('@a')

    expect(namedMentions(sections)[0]).toStrictEqual<NamedMention[]>([{ from: first, to: first + 2, id: 'a', kind: 'image' }])
    expect(named(sections)).toStrictEqual([
      ['@a=image'],
      ['@a=image', '@b=image'],
      ['@b=image', '@a=image', '@c=audio', '@d=video'],
    ])
  })

  it('names an asset that comes later in the same section, and none of a later section', () => {
    expect(named([user(`First @a, then @b.\n${image(RED, 'a')}`), agent(image(FOX, 'b'))])).toStrictEqual([['@a=image'], []])
  })

  it('gives no mention for an id that no asset has, and for a word that is no mention', () => {
    expect(named([user(`${image(RED, 'a')}\n@b @zz bob@a.com @a-team @ab @A`)])).toStrictEqual([[]])
  })

  it('gives no mention for a conversation with no asset', () => {
    expect(named([user('Mail @a and @b'), agent('@a')])).toStrictEqual([[], []])
  })

  it('names the image when an image and a clip have one id, and the last clip of two', () => {
    const sections = [
      user(`${mediaTagText({ ...SONG, id: 'a' })}\n${mediaTagText({ ...SONG, id: 'e' })}`),
      agent(`${image(FOX, 'a')}\n${mediaTagText({ ...DANCE, id: 'e' })}`),
      user('@a and @e'),
    ]

    expect(named(sections)[2]).toStrictEqual(['@a=image', '@e=video'])
  })

  it('reads no mention in an image reference or in a media tag', () => {
    const linked = imageMarkdown(LINKED, [{ key: 'id', value: 'a' }, { key: 'note', value: 'see @b' }])
    const tag = mediaTagText({ ...SONG, id: 'b', other: [{ name: 'note', value: 'like @a' }] })

    expect(named([user(`${linked}\n${tag}`)])).toStrictEqual([[]])
  })

  // A linked reference is plain text in an agent section: it gives no id,
  // and a request takes its path out, so its line shows no mention.
  it('does not count a linked reference of an agent section', () => {
    const sections = [user(image(RED, 'b')), agent(`${image(LINKED, 'a')}\n@a and @b`)]

    expect(named(sections)).toStrictEqual([[], ['@b=image']])
  })

  it('leaves out a mention on a line whose path a request takes out, and keeps the other lines', () => {
    const sections = [user(`${image(RED, 'a')}\nOpen ${FOX} for @a\nThen @a\n![${RED}](id=a and @a`)]

    expect(named(sections)).toStrictEqual([['@a=image']])
    expect(namedMentions(sections)[0][0].from).toBe(sections[0].text.indexOf('Then @a') + 5)
  })
})

// The chips of the editor are these mentions, so they must agree with what
// a request sends for the newest user message.
describe('namedMentions and the request', () => {
  const model: ModelRef = { providerId: 'local', modelId: 'm' }

  /** What a request sends for the newest user message (the last section
   *  of `sections`): the paths of its image parts, and the ids of its
   *  clips. */
  function sent(sections: Section[]): { images: string[], clips: string[] } {
    const message = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true }).messages.findLast((entry) => entry.role === 'user')
    const parts = message && Array.isArray(message.content) ? message.content : []
    return {
      images: parts.flatMap((part) => (part.type === 'image' ? [part.path] : [])).sort(),
      clips: messageClips(sections).map((clip) => clip.id).sort(),
    }
  }

  /** The same, from the assets that the message holds and the ones that its
   *  mentions (`namedMentions`) name. */
  function namedByMessage(sections: Section[]): { images: string[], clips: string[] } {
    const sources = sections.map((entry) => ({ role: entry.role, text: sectionPlainText(entry) }))
    const pathsById = new Map(sources.flatMap(({ role, text }) => findImageReferences(text, role).flatMap(({ id, path }) => (id === null ? [] : [[id, path] as const]))))
    const message = sources[sources.length - 1]
    const mentions = namedMentions(sources)[sources.length - 1]
    const images = [
      ...findImageReferences(message.text, 'user').map(({ path }) => path),
      ...mentions.flatMap(({ id, kind }) => (kind === 'image' ? [pathsById.get(id) ?? ''] : [])),
    ]
    const clips = [
      ...findMediaTags(message.text).map(({ id }) => id).filter((id) => !pathsById.has(id)),
      ...mentions.flatMap(({ id, kind }) => (kind === 'image' ? [] : [id])),
    ]
    return { images: [...new Set(images)].sort(), clips: [...new Set(clips)].sort() }
  }

  /** A conversation of `texts`, whose sections take turns, the first one
   *  a user section. Each case ends with a user section. */
  function conversation(...texts: string[]): Section[] {
    return texts.map((text, index): Section => index % 2 === 0
      ? { id: `s${index}`, role: 'user', content: [{ kind: 'text', text }] }
      : { id: `s${index}`, role: 'agent', model, content: [{ kind: 'text', text }] })
  }
  const clips = `${mediaTagText(SONG)}\n${mediaTagText(DANCE)}`

  it.each([
    ['images and clips of earlier sections', conversation(image(RED, 'a'), `${image(FOX, 'b')}\n${clips}`, 'Put @b on (@a), with @c, as in @d. Not @zz.')],
    ['an image that the message holds and names', conversation(`@a first\n${image(RED, 'a')}\nand @a again`)],
    ['words that are no mentions', conversation(image(RED, 'a'), clips, 'bob@a.com, @a-team, @ab, and @c2')],
    ['an image and a clip with one id', conversation(`${image(RED, 'c')}\n${clips}`, 'ok', 'Use @c and @d')],
    ['a clip that the message holds and names', conversation('hi', clips, `${mediaTagText({ ...SONG, id: 'e' })}\n@e over @d`)],
    ['a mention in a reference and in a tag', conversation(image(RED, 'a'), clips, `${imageMarkdown(LINKED, [{ key: 'id', value: 'b' }, { key: 'note', value: '@a' }])}\n${mediaTagText({ ...SONG, id: 'e', other: [{ name: 'note', value: '@d' }] })}`)],
    ['a linked reference of an agent section', conversation('hi', image(LINKED, 'a'), '@a')],
    ['mentions next to a line with a bare path', conversation(image(RED, 'a'), image(FOX, 'b'), `Open ${FOX} now\nand @a with @b`)],
  ])('names what a request sends: %s', (_name, sections) => {
    expect(namedByMessage(sections)).toStrictEqual(sent(sections))
  })

  // The one difference (`namedMentions`): the request reads the line after
  // the path scrub, and takes its mention.
  it('names less than the request sends only on a line whose path the request takes out', () => {
    const sections = conversation(image(RED, 'a'), 'ok', `Open ${FOX} for @a`)

    expect(namedByMessage(sections)).toStrictEqual({ images: [], clips: [] })
    expect(sent(sections)).toStrictEqual({ images: [RED], clips: [] })
  })
})
