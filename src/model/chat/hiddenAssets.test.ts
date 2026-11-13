import { describe, expect, it } from 'vitest'
import { jobsWaitText } from '../tools/jobs'
import { findHiddenAssets, jobResultInBlocks, type HiddenAsset } from './hiddenAssets'
import { findImageReferences, imageIdChange, imageMarkdown, IMAGE_TOOL_KEY } from './images'
import { findMediaTags, mediaTagText, savedMediaTag, unsavedMediaTag } from './mediaTags'
import { HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock as invoke, waitBlock as wait } from './testing'
import { findToolBlocks, toolBlockText } from './toolBlocks'

// What a test reads of each hidden asset: its job, and its text.
function found(text: string): [string, string][] {
  return findHiddenAssets(text, findToolBlocks(text)).map((asset: HiddenAsset) => [asset.jobId, text.slice(asset.from, asset.to)])
}

describe('findHiddenAssets', () => {
  it('finds the image and the clip whose job a block of the section started, in text order', () => {
    const image = hiddenImage('j-aaaa')
    const clip = hiddenClip('j-bbbb')
    const text = `${invoke('j-aaaa')}\n${invoke('j-bbbb', 'call_2')}\n\n${clip}\n\n${image}\n\nDone.`

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
    { id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.' },
    { id: 'j-bbbb', tool: 'model_invoke', status: 'failed', text: 'The provider refused the prompt.' },
  ], 1)

  it('gives the result that a jobs_wait block of the section holds for the job', () => {
    const blocks = findToolBlocks(`${invoke('j-aaaa')}\n${wait('1 job ended.')}\n\n${wait(results)}`)

    expect(jobResultInBlocks(blocks, 'j-aaaa')).toStrictEqual({ id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.' })
    expect(jobResultInBlocks(blocks, 'j-bbbb')?.status).toBe('failed')
  })

  it('gives null for a job that no jobs_wait block gave, and reads no block of another tool', () => {
    const other = toolBlockText({ id: 'call_x', name: 'model_list', status: 'success', arguments: {}, result: results })

    expect(jobResultInBlocks(findToolBlocks(`${invoke('j-cccc')}\n${wait(results)}`), 'j-cccc')).toBeNull()
    expect(jobResultInBlocks(findToolBlocks(`${invoke('j-aaaa')}\n${other}`), 'j-aaaa')).toBeNull()
  })
})
