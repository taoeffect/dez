import { describe, expect, it } from 'vitest'
import { conversationAssets } from '../streams/mediaRequest'
import { jobsWaitText, madeAssetText } from '../tools/jobs'
import { assetPlaces, type AssetPlace } from './assetOrigins'
import { IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown } from './images'
import { MEDIA_MADE_BY_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText } from './mediaTags'
import { HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock, waitBlock } from './testing'
import { toolBlockText } from './toolBlocks'
import type { ModelRef, Section } from './types'

const PAINTER: ModelRef = { providerId: 'studio', modelId: 'paint' }
const PASTED = '/home/u/.config/dez/assets/images/pasted.png'

function section(role: Section['role'], text: string, model?: ModelRef): Section {
  return { id: crypto.randomUUID(), role, content: [{ kind: 'text', text }], ...(model && { model }) }
}

// The reference of an image that the tool `tool` made, with the `made-by`
// mark of the job `jobId` when it has one.
function toolImage(id: string, tool: string, jobId?: string): string {
  return imageMarkdown(HIDDEN_IMAGE_PATH, [
    { key: 'id', value: id },
    { key: IMAGE_TOOL_KEY, value: tool },
    ...(jobId === undefined ? [] : [{ key: IMAGE_MADE_BY_KEY, value: jobId }]),
  ])
}

// The tag of a video clip that a job of the `video` tool made.
function jobClip(id: string, jobId: string): string {
  return mediaTagText({
    kind: 'video',
    id,
    type: 'video/mp4',
    src: '/home/u/.config/dez/assets/generated/video/one.mp4',
    url: null,
    expires: null,
    other: [{ name: MEDIA_TOOL_ATTRIBUTE, value: 'video' }, { name: MEDIA_MADE_BY_ATTRIBUTE, value: jobId }],
  })
}

// The place of `id` in a conversation of `sections`.
function placeOf(sections: readonly Section[], id: string): AssetPlace | undefined {
  const found = conversationAssets(sections).found.get(id)
  return found && assetPlaces(sections, [found])[0]
}

describe('assetPlaces', () => {
  it('gives the assets of a user section to the user', () => {
    const user = section('user', `${imageMarkdown(PASTED, [{ key: 'id', value: 'a' }])}\n${hiddenClip('j-aaaa', 'b')}`)

    expect([placeOf([user], 'a'), placeOf([user], 'b')]).toStrictEqual([
      { origin: { kind: 'user' }, hidden: false },
      { origin: { kind: 'user' }, hidden: false },
    ])
  })

  it('gives an asset with no tool mark to the model of its agent section', () => {
    const image = imageMarkdown(HIDDEN_IMAGE_PATH, [{ key: 'id', value: 'a' }])

    expect(placeOf([section('user', 'Paint a cat'), section('agent', image, PAINTER)], 'a'))
      .toStrictEqual({ origin: { kind: 'model', model: PAINTER }, hidden: false })
    expect(placeOf([section('user', 'Paint a cat'), section('agent', image)], 'a'))
      .toStrictEqual({ origin: { kind: 'model', model: null }, hidden: false })
  })

  it('names the job that made an asset, from the block that started it', () => {
    const reply = section('agent', `${invokeBlock('j-aaaa')}\n\n${toolImage('b', 'model_invoke', 'j-aaaa')}`, PAINTER)

    expect(placeOf([section('user', 'Hi'), reply], 'b'))
      .toStrictEqual({ origin: { kind: 'job', tool: 'model_invoke', number: 1, label: 'A cat' }, hidden: false })
  })

  it('tells that a hidden asset is hidden, also one with only its old hidden mark', () => {
    const reply = section('agent', `${invokeBlock('j-aaaa')}\n\n${hiddenImage('j-aaaa', 'b')}\n${hiddenClip('j-aaaa', 'c')}`, PAINTER)
    const job = { kind: 'job', tool: 'model_invoke', number: 1, label: 'A cat' }

    expect(placeOf([reply], 'b')).toStrictEqual({ origin: job, hidden: true })
    expect(placeOf([reply], 'c')).toStrictEqual({ origin: job, hidden: true })
  })

  it('reads no number from the start text of an older Dez', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_invoke', status: 'success', arguments: { model: 'studio/paint', prompt: 'A cat' }, result: 'Started the job j-aaaa. It runs in the background.' })
    const reply = section('agent', `${block}\n\n${toolImage('b', 'model_invoke', 'j-aaaa')}`)

    expect(placeOf([reply], 'b')?.origin).toStrictEqual({ kind: 'job', tool: 'model_invoke', number: null, label: 'A cat' })
  })

  it('names the job from the result of jobs_wait when the block that started it is gone', () => {
    const results = jobsWaitText([
      { id: 'j-aaaa', tool: 'video', status: 'finished', text: `${madeAssetText('video', 'c')}.`, call: { number: 4, label: 'join_clips @a @b' } },
      { id: 'j-bbbb', tool: 'model_invoke', status: 'finished', text: `${madeAssetText('image', 'd')}.`, call: { number: 5, label: 'A dog' } },
    ], 0)
    const reply = section('agent', `${waitBlock(results)}\n\n${jobClip('c', 'j-aaaa')}\n${toolImage('d', 'model_invoke')}`)

    expect(placeOf([reply], 'c')).toStrictEqual({ origin: { kind: 'job', tool: 'video', number: 4, label: 'join_clips @a @b' }, hidden: false })
    expect(placeOf([reply], 'd')?.origin).toStrictEqual({ kind: 'job', tool: 'model_invoke', number: 5, label: 'A dog' })
  })

  it('names the call whose result names an asset that a tool made in its call', () => {
    const crop = toolBlockText({
      id: 'call_1',
      name: 'image',
      status: 'success',
      arguments: { command: 'crop', parameters: '{"image": "a", "width": 10}' },
      result: `${madeAssetText('image', 'b')} from @a.`,
    })
    const reply = section('agent', `${crop}\n\n${toolImage('b', 'image')}`)

    expect(placeOf([reply], 'b')?.origin).toStrictEqual({ kind: 'call', tool: 'image', label: 'crop {\'image\': \'a\', \'width\': 10}' })
  })

  it('names only the job or the tool when no block of the section tells more', () => {
    expect(placeOf([section('agent', toolImage('b', 'model_invoke', 'j-gone'))], 'b')).toStrictEqual({ origin: { kind: 'job', tool: 'model_invoke', number: null, label: '' }, hidden: false })
    expect(placeOf([section('agent', toolImage('b', 'image'))], 'b')).toStrictEqual({ origin: { kind: 'call', tool: 'image', label: '' }, hidden: false })
  })
})
