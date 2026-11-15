import { describe, expect, it } from 'vitest'
import { assetPlaces } from '../chat/assetOrigins'
import { CARRIED_USER_ASSETS_LABEL, sectionCompactionTag } from '../chat/compaction'
import { notesAssetLines } from '../chat/compactionNotes'
import { sectionPlainText } from '../chat/content'
import { findKeptAssets } from '../chat/hiddenAssets'
import { findImageReferences, imageMarkdown, imageReferenceText, isKeptImage } from '../chat/images'
import { findMediaTags, isKeptClip, mediaTagText, mediaTagTextWithKeptMark } from '../chat/mediaTags'
import type { ShownPicture } from '../chat/shownPictures'
import type { ModelRef, Section } from '../chat/types'
import { compactedSections, type CompactedSections, type CompactedSectionsInput } from './compactedSections'
import { assetDecisions, compactionAssets, compactionScope, keptUserTexts } from './compactionAssets'
import { readCompactionAnswer } from './compactionRequest'
import { conversationAssets } from './mediaRequest'
import { sectionsToStreamMessages } from './messages'
import { model, reply, user } from './testing'

const APP = '/home/u/.config/dez'
const pasted = (name: string) => `${APP}/assets/images/${name}.png`
const made = (name: string) => `${APP}/assets/generated/images/${name}.png`
const image = (path: string, id: string) => imageMarkdown(path, [{ key: 'id', value: id }])
const clip = (name: string, id: string) => mediaTagText({ kind: 'video', id, type: 'video/webm', src: `${APP}/assets/video/${name}.webm`, url: null, expires: null, other: [] })
// `text`, one image reference or one media tag, with the kept mark.
const kept = (text: string) => (text.startsWith('<')
  ? mediaTagTextWithKeptMark(findMediaTags(text)[0], true)
  : imageReferenceText(findImageReferences(text, 'user')[0], true))

/** The model of the compaction request, which is not the one of the
 *  replies (`model`). */
const NOTES_MODEL: ModelRef = { providerId: 'local', modelId: 'notes' }
const NOTES = '## Summary\nThe user wants foxes.'
const FACTS = 'PNG | 10x10 | 1 KB'
/** The file size of every image, unless a test gives its own sizes. */
const IMAGE_BYTES = 300
const picture = (file: string): ShownPicture => ({ file: `${file}.jpg`, label: `Frames of ${file}`, width: 100, height: 100, bytes: IMAGE_BYTES })

/** A compaction of `sections` with the answer `answerText`, through the
 *  steps that the controller takes. Every image has a file that Dez can
 *  read, and the limits are far away, unless `input` tells other ones. */
function compact(sections: Section[], answerText: string, replySectionId: string | null, input: Partial<CompactedSectionsInput> = {}, facts = FACTS): CompactedSections {
  const scope = compactionScope(sections, replySectionId)
  const found = [...conversationAssets(sections).found.values()].filter((asset) => asset.section < scope.end)
  const assets = compactionAssets(sections, found, assetPlaces(sections, found), new Map(found.map(({ id }) => [id, facts])))
  const answer = readCompactionAnswer(answerText)
  let ids = 0
  return compactedSections({
    sections,
    replySectionId,
    model: NOTES_MODEL,
    choices: assetDecisions(assets, answer, { jobInputs: new Set(), keptUserTexts: keptUserTexts(sections, scope) }),
    answer,
    jobs: [],
    cost: undefined,
    clipPictures: new Map(),
    sendImages: true,
    limits: { tokens: 1_000_000, bytes: 1_000_000, pictures: 20 },
    imageLimit: Infinity,
    rule: { rule: 'fixed', tokens: 100 },
    imageBytes: new Map(sections.flatMap((section) => findImageReferences(sectionPlainText(section), 'user').map(({ path }) => [path, IMAGE_BYTES]))),
    newId: () => `new-${++ids}`,
    ...input,
  })
}

/** The images and the pictures that the compaction message of `sections`
 *  sends, in its order. `sections` end before the section of the reply:
 *  a request reads the reply only when it has text. */
function sent(sections: Section[]): { images: string[], pictures: string[] } {
  const { messages } = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: false })
  expect(messages).toHaveLength(1)
  const [message] = messages
  if (message.role !== 'user' || typeof message.content === 'string') return { images: [], pictures: [] }
  const { content } = message
  return {
    images: content.flatMap((part) => (part.type === 'image' ? [part.path] : [])),
    pictures: content.flatMap((part) => (part.type === 'picture' ? [part.picture.file] : [])),
  }
}

