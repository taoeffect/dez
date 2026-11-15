import { describe, expect, it } from 'vitest'
import { jobsWaitText } from '../tools/jobs'
import { CARRIED_USER_ASSETS_LABEL, compactionTagText } from './compaction'
import { findHiddenAssets, findKeptAssets, jobResultInBlocks, type HiddenAsset } from './hiddenAssets'
import { findImageReferences, imageIdChange, imageMarkdown, imageReferenceText, IMAGE_TOOL_KEY } from './images'
import { findMediaTags, mediaTagText, mediaTagTextWithKeptMark, savedMediaTag, unsavedMediaTag } from './mediaTags'
import { HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock as invoke, waitBlock as wait } from './testing'
import { findToolBlocks, toolBlockText } from './toolBlocks'

// What a test reads of each hidden asset: its job, and its text.
function found(text: string): [string, string][] {
  return findHiddenAssets(text, findToolBlocks(text)).map((asset: HiddenAsset) => [asset.owner.kind === 'job' ? asset.owner.jobId : '', text.slice(asset.from, asset.to)])
}

describe('findHiddenAssets', () => {
  it('finds the image and the clip whose job a block of the section started, in text order', () => {
    const image = hiddenImage('j-aaaa')
    const clip = hiddenClip('j-bbbb')
    const text = `${invoke('j-aaaa')}\n${invoke('j-bbbb', { id: 'call_2' })}\n\n${clip}\n\n${image}\n\nDone.`

    expect(found(text)).toStrictEqual([['j-bbbb', clip], ['j-aaaa', image]])
    expect(findHiddenAssets(text, findToolBlocks(text)).map((asset) => asset.kind)).toStrictEqual(['clip', 'image'])
  })

  it('finds none with no block that started the job: the asset then shows at its own place', () => {
    const text = `${invoke('j-aaaa')}\n\n${hiddenImage('j-zzzz')}\n\n${hiddenClip('j-zzzz')}`

    expect(found(text)).toStrictEqual([])
    expect(found(hiddenImage('j-aaaa'))).toStrictEqual([])
  })

  it('takes an image reference only when it is alone on its line', () => {
    const image = hiddenImage('j-aaaa')

    expect(found(`${invoke('j-aaaa')}\n\nSee ${image}`)).toStrictEqual([])
    expect(found(`${invoke('j-aaaa')}\n\n${image} and more`)).toStrictEqual([])
    expect(found(`${invoke('j-aaaa')}\n\n${image}${hiddenImage('j-aaaa', 'c')}`)).toStrictEqual([])
    expect(found(`${invoke('j-aaaa')}\n\n  ${image} \nMore.`)).toStrictEqual([['j-aaaa', image]])
  })

  it('takes no reference that is in the result of a block', () => {
    const image = hiddenImage('j-aaaa')
    const text = `${invoke('j-aaaa')}\n${toolBlockText({ id: 'call_2', name: 'model_list', status: 'success', arguments: {}, result: `One line.\n${image}\nLast line.` })}`

    expect(found(text)).toStrictEqual([])
  })

  it('takes an asset with no marker, or with the marker of a job that only failed to start, as a shown asset', () => {
    const shown = imageMarkdown(HIDDEN_IMAGE_PATH, [{ key: 'id', value: 'b' }, { key: IMAGE_TOOL_KEY, value: 'model_invoke' }])
    const failed = toolBlockText({ id: 'call_1', name: 'model_invoke', status: 'error', arguments: {}, result: 'Dez did not start the job j-aaaa.' })

    expect(found(`${invoke('j-aaaa')}\n\n${shown}`)).toStrictEqual([])
    expect(found(`${failed}\n\n${hiddenImage('j-aaaa')}`)).toStrictEqual([])
  })
})

