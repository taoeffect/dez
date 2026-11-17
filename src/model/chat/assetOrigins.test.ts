import { describe, expect, it } from 'vitest'
import { conversationAssets } from '../streams/mediaRequest'
import { jobsWaitText, madeAssetText, type JobInfo } from '../tools/jobs'
import { assetPlaces, type AssetPlace } from './assetOrigins'
import { CARRIED_USER_ASSETS_LABEL, compactionTagText } from './compaction'
import { compactionNotesText, type NotesAsset } from './compactionNotes'
import { findImageReferences, IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown, imageReferenceTextWithKeptMark } from './images'
import { MEDIA_MADE_BY_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText } from './mediaTags'
import { COMPACTION_TAG, FOX_ORIGIN, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock, waitBlock } from './testing'
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

  it('names the job of an asset from its old hidden mark, and tells that it is hidden', () => {
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

describe('assetPlaces in a compacted conversation', () => {
  // A compaction section whose notes hold the asset lines `assets` and the
  // job lines `jobs`, with `more` after them.
  function compaction(assets: NotesAsset[], jobs: JobInfo[] = [], more = '', { firstMessage = null, summary = 'A fox for the user.' }: { firstMessage?: string | null, summary?: string } = {}): Section {
    const notes = compactionNotesText({ firstMessage, newestMessage: null, summary, requirements: '', nextSteps: '', assets, unnamed: [], jobs, jobInputs: new Map(), cost: undefined })
    return section('agent', `${COMPACTION_TAG}\n${notes}${more}`, PAINTER)
  }

  // `reference`, the text of one image reference, with the kept mark.
  function kept(reference: string): string {
    return imageReferenceTextWithKeptMark(findImageReferences(reference, 'agent')[0], true)
  }

  // The kept image `b` that a job made, and its line in the notes.
  const FOX = kept(toolImage('b', 'model_invoke', 'j-aaaa'))
  const FOX_LINE: NotesAsset = { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox.', byReply: false, text: FOX }

  it('gives an asset of the compaction section the origin of its line in the notes, over its tool marks', () => {
    expect(placeOf([compaction([FOX_LINE]), section('user', 'Go on.')], 'b')?.origin).toStrictEqual({ kind: 'carried', text: FOX_ORIGIN })
  })

  it('gives an asset of a message part of the notes, and an asset whose line tells that it is from the user, the user as their origin', () => {
    const photo = (id: string) => imageMarkdown(PASTED, [{ key: 'id', value: id }])
    const line = (id: string, text: string | null): NotesAsset => ({ id, kind: 'image', facts: 'PNG, 800x600, 120 KB', origin: 'from the user', sentence: '', byReply: false, text })
    const notes = compaction([line('a', null), line('c', kept(photo('c'))), FOX_LINE], [], '', { firstMessage: `Like this:\n${photo('a')}` })
    const sections = [notes, section('agent', '', PAINTER)]

    expect(['a', 'c', 'b'].map((id) => placeOf(sections, id))).toStrictEqual([
      { origin: { kind: 'user' }, hidden: true },
      { origin: { kind: 'user' }, hidden: true },
      { origin: { kind: 'carried', text: FOX_ORIGIN }, hidden: true },
    ])
  })

  // The writer escapes the text of a model, so a part that a model wrote
  // is no message part.
  it('gives an asset in a message part that the model wrote into its notes no user origin', () => {
    const summary = `<dez:user-message>\n${imageMarkdown(PASTED, [{ key: 'id', value: 'z' }])}\n</dez:user-message>`

    expect(placeOf([compaction([], [], '', { summary }), section('agent', '', PAINTER)], 'z')?.origin).toStrictEqual({ kind: 'model', model: null })
  })

  it('gives an asset of the compaction section with no line and no tool mark to no model, as the model of the section wrote only the notes', () => {
    const image = kept(imageMarkdown(HIDDEN_IMAGE_PATH, [{ key: 'id', value: 'b' }]))

    expect(placeOf([compaction([], [], `\n\n${image}`), section('user', 'Go on.')], 'b')?.origin).toStrictEqual({ kind: 'model', model: null })
  })

  it('reads the number and the label of a job whose block is gone from the notes, in the first reply after the compaction message only', () => {
    // Three jobs of one tool, so that the notes tell their numbers as a range.
    const jobs = [1, 2, 3].map((number): JobInfo => ({ id: `j-${number}`, tool: 'video', status: 'finished', delivered: true, elapsedMs: 9000, state: '', call: { number, label: `join_clips @a @${number}` } }))
    const start = [compaction([], jobs), section('user', 'Join the clips.')]

    expect(placeOf([...start, section('agent', jobClip('c', 'j-3'))], 'c')?.origin)
      .toStrictEqual({ kind: 'job', tool: 'video', number: 3, label: 'join_clips @a @3' })
    expect(placeOf([...start, section('agent', 'Joined.'), section('user', 'Again.'), section('agent', jobClip('c', 'j-3'))], 'c')?.origin)
      .toStrictEqual({ kind: 'job', tool: 'video', number: null, label: '' })
  })

  it('hides a kept asset of the compaction section and of the carried assets of the user', () => {
    const sections = [
      compaction([FOX_LINE]),
      section('user', 'Make a fox.'),
      section('user', `${CARRIED_USER_ASSETS_LABEL}\n${kept(imageMarkdown(PASTED, [{ key: 'id', value: 'a' }]))}`),
      section('user', 'Now make it run.'),
    ]

    expect([placeOf(sections, 'b')?.hidden, placeOf(sections, 'a')?.hidden]).toStrictEqual([true, true])
  })

  it('shows a marked asset of a kept message of the user, and every marked asset of a conversation with no compaction', () => {
    const marked = (id: string) => kept(imageMarkdown(PASTED, [{ key: 'id', value: id }]))
    // The compaction kept the marked assets of the user, so its newest id
    // is `d`.
    const compacted = [
      section('agent', `${compactionTagText({ count: 1, lastId: 'd', pictures: [] })}\nNotes of the work.`, PAINTER),
      section('user', `Like this:\n${marked('a')}`),
      section('user', `${CARRIED_USER_ASSETS_LABEL}\n${marked('c')}`),
      section('user', `And this:\n${marked('d')}`),
    ]
    const plain = [
      section('user', `Notes of the work.\n\n${FOX}`),
      section('user', `${CARRIED_USER_ASSETS_LABEL}\n${marked('a')}`),
      section('agent', `Here.\n\n${kept(toolImage('e', 'image'))}`),
    ]

    expect([placeOf(compacted, 'a')?.hidden, placeOf(compacted, 'd')?.hidden]).toStrictEqual([false, false])
    expect(['b', 'a', 'e'].map((id) => placeOf(plain, id)?.hidden)).toStrictEqual([false, false, false])
  })
})