/** The ids and the paths that the compaction chip of `sections` hides. */
function hidden(sections: Section[]): string[] {
  return findKeptAssets(sections.map((section) => ({ role: section.role, text: sectionPlainText(section) })))
    .flat()
    .map((asset) => (asset.kind === 'image' ? asset.image.id ?? asset.image.path : asset.tag.id))
}

const notesText = (result: CompactedSections) => sectionPlainText(result.sections[0])

describe('compactedSections', () => {
  it('puts the notes, the first message, and the newest message in place of the sections up to the reply, which goes on empty', () => {
    const sections = [
      user('u0', `Make a fox like ${image(pasted('photo'), 'a')}`),
      reply('r1', `Here it is.\n${image(made('fox'), 'b')}`),
      user('u1', 'Now make it red.'),
      reply('r2', 'I start the work.'),
      user('later', 'A draft of the next message'),
    ]
    const result = compact(sections, NOTES, 'r2')

    expect(result.sections.map(({ id, role }) => [id, role])).toStrictEqual([['new-1', 'agent'], ['u0', 'user'], ['u1', 'user'], ['r2', 'agent'], ['later', 'user']])
    expect(result.sections[1]).toBe(sections[0])
    expect(result.sections[2]).toBe(sections[2])
    expect(result.sections[3]).toStrictEqual({ id: 'r2', role: 'agent', model, content: [{ kind: 'text', text: '' }] })
    expect(result.sections[4]).toBe(sections[4])
    const [notes] = result.sections
    expect(notes).toMatchObject({ role: 'agent', model: NOTES_MODEL })
    expect(notes.thinking).toBeUndefined()
    expect(sectionCompactionTag(notes)).toMatchObject({ count: 1, lastId: 'b', pictures: [] })
    expect(notesText(result)).toContain('The user wants foxes.')
    expect(result.dropped).toStrictEqual([])
  })

  it('has no reply section for a compaction at a submit', () => {
    const sections = [user('u0', 'Make a fox'), reply('r1', 'Done.'), user('u1', 'Now a red one')]
    const result = compact(sections, NOTES, null)

    expect(result.sections.map(({ id }) => id)).toStrictEqual(['new-1', 'u0', 'u1'])
  })

  it('keeps a made asset that the answer does not name in the notes, as text only, with who made it', () => {
    const sections = [
      user('u0', `Make a fox like ${image(pasted('photo'), 'a')}`),
      reply('r1', `Here it is.\n${image(made('fox'), 'b')}`),
      user('u1', 'Now make it red.'),
      reply('r2', 'I start the work.'),
    ]
    const result = compact(sections, NOTES, 'r2')
    const head = result.sections.slice(0, 3)

    expect(notesText(result)).toContain(`${kept(image(made('fox'), 'b'))}\n@b | image | `)
    expect(notesAssetLines(notesText(result)).get('b')).toMatchObject({ facts: 'PNG, 10x10, 1 KB', origin: 'made by the model local/m' })
    expect(notesAssetLines(notesText(result)).get('a')).toMatchObject({ origin: 'from the user' })
    // The image of the first message goes by itself; the kept one sends
    // no pixels, and the chip shows it.
    expect(sent(head)).toStrictEqual({ images: [pasted('photo')], pictures: [] })
    expect(hidden(head)).toStrictEqual(['b'])
    // The calls are gone, but the origin is not.
    const found = [...conversationAssets(head).found.values()]
    expect(assetPlaces(head, found).map(({ origin, hidden: isHidden }, index) => [found[index].id, origin, isHidden])).toStrictEqual([
      ['b', { kind: 'carried', text: 'made by the model local/m' }, true],
      ['a', { kind: 'user' }, false],
    ])
  })

  it('carries the assets of the other messages of the user in one section after the first message', () => {
    const unnamed = imageMarkdown(pasted('old'))
    const sections = [
      user('u0', 'Start'),
      reply('r1', 'ok'),
      user('u1', `Use ${image(pasted('one'), 'a')} and\n${clip('song', 'b')}\nand ${unnamed}`),
      reply('r2', 'ok'),
      user('u2', `And ${image(pasted('two'), 'c')}`),
      reply('r3', 'ok'),
      user('u3', 'Go on'),
      reply('r4', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@c: show - the second photo`, 'r4')

    expect(result.sections.map(({ id, role }) => [id, role])).toStrictEqual([['new-1', 'agent'], ['u0', 'user'], ['new-2', 'user'], ['u3', 'user'], ['r4', 'agent']])
    expect(sectionPlainText(result.sections[2]).split('\n')).toStrictEqual([
      CARRIED_USER_ASSETS_LABEL,
      kept(image(pasted('one'), 'a')),
      kept(clip('song', 'b')),
      kept(unnamed),
      image(pasted('two'), 'c'),
    ])
    const head = result.sections.slice(0, 4)
    expect(sent(head)).toStrictEqual({ images: [pasted('two')], pictures: [] })
    expect(hidden(head)).toStrictEqual(['a', 'b', pasted('old')])
    // An asset of the user has its line in the notes, and its text only in
    // the user section.
    expect([...notesAssetLines(notesText(result)).keys()]).toStrictEqual(['a', 'b', 'c'])
    expect(findImageReferences(notesText(result), 'user')).toStrictEqual([])
  })

  it('takes the assets of the carried section and of the newest message of the compaction before into the new carried section', () => {
    const first = compact([
      user('u0', 'Start'),
      reply('r1', 'ok'),
      user('u1', `Use ${image(pasted('one'), 'a')}`),
      reply('r2', 'ok'),
      user('u2', `Then ${image(pasted('two'), 'b')}`),
      reply('r3', 'working'),
    ], NOTES, 'r3')
    expect(first.sections.map(({ id }) => id)).toStrictEqual(['new-1', 'u0', 'new-2', 'u2', 'r3'])
    const sections = [...first.sections.slice(0, 4), reply('r3', 'Done.'), user('u3', 'One more'), reply('r4', 'working')]
    const result = compact(sections, NOTES, 'r4')

    expect(result.sections.map(({ id }) => id)).toStrictEqual(['new-1', 'u0', 'new-2', 'u3', 'r4'])
    expect(sectionPlainText(result.sections[2]).split('\n')).toStrictEqual([
      CARRIED_USER_ASSETS_LABEL,
      kept(image(pasted('one'), 'a')),
      kept(image(pasted('two'), 'b')),
    ])
    expect(sectionCompactionTag(result.sections[0])).toMatchObject({ count: 2, lastId: 'b' })
  })

  it('takes a dropped asset out of the conversation, and keeps its id out of the new ids', () => {
    const first = compact([
      user('u0', 'Make two foxes'),
      reply('r1', `${image(made('one'), 'a')}\n${image(made('two'), 'b')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: keep - The first fox.\n@b: keep - The second fox.`, 'r2')
    const sections = [...first.sections.slice(0, 3), reply('r2', 'Done.'), user('u2', 'Only the second one'), reply('r3', 'working')]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: drop - not needed\n@b: show - The final fox.`, 'r3', {}, 'JPEG | 5x5 | 2 KB')

    expect(result.dropped.map(({ asset }) => asset.id)).toStrictEqual(['a'])
    expect(notesText(result)).not.toContain(made('one'))
    // The line of the kept one has the facts of its old line: Dez reads
    // no file again.
    expect([...notesAssetLines(notesText(result)).values()]).toStrictEqual([
      { id: 'b', kind: 'image', facts: 'PNG, 10x10, 1 KB', origin: 'made by the model local/m', sentence: 'The final fox.' },
    ])
    expect(sectionCompactionTag(result.sections[0])).toMatchObject({ count: 2, lastId: 'b' })
    expect(sent(result.sections.slice(0, 3))).toStrictEqual({ images: [made('two')], pictures: [] })
    expect(hidden(result.sections.slice(0, 3))).toStrictEqual([])
  })

  it('keeps the sentence of the compaction before for an asset that the answer does not name', () => {
    const first = compact([
      user('u0', 'Make a fox'),
      reply('r1', image(made('one'), 'a')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: keep - The first fox.`, 'r2')
    const sections = [...first.sections.slice(0, 3), reply('r2', 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const result = compact(sections, NOTES, 'r3')

    expect(notesAssetLines(notesText(result)).get('a')).toMatchObject({ sentence: 'The first fox.', origin: 'made by the model local/m' })
  })

  it('shows the assets that the answer wants to see in the order of its lines, up to half of the limits', () => {
    const sections = [
      user('u0', `Make foxes like ${image(pasted('photo'), 'a')}`),
      reply('r1', `${image(made('one'), 'b')}\n${image(made('two'), 'c')}\n${image(made('three'), 'd')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const answer = `${NOTES}\n## Assets\n@d: show - third\n@b: show - first\n@c: show - second`
    const result = compact(sections, answer, 'r2', { limits: { tokens: 1_000_000, bytes: 1_000_000, pictures: 4 } })

    // Two of the four pictures of a request are for the notes.
    expect(sent(result.sections.slice(0, 3))).toStrictEqual({ images: [made('one'), made('three'), pasted('photo')], pictures: [] })
    expect(hidden(result.sections.slice(0, 3))).toStrictEqual(['c'])
  })

  it('keeps an asset that does not fit as text, and still shows a smaller one after it', () => {
    const sections = [
      user('u0', 'Make foxes'),
      reply('r1', `${image(made('large'), 'a')}\n${image(made('small'), 'b')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: show - large\n@b: show - small`, 'r2', {
      limits: { tokens: 1_000_000, bytes: 4000, pictures: 20 },
      imageBytes: new Map([[made('large'), 3000], [made('small'), 300]]),
    })

    expect(sent(result.sections.slice(0, 3))).toStrictEqual({ images: [made('small')], pictures: [] })
  })

  it('counts an image that a kept message names with @id only once against the budget', () => {
    const sections = [
      user('u0', 'Make a fox'),
      reply('r1', image(made('one'), 'a')),
      user('u1', 'Change @a'),
      reply('r2', 'working'),
    ]
    // The mention sends the image, so its reference in the notes costs
    // nothing more: a sum of the assets would be over the one picture.
    const result = compact(sections, `${NOTES}\n## Assets\n@a: show - the fox`, 'r2', { limits: { tokens: 1_000_000, bytes: 1_000_000, pictures: 1 } })

    expect(sent(result.sections.slice(0, 3))).toStrictEqual({ images: [made('one')], pictures: [] })
    expect(hidden(result.sections.slice(0, 3))).toStrictEqual([])
  })

  it('sends the last images of the first message as text when the kept messages hold more images than one message can', () => {
    const sections = [
      user('u0', `${image(pasted('one'), 'a')} then ${image(pasted('two'), 'b')} then ${image(pasted('three'), 'c')}`),
      reply('r1', 'ok'),
      user('u1', `${image(pasted('four'), 'd')} and ${image(pasted('five'), 'e')}`),
      reply('r2', 'working'),
    ]
    const result = compact(sections, NOTES, 'r2', { imageLimit: 3 })
    const head = result.sections.slice(0, 3)

    expect(sectionPlainText(head[1])).toBe(`${image(pasted('one'), 'a')} then ${kept(image(pasted('two'), 'b'))} then ${kept(image(pasted('three'), 'c'))}`)
    expect(head[2]).toBe(sections[2])
    expect(sent(head)).toStrictEqual({ images: [pasted('one'), pasted('four'), pasted('five')], pictures: [] })
    // The user still sees them at their place.
    expect(hidden(head)).toStrictEqual([])
  })

  it('leaves an image of a prompt pill as it is, and still ends', () => {
    const pill = { kind: 'prompt' as const, id: 'p1', promptId: null, name: 'Style', body: `Like ${image(pasted('style'), 'a')}`, expanded: false }
    const sections: Section[] = [
      { id: 'u0', role: 'user', content: [pill, { kind: 'text', text: ` and ${image(pasted('photo'), 'b')}` }] },
      reply('r1', 'working'),
    ]
    const result = compact(sections, NOTES, 'r1', { imageLimit: 0 })

    expect(result.sections[1].content).toStrictEqual([pill, { kind: 'text', text: ` and ${kept(image(pasted('photo'), 'b'))}` }])
  })

  it('sends an image whose file Dez cannot read as text', () => {
    const sections = [
      user('u0', `Like ${image(pasted('gone'), 'a')} and ${image(pasted('photo'), 'b')}`),
      reply('r1', image(made('lost'), 'c')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@c: show - the fox`, 'r2', { imageBytes: new Map([[pasted('photo'), IMAGE_BYTES]]) })
    const head = result.sections.slice(0, 3)

    expect(sectionPlainText(head[1])).toBe(`Like ${kept(image(pasted('gone'), 'a'))} and ${image(pasted('photo'), 'b')}`)
    expect(sent(head)).toStrictEqual({ images: [pasted('photo')], pictures: [] })
  })

  it('sets the marks of a kept message new at each compaction', () => {
    const first = compact([
      user('u0', `${image(pasted('one'), 'a')} then ${image(pasted('two'), 'b')}`),
      reply('r1', 'working'),
    ], NOTES, 'r1', { imageLimit: 1 })
    expect(sent(first.sections.slice(0, 2)).images).toStrictEqual([pasted('one')])
    const sections = [...first.sections.slice(0, 2), reply('r1', 'Done.'), user('u1', 'More'), reply('r2', 'working')]
    const result = compact(sections, NOTES, 'r2')

    expect(sectionPlainText(result.sections[1])).toBe(`${image(pasted('one'), 'a')} then ${image(pasted('two'), 'b')}`)
    expect(sent(result.sections.slice(0, 3)).images).toStrictEqual([pasted('one'), pasted('two')])
  })

  it('shows a clip as the picture of the tag, and keeps a clip with no picture as text', () => {
    const sections = [
      user('u0', `Cut this\n${clip('source', 'a')}`),
      reply('r1', `Two cuts.\n${clip('first', 'b')}\n${clip('second', 'c')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const answer = `${NOTES}\n## Assets\n@c: show - second cut\n@a: show - the source\n@b: show - first cut`
    const result = compact(sections, answer, 'r2', { clipPictures: new Map([['a', picture('a')], ['b', picture('b')]]) })
    const head = result.sections.slice(0, 3)

    // In the order of the assets of the notes, not of the answer.
    expect(result.pictures).toStrictEqual([picture('a'), picture('b')])
    expect(sectionCompactionTag(head[0])?.pictures).toStrictEqual([picture('a'), picture('b')])
    expect(sent(head)).toStrictEqual({ images: [], pictures: ['a.jpg', 'b.jpg'] })
    expect(findMediaTags(notesText(result)).map((tag) => [tag.id, isKeptClip(tag)])).toStrictEqual([['b', false], ['c', true]])
    // The clip of the first message stays in it, as it is.
    expect(head[1]).toBe(sections[0])
  })

  it('does not carry the pictures of the compaction before', () => {
    const first = compact([
      user('u0', 'Make a clip'),
      reply('r1', clip('first', 'a')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: show - the clip`, 'r2', { clipPictures: new Map([['a', picture('a')]]) })
    expect(first.pictures).toStrictEqual([picture('a')])
    const sections = [...first.sections.slice(0, 3), reply('r2', 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: keep - the clip`, 'r3')

    expect(result.pictures).toStrictEqual([])
    expect(sectionCompactionTag(result.sections[0])?.pictures).toStrictEqual([])
    expect(findMediaTags(notesText(result)).map((tag) => [tag.id, isKeptClip(tag)])).toStrictEqual([['a', true]])
  })

  it('shows no asset to a model that reads no images', () => {
    const sections = [
      user('u0', 'Make a fox and a clip'),
      reply('r1', `${image(made('one'), 'a')}\n${clip('first', 'b')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const answer = `${NOTES}\n## Assets\n@a: show - the fox\n@b: show - the clip`
    const result = compact(sections, answer, 'r2', { sendImages: false, clipPictures: new Map([['b', picture('b')]]) })

    expect(result.pictures).toStrictEqual([])
    expect(findImageReferences(notesText(result), 'agent').map(isKeptImage)).toStrictEqual([true])
    expect(findMediaTags(notesText(result)).map(isKeptClip)).toStrictEqual([true])
  })

  it('keeps a made image with no id, which no line can name, for the user', () => {
    const unnamed = imageMarkdown(made('old'))
    const first = compact([
      user('u0', 'Make a fox'),
      reply('r1', `Here.\n${unnamed}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], NOTES, 'r2')
    expect(hidden(first.sections.slice(0, 3))).toStrictEqual([made('old')])
    expect(sent(first.sections.slice(0, 3)).images).toStrictEqual([])

    const sections = [...first.sections.slice(0, 3), reply('r2', 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const second = compact(sections, NOTES, 'r3')
    expect(hidden(second.sections.slice(0, 3))).toStrictEqual([made('old')])
  })
})
