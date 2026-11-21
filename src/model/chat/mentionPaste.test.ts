import { describe, expect, it } from 'vitest'
import type { MentionSection } from './assetMentions'
import { compactionTagText } from './compaction'
import { findAssetMentions } from './imageMentions'
import { IMAGE_HIDDEN_KEY, IMAGE_KEPT_KEY, IMAGE_MADE_BY_KEY, IMAGE_MODEL_KEY, IMAGE_TOOL_KEY, imageMarkdown, KEPT_MARK_VALUE } from './images'
import { pastedMediaIdChanges } from './mediaIds'
import {
  MEDIA_HIDDEN_ATTRIBUTE,
  MEDIA_JOB_ATTRIBUTE,
  MEDIA_KEPT_ATTRIBUTE,
  MEDIA_MADE_BY_ATTRIBUTE,
  MEDIA_MODEL_ATTRIBUTE,
  MEDIA_TOOL_ATTRIBUTE,
  mediaTagText,
  type MediaTagData,
} from './mediaTags'
import { mentionedAssets, mentionPastePlan, type MentionedAsset, type PastedDoc } from './mentionPaste'
import { idImage } from './testing'

const image = (name: string) => `/home/ann/.config/dez/assets/images/${name}.png`
const DUCK = image('duck')
const CAT = image('cat')
const FOX = image('fox')
const LINKED_DUCK = '/home/ann/Pictures/duck.png'
const SAVED_VIDEO = '/home/ann/.config/dez/assets/generated/video/duck.mp4'
const LINKED_VIDEO = '/home/ann/Videos/duck.mp4'
const CLIP_URL = 'https://cdn.example/duck.mp4'

/** The tag of a video with this id and these fields: by default, one that
 *  plays from `CLIP_URL`. */
function clip(id: string, fields: Partial<MediaTagData> = {}): string {
  return mediaTagText({ kind: 'video', id, type: 'video/mp4', src: null, url: CLIP_URL, expires: null, other: [], ...fields })
}

const SEPARATOR = '\n\u001E\n'
/** The paste place in a section text of a test. */
const PASTE_PLACE = '‸'

/** The record of a copy of every mention of `sections`. */
function copyRecord(sections: readonly MentionSection[]): Map<string, MentionedAsset> {
  return mentionedAssets(sections, sections.flatMap(({ text }, section) => findAssetMentions(text).map(({ id }) => ({ section, id }))))
}

/** The editor doc of `sections` after a plain paste of `pasted` at the
 *  `PASTE_PLACE` of their texts. */
function pastedDoc(sections: readonly MentionSection[], pasted: string): PastedDoc {
  let from = 0
  let pasteAt = -1
  const docSections = sections.map(({ role, text }) => {
    const place = text.indexOf(PASTE_PLACE)
    if (place >= 0) pasteAt = from + place
    const section = { role, from, text: text.replace(PASTE_PLACE, pasted) }
    from += section.text.length + SEPARATOR.length
    return section
  })
  return { doc: docSections.map(({ text }) => text).join(SEPARATOR), sections: docSections, pasted: { from: pasteAt, to: pasteAt + pasted.length } }
}

/** The section texts of `sections` after a paste of `pasted` at their
 *  `PASTE_PLACE`, with the plan for the copy of `source`. It checks that
 *  the `pastedMediaIds` filter of the editor, which runs on the same
 *  transaction, then has no id to change. */
function paste(source: readonly MentionSection[], sections: readonly MentionSection[], pasted: string): string[] {
  const input = pastedDoc(sections, pasted)
  const plan = mentionPastePlan(input, copyRecord(source))
  if (plan === null) return input.doc.split(SEPARATOR)
  const changed = plan.changes.reduceRight((text, { from, to, insert }) => text.slice(0, from) + insert + text.slice(to), input.doc)
  const doc = changed.slice(0, plan.copiesAt) + plan.copiesText + changed.slice(plan.copiesAt)
  const grown = plan.changes.reduce((sum, { from, to, insert }) => sum + insert.length - (to - from), 0)
  const inserted = [
    { from: plan.copiesAt, to: plan.copiesAt + plan.copiesText.length },
    { from: input.pasted.from + plan.copiesText.length, to: input.pasted.to + plan.copiesText.length + grown },
  ]
  expect(pastedMediaIdChanges(doc, inserted)).toEqual([])
  return doc.split(SEPARATOR)
}

