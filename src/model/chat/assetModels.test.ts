import { describe, expect, it } from 'vitest'
import { assetModel, clipModelMark, imageModelMark, type MarkedAsset } from './assetModels'
import { findImageReferences, imageMarkdown } from './images'
import { findMediaTags, mediaTagText } from './mediaTags'
import type { ModelRef } from './types'

const PNG = '/home/ann/.config/dez/assets/generated/images/a.png'
const SONG = '/home/ann/.config/dez/assets/generated/audio/a.mp3'
const PAINTER: ModelRef = { providerId: 'venice', modelId: 'painter' }
const REPLY_MODEL: ModelRef = { providerId: 'openai', modelId: 'gpt-5' }
const agent = { role: 'agent' as const, model: REPLY_MODEL }

// The image and the clip of `text`, as the view reads them in an agent
// section.
const imageOf = (text: string) => findImageReferences(text, 'agent')[0]
const clipOf = (text: string) => findMediaTags(text, 'agent')[0]
const image = (items: string) => imageOf(`![${items}](${PNG})`)
const clip = (attributes: string) => clipOf(`<dez:audio id="a" type="audio/mpeg" src="${SONG}"${attributes}/>`)

describe('the model mark', () => {
  // Model ids hold `/` (OpenRouter), and can hold the chars that the
  // escapes of an image reference and of a tag cover.
  it.each<[string, ModelRef]>([
    ['a plain id', PAINTER],
    ['an id with a slash', { providerId: 'openrouter', modelId: 'google/gemini-2.5-flash-image' }],
    ['an id with the chars that a reference or a tag escapes', { providerId: 'custom', modelId: String.raw`a|b]c[d\e"f&g` }],
  ])('of an image and of a clip gives back the model that made it, for %s', (_case, model) => {
    const reference = imageOf(imageMarkdown(PNG, [{ key: 'id', value: 'a' }, ...imageModelMark(model)]))
    const tag = clipOf(mediaTagText({ kind: 'audio', id: 'a', type: 'audio/mpeg', src: SONG, url: null, expires: null, other: clipModelMark(model) }))
    for (const section of [{ role: 'user' as const }, agent]) {
      expect(assetModel(reference, section, false)).toStrictEqual(model)
      expect(assetModel(tag, section, false)).toStrictEqual(model)
    }
  })

  it('is the item `model=<provider>/<model>` of an image, and the attribute `model` of a clip', () => {
    expect(imageMarkdown(PNG, [{ key: 'id', value: 'b' }, ...imageModelMark(PAINTER)])).toBe(`![id=b|model=venice/painter](${PNG})`)
    expect(clipModelMark(PAINTER)).toStrictEqual([{ name: 'model', value: 'venice/painter' }])
  })

  // A line break ends the alt text of a reference, and a sentinel breaks
  // the editor's scan: such a model gets no label, and its asset stays
  // whole.
  it.each([
    ['no model', undefined],
    ['a model id with a line break', { providerId: 'custom', modelId: 'a\nb' }],
    ['a model id with a tab', { providerId: 'custom', modelId: 'a\tb' }],
    ['a model id with a sentinel', { providerId: 'custom', modelId: 'a\uE000b' }],
  ])('is not written for %s', (_case, model) => {
    expect(imageModelMark(model)).toStrictEqual([])
    expect(clipModelMark(model)).toStrictEqual([])
  })
})

describe('assetModel', () => {
  it.each<[string, MarkedAsset]>([
    ['an image', image('id=a|model=venice/painter')],
    ['a clip', clip(' model="venice/painter"')],
    ['an image of a job', image('id=a|tool=model_invoke|model=venice/painter|made-by=j-1|hidden=j-1')],
    ['a clip of a job', clip(' tool="model_invoke" model="venice/painter" job="q-1" made-by="j-1"')],
  ])('gives the model of the mark of %s, in any section and in the compaction block', (_case, asset) => {
    expect(assetModel(asset, agent, false)).toStrictEqual(PAINTER)
    expect(assetModel(asset, { role: 'user' }, false)).toStrictEqual(PAINTER)
    expect(assetModel(asset, agent, true)).toStrictEqual(PAINTER)
  })

  // Conversations saved before Dez wrote the mark.
  it.each<[string, MarkedAsset]>([
    ['an image', image('id=a')],
    ['a clip', clip('')],
    ['an image whose mark is not a model', image('id=a|model=painter')],
    ['a clip whose mark is not a model', clip(' model="/painter"')],
  ])('gives the model of the agent section of %s with no tool mark', (_case, asset) => {
    expect(assetModel(asset, agent, false)).toStrictEqual(REPLY_MODEL)
  })

  it.each<[string, MarkedAsset, { role: 'user' | 'agent', model?: ModelRef }, boolean]>([
    ['an image of the user', image('id=a'), { role: 'user', model: REPLY_MODEL }, false],
    ['a clip of the user', clip(''), { role: 'user' }, false],
    ['an image of a Dez tool', image('id=a|tool=image'), agent, false],
    ['a clip of a Dez tool', clip(' tool="audio"'), agent, false],
    ['an image in the compaction block', image('id=a'), agent, true],
    ['a clip in the compaction block', clip(''), agent, true],
    ['an image of an agent section whose model is not known', image('id=a'), { role: 'agent' }, false],
  ])('gives no model for %s with no mark', (_case, asset, section, inCompactionBlock) => {
    expect(assetModel(asset, section, inCompactionBlock)).toBeNull()
  })
})
