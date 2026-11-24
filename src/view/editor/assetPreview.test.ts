import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { clipModelMark } from '../../model/chat/assetModels'
import { compactionBlockText } from '../../model/chat/compaction'
import { mediaTagText } from '../../model/chat/mediaTags'
import { HIDDEN_CLIP_PATH, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, idImage, invokeBlock } from '../../model/chat/testing'
import { displayNames } from '../../model/providers/testing'
import { setModelDisplayNamesEffect } from '../thread/modelChip'
import { mentionPreviewAsset, previewPlace } from './assetPreview'
import { shownMentions } from './mentions'
import { createState, joinSections, keptClip, RED, SONG } from './testing'

const PAINT = { providerId: 'studio', modelId: 'paint' }

/** `state` with the name "Paint Pro" for the model `PAINT`. */
function withPaintName(state: EditorState): EditorState {
  return state.update({ effects: setModelDisplayNamesEffect.of(displayNames({ 'studio/paint': 'Paint Pro' })) }).state
}

/** What the box of each mention chip of `state` shows, in doc order. */
function previews(state: EditorState) {
  return shownMentions(state).map((mention) => mentionPreviewAsset(state, mention))
}

describe('mentionPreviewAsset', () => {
  it('gives an image at its own place as the editor draws it there', () => {
    const texts = [`${RED}\n${SONG}`, 'Look at @a']

    expect(previews(createState(texts, ['user', 'user']))).toStrictEqual([{
      target: { from: 0, holder: null },
      asset: { kind: 'image', path: '/home/u/.config/dez/assets/images/red.png', id: 'a', linked: false, model: null },
    }])
  })

  it('gives a clip of a reply at its own place, with the label of the model that made it', () => {
    const marked = mediaTagText({ kind: 'audio', id: 'c', type: 'audio/webm', src: null, url: 'https://cdn.example/c.webm', expires: null, other: clipModelMark(PAINT) })
    const texts = ['ask', `Here.\n${marked}`, 'Play @c']
    const [preview] = previews(withPaintName(createState(texts, ['user', 'agent', 'user'])))

    expect(preview?.target).toStrictEqual({ from: joinSections(texts).indexOf(marked), holder: null })
    // A linked file does not count in a reply.
    expect(preview?.asset).toMatchObject({
      kind: 'clip',
      tag: { kind: 'audio', id: 'c', type: 'audio/webm', src: null, url: 'https://cdn.example/c.webm', expires: null },
      linkedSrc: false,
      model: { key: 'studio/paint', name: 'Paint Pro' },
    })
  })

  it('gives the hidden assets of a tool call chip as the rows of its panel', () => {
    const invoke = invokeBlock('j-aaaa')
    const image = hiddenImage('j-aaaa', 'b', PAINT)
    const texts = ['ask', [invoke, '', image, '', hiddenClip('j-aaaa'), '', 'Done.'].join('\n'), 'Show @c and @b']
    const [clip, picture] = previews(withPaintName(createState(texts, ['user', 'agent', 'user'])))

    expect(clip?.asset).toMatchObject({ kind: 'clip', tag: { kind: 'audio', id: 'c', src: HIDDEN_CLIP_PATH } })
    expect(picture?.target.holder).toStrictEqual({ kind: 'call', id: 'call_1', from: joinSections(texts).indexOf(invoke), row: 0 })
    expect(picture?.asset).toMatchObject({ kind: 'image', path: HIDDEN_IMAGE_PATH, id: 'b', linked: false, model: { key: 'studio/paint', name: 'Paint Pro' } })
  })

  it('gives a kept clip of the compaction block as its row of the kept assets, with the linked rule of the block', () => {
    const linked = '/home/u/Music/linked.wav'
    const kept = keptClip('n', linked)
    const block = compactionBlockText({ count: 1, lastId: 'z', pictures: [], linked: [linked] }, ['Notes.', '', keptClip('m'), '', kept].join('\n'))
    const texts = [block, 'Play @n']
    const [preview] = previews(createState(texts, ['agent', 'user']))

    expect(preview?.target).toStrictEqual({ from: joinSections(texts).indexOf(kept), holder: { kind: 'compaction', row: 1 } })
    expect(preview?.asset).toMatchObject({ kind: 'clip', tag: { kind: 'audio', id: 'n', src: linked }, linkedSrc: true })
  })

  it('gives the first of two images with the id of the mention', () => {
    const first = idImage('/home/u/.config/dez/assets/images/first.png', 'a')
    const second = idImage('/home/u/.config/dez/assets/images/second.png', 'a')
    const [preview] = previews(createState([`${first}\n\n${second}\nSee @a`], ['user']))

    expect(preview?.asset).toMatchObject({ kind: 'image', path: '/home/u/.config/dez/assets/images/first.png' })
  })

  it('gives nothing for an image that the editor shows as text: a reference on a table row line', () => {
    const texts = [['| a | b |', '| - | - |', RED].join('\n'), 'See @a']

    expect(previews(createState(texts, ['user', 'user']))).toStrictEqual([null])
  })
})