describe('mentionedAssets', () => {
  it('takes the last image of an id in the section of the mention or an earlier one', () => {
    const sections: MentionSection[] = [
      { role: 'user', text: idImage(DUCK, 'a') },
      { role: 'agent', text: idImage(FOX, 'a') },
      { role: 'user', text: 'Edit @a' },
      { role: 'agent', text: idImage(CAT, 'a') },
    ]

    expect(mentionedAssets(sections, [{ section: 2, id: 'a' }]))
      .toEqual(new Map([['a', { kind: 'image', reference: { path: FOX, linked: false, metadata: [{ key: 'id', value: 'a' }] } }]]))
  })

  it('names the image of an id that an image and a clip both have', () => {
    const sections: MentionSection[] = [{ role: 'user', text: `${clip('a')}\n${idImage(DUCK, 'a')}\n${clip('a', { url: 'https://cdn.example/other.mp4' })}\nEdit @a` }]

    expect(mentionedAssets(sections, [{ section: 0, id: 'a' }]).get('a')).toMatchObject({ kind: 'image', reference: { path: DUCK } })
  })

  it('keeps the linked src of a clip only where a linked path counts, as a request reads it', () => {
    const sections: MentionSection[] = [
      { role: 'agent', text: clip('a', { src: LINKED_VIDEO }) },
      { role: 'user', text: `${clip('b', { src: LINKED_VIDEO })}\nCut @a and @b` },
    ]
    const named = mentionedAssets(sections, [{ section: 1, id: 'a' }, { section: 1, id: 'b' }])

    expect(named.get('a')).toMatchObject({ kind: 'clip', tag: { id: 'a', src: null, url: CLIP_URL } })
    expect(named.get('b')).toMatchObject({ kind: 'clip', tag: { id: 'b', src: LINKED_VIDEO, url: CLIP_URL } })
  })

  it('leaves out a mention that names nothing, and keeps the asset of the last mention of an id', () => {
    const sections: MentionSection[] = [
      { role: 'user', text: `${idImage(DUCK, 'a')} @a @z` },
      { role: 'user', text: `${idImage(FOX, 'a')} @a` },
    ]
    const named = mentionedAssets(sections, [{ section: 0, id: 'a' }, { section: 0, id: 'z' }, { section: 1, id: 'a' }])

    expect([...named.keys()]).toEqual(['a'])
    expect(named.get('a')).toMatchObject({ reference: { path: FOX } })
  })
})

