import { describe, expect, it } from 'vitest'
import { assetPlaces } from '../chat/assetOrigins'
import { blockLinkedRule, sectionCompactionBlock, sectionTextParts } from '../chat/compaction'
import { notesAssetLines, notesMessages } from '../chat/compactionNotes'
import { sectionPlainText, textNode } from '../chat/content'
import { findKeptAssets } from '../chat/hiddenAssets'
import { findImageReferences, imageMarkdown, imageReferenceTextWithKeptMark, isKeptImage } from '../chat/images'
import { findMediaTags, isKeptClip, mediaTagText, mediaTagTextWithKeptMark } from '../chat/mediaTags'
import type { ShownPicture } from '../chat/shownPictures'
import { idImage } from '../chat/testing'
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
const clip = (name: string, id: string) => mediaTagText({ kind: 'video', id, type: 'video/webm', src: `${APP}/assets/video/${name}.webm`, url: null, expires: null, other: [] })
// `text`, one image reference or one media tag, with the kept mark.
const kept = (text: string) => (text.startsWith('<')
  ? mediaTagTextWithKeptMark(findMediaTags(text)[0], true)
  : imageReferenceTextWithKeptMark(findImageReferences(text, 'user')[0], true))

/** The model of the compaction request, which is not the one of the
 *  replies (`model`). */
const NOTES_MODEL: ModelRef = { providerId: 'local', modelId: 'notes' }
const NOTES = '## Summary\nThe user wants foxes.'
const FACTS = 'PNG | 10x10 | 1 KB'
/** The file size of every image, unless a test gives its own sizes. */
const IMAGE_BYTES = 300
/** Limits that are far away, with `pictures` as the count. */
const withPictures = (pictures: number) => ({ tokens: 1_000_000, bytes: 1_000_000, pictures })
const picture = (file: string): ShownPicture => ({ file: `${file}.jpg`, label: `Frames of ${file}`, width: 100, height: 100, bytes: IMAGE_BYTES })

/** A compaction of `sections` with the answer `answerText`, through the
 *  steps that the controller takes. Every image has a file that Dez can
 *  read, and the limits are far away, unless `input` tells other ones. */