describe('findKeptAssets', () => {
  const TAG = compactionTagText({ count: 1, lastId: 'd', pictures: [] })
  const keptImage = imageReferenceText({ path: HIDDEN_IMAGE_PATH, metadata: [{ key: 'id', value: 'b' }] }, true)
  const keptClip = mediaTagTextWithKeptMark(findMediaTags(hiddenClip('j-aaaa'))[0], true)
  const linked = imageReferenceText({ path: '/home/u/Pictures/cat.png', metadata: [{ key: 'id', value: 'a' }] }, true)

  // The text of each kept asset, for each section.
  function kept(sections: { role: 'user' | 'agent', text: string }[]): string[][] {
    return findKeptAssets(sections).map((assets, index) => assets.map((asset) => sections[index].text.slice(asset.from, asset.to)))
  }

  it('finds the kept assets of the compaction section and of the section of the carried assets of the user', () => {
    const sections = [
      { role: 'agent' as const, text: `${TAG}\n## Summary\n\nDone.\n\n${keptClip}\n@c | audio clip\n\n${keptImage}\n@b | image` },
      { role: 'user' as const, text: 'Make a cat.' },
      { role: 'user' as const, text: `${CARRIED_USER_ASSETS_LABEL}\n${linked}` },
      { role: 'user' as const, text: 'Now a dog.' },
      { role: 'agent' as const, text: 'A dog.' },
    ]

    expect(kept(sections)).toStrictEqual([[keptClip, keptImage], [], [linked], [], []])
    expect(findKeptAssets(sections).flat().every((asset) => asset.owner.kind === 'compaction')).toBe(true)
  })

  it('hides nothing in a conversation with no compaction section', () => {
    expect(kept([{ role: 'user', text: `${CARRIED_USER_ASSETS_LABEL}\n${linked}` }, { role: 'agent', text: keptImage }])).toStrictEqual([[], []])
    // A tag that is not on the first line is plain text.
    expect(kept([{ role: 'agent', text: `Notes.\n${TAG}\n${keptImage}` }])).toStrictEqual([[]])
  })

  it('leaves a marked asset in view in a message of the user, and after the first reply', () => {
    const sections = [
      { role: 'agent' as const, text: TAG },
      { role: 'user' as const, text: `Look at this:\n${linked}` },
      { role: 'agent' as const, text: `Here.\n\n${keptImage}` },
      { role: 'user' as const, text: `${CARRIED_USER_ASSETS_LABEL}\n${linked}` },
    ]

    expect(kept(sections)).toStrictEqual([[], [], [], []])
  })

  it('reads on after a blank section, as the compaction message of a request does', () => {
    const sections = [
      { role: 'agent' as const, text: TAG },
      { role: 'agent' as const, text: ' \n' },
      { role: 'user' as const, text: `${CARRIED_USER_ASSETS_LABEL}\n${linked}` },
    ]

    expect(kept(sections)).toStrictEqual([[], [], [linked]])
  })

  it('takes an image only when it is alone on its line, and no asset with no mark', () => {
    const shown = imageReferenceText({ path: HIDDEN_IMAGE_PATH, metadata: [{ key: 'id', value: 'b' }] }, false)

    expect(kept([{ role: 'agent', text: `${TAG}\nSee ${keptImage}\n\n${shown}\n\n${hiddenClip('j-aaaa')}` }])).toStrictEqual([[]])
  })
})

describe('the marker of a hidden asset', () => {
  it('stays in an image reference that gets a new id', () => {
    const text = hiddenImage('j-aaaa')
    const [reference] = findImageReferences(text, 'agent')
    const change = imageIdChange(reference, 'f')

    expect(text.slice(0, change.from) + change.insert + text.slice(change.to))
      .toBe(`![${HIDDEN_IMAGE_PATH}](id=f|tool=model_invoke|hidden=j-aaaa)`)
  })

  it('stays in the tag of a clip that is saved, and of one whose saved file is deleted', () => {
    const [tag] = findMediaTags(hiddenClip('j-aaaa'))
    const saved = mediaTagText(savedMediaTag(tag, '/home/u/.config/dez/assets/generated/audio/two.wav'))

    expect(saved).toContain(' src="/home/u/.config/dez/assets/generated/audio/two.wav" ')
    expect(saved).toMatch(/ tool="model_invoke" hidden="j-aaaa"\/>$/)
    expect(mediaTagText(unsavedMediaTag(tag))).toMatch(/ src="https:\/\/clips\.example\/one\.wav" .* hidden="j-aaaa"\/>$/)
  })
})

describe('jobResultInBlocks', () => {
  const results = jobsWaitText([
    { id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.', call: { number: 1, label: 'A cat' } },
    { id: 'j-bbbb', tool: 'model_invoke', status: 'failed', text: 'The provider refused the prompt.', call: { number: 2, label: 'A dog' } },
  ], 1)

  it('gives the result that a jobs_wait block of the section holds for the job', () => {
    const blocks = findToolBlocks(`${invoke('j-aaaa')}\n${wait('1 job ended.')}\n\n${wait(results)}`)

    expect(jobResultInBlocks(blocks, 'j-aaaa')).toStrictEqual({ id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.', call: { number: 1, label: 'A cat' } })
    expect(jobResultInBlocks(blocks, 'j-bbbb')?.status).toBe('failed')
  })

  it('gives null for a job that no jobs_wait block gave, and reads no block of another tool', () => {
    const other = toolBlockText({ id: 'call_x', name: 'model_list', status: 'success', arguments: {}, result: results })

    expect(jobResultInBlocks(findToolBlocks(`${invoke('j-cccc')}\n${wait(results)}`), 'j-cccc')).toBeNull()
    expect(jobResultInBlocks(findToolBlocks(`${invoke('j-aaaa')}\n${other}`), 'j-aaaa')).toBeNull()
  })
})