describe('mentionPastePlan', () => {
  const source: MentionSection[] = [{ role: 'user', text: `${idImage(DUCK, 'a')} ${idImage(FOX, 'b')} Edit @a and @b` }]

  it('is the plain paste when the conversation names the same image with the same id at the paste place', () => {
    expect(mentionPastePlan(pastedDoc([{ role: 'user', text: `${idImage(DUCK, 'a')}\n${PASTE_PLACE}` }], 'Edit @a'), copyRecord(source))).toBeNull()
  })

  it('gives a mention the id that the same image has at the paste place, with no copy', () => {
    const plan = mentionPastePlan(pastedDoc([{ role: 'user', text: `${idImage(CAT, 'a')} ${idImage(DUCK, 'c')}\n${PASTE_PLACE}` }], 'Edit @a'), copyRecord(source))

    expect(plan).toMatchObject({ copies: [], idChanges: new Map([['a', 'c']]) })
    expect(paste(source, [{ role: 'user', text: `${idImage(CAT, 'a')} ${idImage(DUCK, 'c')}\n${PASTE_PLACE}` }], 'Edit @a'))
      .toEqual([`${idImage(CAT, 'a')} ${idImage(DUCK, 'c')}\nEdit @c`])
  })

  it('takes the latest id of an image that the conversation has under two ids', () => {
    const sections: MentionSection[] = [
      { role: 'user', text: idImage(DUCK, 'c') },
      { role: 'agent', text: idImage(DUCK, 'd') },
      { role: 'user', text: PASTE_PLACE },
    ]

    expect(paste(source, sections, 'Edit @a').at(-1)).toBe('Edit @d')
  })

  it('pastes a copy of a missing image at the start of the line of the paste, with its own id when no asset has it', () => {
    expect(paste(source, [{ role: 'user', text: `${idImage(CAT, 'b')}\nLook: ${PASTE_PLACE} now` }], 'Edit @a'))
      .toEqual([`${idImage(CAT, 'b')}\n${idImage(DUCK, 'a')}\nLook: Edit @a now`])
  })

  it('gives a copy the id after the highest one of the conversation when an image or a clip has its id', () => {
    expect(paste(source, [{ role: 'user', text: `${idImage(CAT, 'a')}\n${clip('c')}\n${PASTE_PLACE}` }], 'Edit @a'))
      .toEqual([`${idImage(CAT, 'a')}\n${clip('c')}\n${idImage(DUCK, 'd')}\nEdit @d`])
  })

  it('gives a copy no id of a pasted mention that named nothing at the copy', () => {
    const unnamed: MentionSection[] = [{ role: 'user', text: `${idImage(DUCK, 'a')} Edit @a, not @c` }]

    expect(paste(unnamed, [{ role: 'user', text: `${idImage(CAT, 'a')} ${idImage(FOX, 'b')}\n${PASTE_PLACE}` }], 'Edit @a, not @c'))
      .toEqual([`${idImage(CAT, 'a')} ${idImage(FOX, 'b')}\n${idImage(DUCK, 'd')}\nEdit @d, not @c`])
  })

  it('gives a copy the id that the same file has elsewhere in the conversation, when no other asset has that id', () => {
    expect(paste(source, [{ role: 'user', text: PASTE_PLACE }, { role: 'agent', text: idImage(DUCK, 'e') }], 'Edit @a'))
      .toEqual([`${idImage(DUCK, 'e')}\nEdit @e`, idImage(DUCK, 'e')])
    expect(paste(source, [{ role: 'user', text: PASTE_PLACE }, { role: 'agent', text: `${idImage(DUCK, 'e')} ${idImage(CAT, 'e')}` }], 'Edit @a'))
      .toEqual([`${idImage(DUCK, 'a')}\nEdit @a`, `${idImage(DUCK, 'e')} ${idImage(CAT, 'e')}`])
  })

  it('gives the new ids after the last id of a compaction', () => {
    const compaction = `${compactionTagText({ count: 1, lastId: 'k', pictures: [] })}\nThe notes.`

    expect(paste(source, [{ role: 'agent', text: compaction }, { role: 'user', text: `${idImage(CAT, 'a')}\n${PASTE_PLACE}` }], 'Edit @a'))
      .toEqual([compaction, `${idImage(CAT, 'a')}\n${idImage(DUCK, 'l')}\nEdit @l`])
  })

  describe('with assets in the pasted text', () => {
    it('leaves a pasted asset and its mentions to the paste rule of `pastedMediaIdChanges`', () => {
      expect(mentionPastePlan(pastedDoc([{ role: 'user', text: `${idImage(CAT, 'a')}\n${PASTE_PLACE}` }], `${idImage(FOX, 'a')} Edit @a`), copyRecord(source)))
        .toBeNull()
    })

    it('gives a pasted asset a new id before the filter can take a mention that the plan changed to its id', () => {
      // `@a` names the duck, which is `b` here. The pasted fox `b` gets a
      // new id, and `@b` keeps the duck.
      expect(paste(source, [{ role: 'user', text: `${idImage(DUCK, 'b')}\n${PASTE_PLACE}` }], `Edit @a next to ${idImage(FOX, 'b')}`))
        .toEqual([`${idImage(DUCK, 'b')}\nEdit @b next to ${idImage(FOX, 'c')}`])
    })

    it('gives a pasted image with no id an id after the ids of the copies', () => {
      expect(paste(source, [{ role: 'user', text: `${idImage(CAT, 'a')}\n${PASTE_PLACE}` }], `Edit @a and ${imageMarkdown(FOX)}`))
        .toEqual([`${idImage(CAT, 'a')}\n${idImage(DUCK, 'b')}\nEdit @b and ${idImage(FOX, 'c')}`])
    })
  })

  describe('a linked file', () => {
    const linkedSource: MentionSection[] = [{ role: 'user', text: `${idImage(LINKED_DUCK, 'a')} Edit @a` }]

    it('goes into a user section as a copy', () => {
      expect(paste(linkedSource, [{ role: 'user', text: PASTE_PLACE }], 'Edit @a')).toEqual([`${idImage(LINKED_DUCK, 'a')}\nEdit @a`])
    })

    it('is never copied into an agent section, where a linked path does not count', () => {
      expect(mentionPastePlan(pastedDoc([{ role: 'user', text: 'Hi' }, { role: 'agent', text: PASTE_PLACE }], 'Edit @a'), copyRecord(linkedSource))).toBeNull()
    })

    it('gives a mention in an agent section the id that the file has in an earlier user section', () => {
      expect(paste(linkedSource, [{ role: 'user', text: idImage(LINKED_DUCK, 'c') }, { role: 'agent', text: PASTE_PLACE }], 'Edit @a'))
        .toEqual([idImage(LINKED_DUCK, 'c'), 'Edit @c'])
    })

    it('keeps its id in an agent section, where no copy of another asset takes it', () => {
      const withStored: MentionSection[] = [{ role: 'user', text: `${idImage(LINKED_DUCK, 'c')} ${idImage(DUCK, 'b')} Compare @c and @b` }]

      expect(paste(withStored, [{ role: 'user', text: `Hi ${idImage(CAT, 'b')}` }, { role: 'agent', text: PASTE_PLACE }], 'Compare @c and @b'))
        .toEqual([`Hi ${idImage(CAT, 'b')}`, `${idImage(DUCK, 'd')}\nCompare @c and @d`])
    })
  })

  // The model mark stays: the copy is the same file, which the same model
  // made.
  it('leaves out of a copy the marks that tie an asset to its own conversation, and keeps the rest, also the model mark', () => {
    const marks = (value: string) => [
      { key: IMAGE_TOOL_KEY, value: 'model_invoke' },
      { key: IMAGE_MADE_BY_KEY, value },
      { key: IMAGE_HIDDEN_KEY, value },
      { key: IMAGE_KEPT_KEY, value: KEPT_MARK_VALUE },
    ]
    const model = { key: IMAGE_MODEL_KEY, value: 'venice/painter' }
    const other = [
      { name: MEDIA_TOOL_ATTRIBUTE, value: 'model_invoke' },
      { name: MEDIA_MODEL_ATTRIBUTE, value: 'venice/filmer' },
      { name: MEDIA_MADE_BY_ATTRIBUTE, value: 'j-1' },
      { name: MEDIA_HIDDEN_ATTRIBUTE, value: 'j-1' },
      { name: MEDIA_KEPT_ATTRIBUTE, value: KEPT_MARK_VALUE },
      { name: MEDIA_JOB_ATTRIBUTE, value: 'q-1' },
    ]
    const marked: MentionSection[] = [
      { role: 'agent', text: `${imageMarkdown(DUCK, [{ key: 'id', value: 'a' }, ...marks('j-1'), model, { key: 'desc', value: 'a duck' }])}\n${clip('b', { src: SAVED_VIDEO, other })}` },
      { role: 'user', text: 'Edit @a and @b' },
    ]

    expect(paste(marked, [{ role: 'user', text: PASTE_PLACE }], 'Edit @a and @b')).toEqual([[
      imageMarkdown(DUCK, [{ key: 'id', value: 'a' }, model, { key: 'desc', value: 'a duck' }]),
      clip('b', { src: SAVED_VIDEO, other: [{ name: MEDIA_MODEL_ATTRIBUTE, value: 'venice/filmer' }, { name: MEDIA_JOB_ATTRIBUTE, value: 'q-1' }] }),
      'Edit @a and @b',
    ].join('\n')])
  })

  describe('a clip', () => {
    const savedClip: MentionSection[] = [{ role: 'user', text: `${clip('a', { src: SAVED_VIDEO })}\nMake @a longer.` }]

    it('is the same clip as one with the same src', () => {
      expect(paste(savedClip, [{ role: 'user', text: `${clip('c', { src: SAVED_VIDEO, url: null })}\n${PASTE_PLACE}` }], 'Make @a longer.'))
        .toEqual([`${clip('c', { src: SAVED_VIDEO, url: null })}\nMake @c longer.`])
    })

    it('is another clip than one with the same url and another src', () => {
      const other = clip('c', { src: '/home/ann/.config/dez/assets/generated/video/other.mp4' })

      expect(paste(savedClip, [{ role: 'user', text: `${other}\n${PASTE_PLACE}` }], 'Make @a longer.'))
        .toEqual([`${other}\n${clip('a', { src: SAVED_VIDEO })}\nMake @a longer.`])
    })

    it('with no src is the same clip as one with the same url and no src', () => {
      const urlClip: MentionSection[] = [{ role: 'user', text: `${clip('a')}\nMake @a longer.` }]

      expect(paste(urlClip, [{ role: 'user', text: `${clip('d')}\n${PASTE_PLACE}` }], 'Make @a longer.'))
        .toEqual([`${clip('d')}\nMake @d longer.`])
    })
  })

  it('pastes one copy for two ids of one file, and the copies in the order of their first mentions', () => {
    const twice: MentionSection[] = [{ role: 'user', text: `${idImage(DUCK, 'a')} ${idImage(DUCK, 'b')} ${idImage(FOX, 'c')} Edit @a, @b, and @c` }]

    expect(paste(twice, [{ role: 'user', text: PASTE_PLACE }], 'Edit @c, then @b and @a'))
      .toEqual([`${idImage(FOX, 'c')}\n${idImage(DUCK, 'b')}\nEdit @c, then @b and @b`])
  })

  it('reads a pasted mention with the chars around it in the conversation', () => {
    // `bob@a` is an address, and `@abc` is another word.
    expect(mentionPastePlan(pastedDoc([{ role: 'user', text: `bob${PASTE_PLACE}bc` }], '@a and @a'), copyRecord(source))).toBeNull()
  })
})