describe('previewPlace', () => {
  const area = { left: 100, right: 900, top: 50, bottom: 650 }
  const size = { width: 300, height: 200 }

  it('puts the box above its chip when it fits there, from the chip\'s left edge, with the bridge across the gap', () => {
    const chip = { left: 200, right: 240, top: 400, bottom: 420 }

    expect(previewPlace(chip, size, area, null)).toStrictEqual({
      side: 'above',
      left: 200,
      top: 194,
      bridge: { left: 200, right: 500, top: 394, bottom: 400 },
    })
  })

  it('puts the box below a chip near the top of the area', () => {
    const chip = { left: 200, right: 240, top: 80, bottom: 100 }

    expect(previewPlace(chip, size, area, null)).toStrictEqual({
      side: 'below',
      left: 200,
      top: 106,
      bridge: { left: 200, right: 500, top: 100, bottom: 106 },
    })
  })

  it('moves the box left to keep it in the area, and the bridge still reaches the chip', () => {
    const chip = { left: 850, right: 890, top: 600, bottom: 620 }

    expect(previewPlace(chip, size, area, null)).toStrictEqual({
      side: 'above',
      left: 600,
      top: 394,
      bridge: { left: 600, right: 900, top: 594, bottom: 600 },
    })
  })

  it('puts the box below and to the left of a chip in the top-right corner', () => {
    const chip = { left: 860, right: 895, top: 60, bottom: 80 }

    expect(previewPlace(chip, size, area, null)).toMatchObject({ side: 'below', left: 600, top: 86 })
  })

  it('never moves the box past the area\'s left edge, also when it is wider than the area', () => {
    const chip = { left: 300, right: 340, top: 400, bottom: 420 }

    expect(previewPlace(chip, { width: 900, height: 200 }, area, null).left).toBe(100)
  })

  it('takes the side with more room when the box fits on neither, and does not move it over the chip', () => {
    const tall = { width: 300, height: 400 }
    const lower = { left: 200, right: 240, top: 330, bottom: 350 }
    const even = { left: 200, right: 240, top: 340, bottom: 360 }

    // 274 px above, 294 px below.
    expect(previewPlace(lower, tall, area, null)).toMatchObject({ side: 'below', top: 356 })
    expect(previewPlace(even, tall, area, null)).toMatchObject({ side: 'above', top: -66 })
  })

  it('keeps the side of a box that shows while the box fits there', () => {
    const middle = { left: 200, right: 240, top: 400, bottom: 420 }
    const high = { left: 200, right: 240, top: 80, bottom: 100 }

    expect(previewPlace(middle, size, area, 'below').side).toBe('below')
    expect(previewPlace(high, size, area, 'above').side).toBe('below')
  })
})