function compact(sections: Section[], answerText: string, replySectionId: string, input: Partial<CompactedSectionsInput> = {}, facts = FACTS): CompactedSections {
  const scope = compactionScope(sections, replySectionId)
  const found = [...conversationAssets(sections).found.values()].filter((asset) => asset.section < scope.end)
  const assets = compactionAssets({ sections, scope, found, places: assetPlaces(sections, found), facts: new Map(found.map(({ id }) => [id, facts])), jobInputs: new Map() })
  const answer = readCompactionAnswer(answerText)
  let ids = 0
  return compactedSections({
    sections,
    replySectionId,
    model: NOTES_MODEL,
    choices: assetDecisions(assets, answer, { keptTexts: keptUserTexts(sections, scope) }),
    answer,
    jobs: [],
    jobInputs: new Map(),
    cost: undefined,
    clipPictures: new Map(),
    sendImages: true,
    limits: withPictures(20),
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

/** The ids and the paths of the assets of `sections` that the compaction
 *  chips hide with the kept mark: the ones that a request sends as text
 *  only. The chips hide the other assets of the block too. */
function hidden(sections: Section[]): string[] {
  return findKeptAssets(sections.map((section) => ({ role: section.role, text: sectionPlainText(section) })))
    .flat()
    .filter((asset) => (asset.kind === 'image' ? isKeptImage(asset.image) : isKeptClip(asset.tag)))
    .map((asset) => (asset.kind === 'image' ? asset.image.id ?? asset.image.path : asset.tag.id))
}

const notesText = (result: CompactedSections) => sectionCompactionBlock(result.sections[0])?.notes ?? ''
/** The texts of the message parts of the notes of `result`. */
const messagesOf = (result: CompactedSections) => notesMessages(notesText(result)).map((message) => message.text)
/** The compaction section of `result`, which a request sends alone. */
const headOf = (result: CompactedSections) => result.sections.slice(0, 1)
/** The compaction section of `result` after the reply that ran it wrote
 *  `text` after the block. */
const replied = (result: CompactedSections, text: string): Section => ({
  ...result.sections[0],
  content: [textNode(sectionPlainText(result.sections[0]) + text)],
})

describe('compactedSections', () => {
  it('puts the notes, with the first and the newest message of the user, in place of the sections up to the reply, into the section of the reply', () => {
    const sections = [
      user('u0', `Make a fox like ${idImage(pasted('photo'), 'a')}`),
      reply('r1', `Here it is.\n${idImage(made('fox'), 'b')}`),
      user('u1', 'Now make it red.'),
      { ...reply('r2', 'I start the work.'), thinking: { text: 'Plan the work.' }, durationMs: 5 },
      user('later', 'A draft of the next message'),
    ]
    const result = compact(sections, NOTES, 'r2')

    expect(result.sections.map(({ id, role }) => [id, role])).toStrictEqual([['r2', 'agent'], ['later', 'user']])
    expect(result.sections[1]).toBe(sections[4])
    const [first] = result.sections
    const block = sectionCompactionBlock(first)
    // The reply keeps its model; its text, thinking, and time start new
    // after the block, on a line of their own.
    expect(first).toStrictEqual({ id: 'r2', role: 'agent', model, content: [textNode(`${sectionPlainText(first).slice(0, block!.to)}\n`)] })
    expect(sectionTextParts(first, 0)).toMatchObject({ text: '', from: block!.to + 1 })
    expect(block).toMatchObject({ count: 1, lastId: 'b', dropped: 0, pictures: [] })
    expect(block?.linked).toBeUndefined()
    expect(messagesOf(result)).toStrictEqual([`Make a fox like ${idImage(pasted('photo'), 'a')}`, 'Now make it red.'])
    expect(notesText(result)).toContain('The user wants foxes.')
    expect(result.dropped).toStrictEqual([])
  })

  it('puts the notes into the empty section of the new reply for a compaction at a submit', () => {
    const sections = [user('u0', 'Make a fox'), reply('r1', 'Done.'), user('u1', 'Now a red one'), reply('r2', '')]
    const result = compact(sections, NOTES, 'r2')

    expect(result.sections.map(({ id }) => id)).toStrictEqual(['r2'])
    expect(messagesOf(result)).toStrictEqual(['Make a fox', 'Now a red one'])
  })

  it('gives the section a new id and the model of the notes when no section is the one of the reply', () => {
    const result = compact([user('u0', 'Make a fox'), reply('r1', 'Done.')], NOTES, 'gone')

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({ id: 'new-1', role: 'agent', model: NOTES_MODEL })
    expect(messagesOf(result)).toStrictEqual(['Make a fox'])
  })

  it('writes one message part when the user wrote one message', () => {
    const result = compact([user('u0', 'Make a fox'), reply('r1', 'working')], NOTES, 'r1')

    expect(messagesOf(result)).toStrictEqual(['Make a fox'])
    expect(notesText(result).startsWith('## First and newest message of the user\n')).toBe(true)
  })

  it('keeps a made asset that the answer does not name in the notes, as text only, with who made it', () => {
    const sections = [
      user('u0', `Make a fox like ${idImage(pasted('photo'), 'a')}`),
      reply('r1', `Here it is.\n${idImage(made('fox'), 'b')}`),
      user('u1', 'Now make it red.'),
      reply('r2', 'I start the work.'),
    ]
    const result = compact(sections, NOTES, 'r2')
    const head = headOf(result)

    expect(notesText(result)).toContain(`${kept(idImage(made('fox'), 'b'))}\n@b | image | `)
    expect(notesAssetLines(notesText(result)).get('b')).toMatchObject({ facts: 'PNG, 10x10, 1 KB', origin: 'made by the model local/m' })
    expect(notesAssetLines(notesText(result)).get('a')).toMatchObject({ origin: 'from the user' })
    // The image of the first message goes by itself; the kept one sends
    // no pixels.
    expect(sent(head)).toStrictEqual({ images: [pasted('photo')], pictures: [] })
    expect(hidden(head)).toStrictEqual(['b'])
    // The calls are gone, but the origin is not. The assets chip shows
    // every asset of the block.
    const found = [...conversationAssets(head).found.values()]
    expect(assetPlaces(head, found).map(({ origin, hidden: isHidden }, index) => [found[index].id, origin, isHidden])).toStrictEqual([
      ['a', { kind: 'user' }, true],
      ['b', { kind: 'carried', text: 'made by the model local/m' }, true],
    ])
  })

  it('keeps the assets of the other messages of the user in the notes, each with its text before its line', () => {
    const unnamed = imageMarkdown(pasted('old'))
    const sections = [
      user('u0', 'Start'),
      reply('r1', 'ok'),
      user('u1', `Use ${idImage(pasted('one'), 'a')} and\n${clip('song', 'b')}\nand ${unnamed}`),
      reply('r2', 'ok'),
      user('u2', `And ${idImage(pasted('two'), 'c')}`),
      reply('r3', 'ok'),
      user('u3', 'Go on'),
      reply('r4', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@c: show - the second photo`, 'r4')
    const head = headOf(result)

    expect(result.sections.map(({ id }) => id)).toStrictEqual(['r4'])
    expect(messagesOf(result)).toStrictEqual(['Start', 'Go on'])
    expect(notesText(result)).toContain(`${kept(idImage(pasted('one'), 'a'))}\n@a | `)
    expect(notesText(result)).toContain(`${kept(clip('song', 'b'))}\n@b | `)
    expect(notesText(result)).toContain(`${idImage(pasted('two'), 'c')}\n@c | `)
    expect(notesText(result)).toContain(kept(unnamed))
    expect(sent(head)).toStrictEqual({ images: [pasted('two')], pictures: [] })
    expect(hidden(head)).toStrictEqual(['a', 'b', pasted('old')])
    expect([...notesAssetLines(notesText(result)).values()].map(({ id, origin }) => [id, origin])).toStrictEqual([['a', 'from the user'], ['b', 'from the user'], ['c', 'from the user']])
  })

  it('copies the first message from the notes at a later compaction, and keeps the assets of the newest message before as lines of the user', () => {
    const first = compact([
      user('u0', `Start with ${idImage(pasted('zero'), 'a')}`),
      reply('r1', 'ok'),
      user('u1', 'More'),
      reply('r2', 'ok'),
      user('u2', `Then ${idImage(pasted('two'), 'b')}`),
      reply('r3', 'working'),
    ], NOTES, 'r3')
    expect(first.sections.map(({ id }) => id)).toStrictEqual(['r3'])
    const sections = [replied(first, 'Done.'), user('u3', 'One more'), reply('r4', 'working')]
    const result = compact(sections, NOTES, 'r4')

    expect(result.sections.map(({ id }) => id)).toStrictEqual(['r4'])
    expect(messagesOf(result)).toStrictEqual([`Start with ${idImage(pasted('zero'), 'a')}`, 'One more'])
    expect(notesText(result)).toContain(`${kept(idImage(pasted('two'), 'b'))}\n@b | `)
    expect(notesAssetLines(notesText(result)).get('b')).toMatchObject({ origin: 'from the user' })
    expect(sent(headOf(result)).images).toStrictEqual([pasted('zero')])
    expect(sectionCompactionBlock(result.sections[0])).toMatchObject({ count: 2, lastId: 'b' })
  })

  it('keeps the newest message of the notes while no message of the user came after it', () => {
    const first = compact([user('u0', 'Start'), reply('r1', 'ok'), user('u1', 'Go on'), reply('r2', 'working')], NOTES, 'r2')
    const result = compact([replied(first, 'Still working.')], NOTES, 'r2')

    expect(messagesOf(result)).toStrictEqual(['Start', 'Go on'])
  })

  // A user gave the linked files, so they still count in the block, where
  // a linked path counts only when the tag lists it.
  it('lists the linked paths of the two messages and of the other assets of the user in the tag, and no path that a model wrote', () => {
    const linked = (name: string) => `/home/u/Pictures/${name}.png`
    const linkedClip = mediaTagText({ kind: 'audio', id: 'c', type: 'audio/wav', src: '/home/u/Music/song.wav', url: null, expires: null, other: [] })
    const sections = [
      user('u0', `Like ${idImage(linked('first'), 'a')}`),
      reply('r1', `Copied: ${imageMarkdown(linked('model'))}`),
      user('u1', `And ${idImage(linked('other'), 'b')}\n${linkedClip}\nand ${imageMarkdown(linked('old'))}`),
      reply('r2', 'ok'),
      user('u2', 'Go on'),
      reply('r3', 'working'),
    ]
    const result = compact(sections, `## Summary\nSee ${imageMarkdown(linked('model'))}.`, 'r3')
    const block = sectionCompactionBlock(result.sections[0])

    expect(block?.linked).toStrictEqual([linked('first'), linked('other'), '/home/u/Music/song.wav', linked('old')])
    const rule = blockLinkedRule(block!)
    // The path of the model stays text: no file of the computer.
    expect(notesText(result)).toContain(linked('model'))
    expect(findImageReferences(notesText(result), rule).map(({ path }) => path)).toStrictEqual([linked('first'), linked('other'), linked('old')])
    expect(sent(headOf(result)).images).toStrictEqual([linked('first')])
  })

  // The dropped id is the highest one, so a tag that read only the ids
  // that stay would give `a`.
  it('takes a dropped asset out of the conversation, and keeps its id out of the new ids', () => {
    const first = compact([
      user('u0', 'Make two foxes'),
      reply('r1', `${idImage(made('one'), 'a')}\n${idImage(made('two'), 'b')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: keep - The first fox.\n@b: keep - The second fox.`, 'r2')
    const sections = [replied(first, 'Done.'), user('u2', 'Only the first one'), reply('r3', 'working')]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: show - The final fox.\n@b: drop - not needed`, 'r3', {}, 'JPEG | 5x5 | 2 KB')

    expect(result.dropped.map(({ asset }) => asset.id)).toStrictEqual(['b'])
    expect(notesText(result)).not.toContain(made('two'))
    // The line of the kept one has the facts of its old line: Dez reads
    // no file again.
    expect([...notesAssetLines(notesText(result)).values()]).toStrictEqual([
      { id: 'a', kind: 'image', facts: 'PNG, 10x10, 1 KB', origin: 'made by the model local/m', sentence: 'The final fox.', byReply: false },
    ])
    expect(sectionCompactionBlock(result.sections[0])).toMatchObject({ count: 2, lastId: 'b', dropped: 1 })
    expect(sent(headOf(result))).toStrictEqual({ images: [made('one')], pictures: [] })
    expect(hidden(headOf(result))).toStrictEqual([])
  })

  it('drops at the first compaction an asset of an earlier reply that the answer has no line for, and keeps one of the reply that runs', () => {
    const sections = [
      user('u0', 'Make a fox'),
      reply('r1', idImage(made('fox'), 'a')),
      user('u1', 'Now a hare'),
      reply('r2', `${idImage(made('hare'), 'b')}\n${idImage(made('draft'), 'c')}`),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@b: keep - The hare.`, 'r2')

    expect(result.dropped.map(({ asset }) => asset.id)).toStrictEqual(['a'])
    expect(notesText(result)).not.toContain(made('fox'))
    expect([...notesAssetLines(notesText(result)).values()].map(({ id, byReply }) => [id, byReply])).toStrictEqual([['b', true], ['c', true]])
    expect(sectionCompactionBlock(result.sections[0])).toMatchObject({ count: 1, lastId: 'c', dropped: 1 })
  })

  it('keeps an unnamed asset of the reply that runs at its next compaction, and drops it once a later reply runs', () => {
    const first = compact([
      user('u0', 'Make a fox'),
      reply('r1', 'ok'),
      user('u1', 'Go on'),
      reply('r2', `${idImage(made('fox'), 'a')}\n${idImage(made('hare'), 'b')}`),
    ], NOTES, 'r2')
    // The same reply goes on after the block and makes `c`: no message of
    // the user came after the first compaction. The second compaction
    // takes the place of the text of the reply too, and the reply keeps
    // its section.
    const second = compact([replied(first, idImage(made('cat'), 'c'))], `${NOTES}\n## Assets\n@c: keep - The cat.`, 'r2')

    expect(second.sections.map(({ id }) => id)).toStrictEqual(['r2'])
    expect(sectionTextParts(second.sections[0], 0).text).toBe('')
    expect(sectionCompactionBlock(second.sections[0])).toMatchObject({ count: 2 })
    expect(second.dropped).toStrictEqual([])
    expect([...notesAssetLines(notesText(second)).values()].map(({ id, byReply }) => [id, byReply])).toStrictEqual([['a', true], ['b', true], ['c', true]])

    const sections = [replied(second, 'Done.'), user('u2', 'Only the cat now'), reply('r3', 'working')]
    const third = compact(sections, `${NOTES}\n## Assets\n@c: keep - The cat.`, 'r3')

    expect(third.dropped.map(({ asset }) => asset.id)).toStrictEqual(['a', 'b'])
    expect(notesAssetLines(notesText(third)).get('c')).toMatchObject({ byReply: false })
  })

  it('keeps the sentence of the compaction before for an asset that the answer does not name', () => {
    const first = compact([
      user('u0', 'Make a fox'),
      reply('r1', idImage(made('one'), 'a')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: keep - The first fox.`, 'r2')
    const sections = [replied(first, 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const result = compact(sections, NOTES, 'r3')

    expect(notesAssetLines(notesText(result)).get('a')).toMatchObject({ sentence: 'The first fox.', origin: 'made by the model local/m' })
  })

  it('shows the assets that the answer wants to see in the order of its lines, with what the images of the kept messages leave of the limits', () => {
    const sections = [
      user('u0', `Make foxes like ${idImage(pasted('photo'), 'a')}`),
      reply('r1', `${idImage(made('one'), 'b')}\n${idImage(made('two'), 'c')}\n${idImage(made('three'), 'd')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const answer = `${NOTES}\n## Assets\n@d: show - third\n@b: show - first\n@c: show - second`
    const result = compact(sections, answer, 'r2', { limits: withPictures(3) })

    // The image of the first message takes one of the three pictures.
    expect(sent(headOf(result))).toStrictEqual({ images: [pasted('photo'), made('one'), made('three')], pictures: [] })
    expect(hidden(headOf(result))).toStrictEqual(['c'])
  })

  it('keeps an asset that does not fit as text, and still shows a smaller one after it', () => {
    const sections = [
      user('u0', 'Make foxes'),
      reply('r1', `${idImage(made('large'), 'a')}\n${idImage(made('small'), 'b')}`),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: show - large\n@b: show - small`, 'r2', {
      limits: { tokens: 1_000_000, bytes: 3000, pictures: 20 },
      imageBytes: new Map([[made('large'), 3000], [made('small'), 300]]),
    })

    expect(sent(headOf(result))).toStrictEqual({ images: [made('small')], pictures: [] })
  })

  it('counts an image that a kept message names with @id only once against the budget', () => {
    const sections = [
      user('u0', 'Make a fox'),
      reply('r1', idImage(made('one'), 'a')),
      user('u1', 'Change @a'),
      reply('r2', 'working'),
    ]
    // The mention sends the image, so its reference in the notes costs
    // nothing more: a sum of the assets would be over the one picture.
    const result = compact(sections, `${NOTES}\n## Assets\n@a: show - the fox`, 'r2', { limits: withPictures(1) })

    expect(sent(headOf(result))).toStrictEqual({ images: [made('one')], pictures: [] })
    expect(hidden(headOf(result))).toStrictEqual([])
  })

  it('sends the last images of the first message as text when the kept messages hold more images than a compaction leaves', () => {
    const sections = [
      user('u0', `${idImage(pasted('one'), 'a')} then ${idImage(pasted('two'), 'b')} then ${idImage(pasted('three'), 'c')}`),
      reply('r1', 'ok'),
      user('u1', `${idImage(pasted('four'), 'd')} and ${idImage(pasted('five'), 'e')}`),
      reply('r2', 'working'),
    ]
    const result = compact(sections, NOTES, 'r2', { limits: withPictures(3) })

    expect(messagesOf(result)).toStrictEqual([
      `${idImage(pasted('one'), 'a')} then ${kept(idImage(pasted('two'), 'b'))} then ${kept(idImage(pasted('three'), 'c'))}`,
      sectionPlainText(sections[2]),
    ])
    expect(sent(headOf(result))).toStrictEqual({ images: [pasted('one'), pasted('four'), pasted('five')], pictures: [] })
    expect(hidden(headOf(result))).toStrictEqual(['b', 'c'])
  })

  it('puts the body of a prompt pill into the message, with its images, and still ends', () => {
    const pill = { kind: 'prompt' as const, id: 'p1', promptId: null, name: 'Style', body: `Like ${idImage(pasted('style'), 'a')}`, expanded: false }
    const sections: Section[] = [
      { id: 'u0', role: 'user', content: [pill, { kind: 'text', text: ` and ${idImage(pasted('photo'), 'b')}` }] },
      reply('r1', 'working'),
    ]
    const result = compact(sections, NOTES, 'r1', { limits: withPictures(0) })

    expect(messagesOf(result)).toStrictEqual([`Like ${kept(idImage(pasted('style'), 'a'))} and ${kept(idImage(pasted('photo'), 'b'))}`])
  })

  it('sends an image whose file Dez cannot read as text', () => {
    const sections = [
      user('u0', `Like ${idImage(pasted('gone'), 'a')} and ${idImage(pasted('photo'), 'b')}`),
      reply('r1', idImage(made('lost'), 'c')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ]
    const result = compact(sections, `${NOTES}\n## Assets\n@c: show - the fox`, 'r2', { imageBytes: new Map([[pasted('photo'), IMAGE_BYTES]]) })

    expect(messagesOf(result)[0]).toBe(`Like ${kept(idImage(pasted('gone'), 'a'))} and ${idImage(pasted('photo'), 'b')}`)
    expect(sent(headOf(result))).toStrictEqual({ images: [pasted('photo')], pictures: [] })
  })

  it('sets the marks of a kept message new at each compaction', () => {
    const first = compact([
      user('u0', `${idImage(pasted('one'), 'a')} then ${idImage(pasted('two'), 'b')}`),
      reply('r1', 'working'),
    ], NOTES, 'r1', { limits: withPictures(1) })
    expect(sent(headOf(first)).images).toStrictEqual([pasted('one')])
    const sections = [replied(first, 'Done.'), user('u1', 'More'), reply('r2', 'working')]
    const result = compact(sections, NOTES, 'r2')

    expect(messagesOf(result)[0]).toBe(`${idImage(pasted('one'), 'a')} then ${idImage(pasted('two'), 'b')}`)
    expect(sent(headOf(result)).images).toStrictEqual([pasted('one'), pasted('two')])
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
    const head = headOf(result)

    // In the order of the assets of the notes, not of the answer.
    expect(result.pictures).toStrictEqual([picture('a'), picture('b')])
    expect(sectionCompactionBlock(head[0])?.pictures).toStrictEqual([picture('a'), picture('b')])
    expect(sent(head)).toStrictEqual({ images: [], pictures: ['a.jpg', 'b.jpg'] })
    // The clip of the first message stays in it, as it is.
    expect(messagesOf(result)[0]).toBe(sectionPlainText(sections[0]))
    expect(findMediaTags(notesText(result)).map((tag) => [tag.id, isKeptClip(tag)])).toStrictEqual([['a', false], ['b', false], ['c', true]])
  })

  it('does not carry the pictures of the compaction before', () => {
    const first = compact([
      user('u0', 'Make a clip'),
      reply('r1', clip('first', 'a')),
      user('u1', 'Go on'),
      reply('r2', 'working'),
    ], `${NOTES}\n## Assets\n@a: show - the clip`, 'r2', { clipPictures: new Map([['a', picture('a')]]) })
    expect(first.pictures).toStrictEqual([picture('a')])
    const sections = [replied(first, 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const result = compact(sections, `${NOTES}\n## Assets\n@a: keep - the clip`, 'r3')

    expect(result.pictures).toStrictEqual([])
    expect(sectionCompactionBlock(result.sections[0])?.pictures).toStrictEqual([])
    expect(findMediaTags(notesText(result)).map((tag) => [tag.id, isKeptClip(tag)])).toStrictEqual([['a', true]])
  })

  it('shows no asset to a model that reads no images', () => {
    const sections = [
      user('u0', 'Make a fox and a clip'),
      reply('r1', `${idImage(made('one'), 'a')}\n${clip('first', 'b')}`),
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
    expect(hidden(headOf(first))).toStrictEqual([made('old')])
    expect(sent(headOf(first)).images).toStrictEqual([])

    const sections = [replied(first, 'Done.'), user('u2', 'More'), reply('r3', 'working')]
    const second = compact(sections, NOTES, 'r3')
    expect(hidden(headOf(second))).toStrictEqual([made('old')])
  })
})
