import { describe, expect, it } from 'vitest'
import { jobsWaitText } from '../tools/jobs'
import { CARRIED_USER_ASSETS_LABEL, compactionBlockText, compactionTagText } from './compaction'
import { findHiddenAssets, findJobResults, findKeptAssets, type ChipSection, type HiddenAssetOwner } from './hiddenAssets'
import { findImageReferences, imageIdChange, imageMarkdown, IMAGE_TOOL_KEY } from './images'
import { findMediaTags, mediaTagText, mediaTagTextWithKeptMark, savedMediaTag, unsavedMediaTag } from './mediaTags'
import { HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, idImage, invokeBlock as invoke, waitBlock as wait } from './testing'
import { findToolBlocks, toolBlockText } from './toolBlocks'
import type { Role } from './types'

// A conversation of `texts`, each as its role and its text, with the tool
// blocks of each text, in a user section too.
function conversation(texts: [Role, string][]): ChipSection[] {
  return texts.map(([role, text]) => ({ role, text, blocks: findToolBlocks(text) }))
}

// The job and the call of a chip owner, and nothing for the compaction.
function ownerText(owner: HiddenAssetOwner): string {
  return owner.kind === 'job' ? `${owner.jobId} ${owner.callId}` : ''
}

// What a test reads of each hidden asset of each section of a
// conversation of `texts`: its owner (`ownerText`), and its text.
function foundIn(texts: [Role, string][]): [string, string][][] {
  return findHiddenAssets(conversation(texts)).map((assets, index) => assets.map((asset) => [ownerText(asset.owner), texts[index][1].slice(asset.from, asset.to)]))
}

// `foundIn` for one agent section of the text `text`.
function found(text: string): [string, string][] {
  return foundIn([['agent', text]])[0]
}

describe('findHiddenAssets', () => {
  it('finds the image and the clip whose job a block of the section started, in text order', () => {
    const image = hiddenImage('j-aaaa')
    const clip = hiddenClip('j-bbbb')
    const text = `${invoke('j-aaaa')}\n${invoke('j-bbbb', { id: 'call_2' })}\n\n${clip}\n\n${image}\n\nDone.`

    expect(found(text)).toStrictEqual([['j-bbbb call_2', clip], ['j-aaaa call_1', image]])
    expect(findHiddenAssets(conversation([['agent', text]]))[0].map((asset) => asset.kind)).toStrictEqual(['clip', 'image'])
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
    expect(found(`${invoke('j-aaaa')}\n\n  ${image} \nMore.`)).toStrictEqual([['j-aaaa call_1', image]])
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

describe('findHiddenAssets in a conversation (the chip that owns an asset)', () => {
  const image = hiddenImage('j-aaaa')
  const clip = hiddenClip('j-aaaa')

  it('gives an asset of a later reply, past a user section, to the chip of the earlier reply that started its job', () => {
    expect(foundIn([
      ['agent', `${invoke('j-aaaa')}\n\nWorking.`],
      ['user', 'Go on.'],
      ['agent', `${wait('1 job ended.')}\n\n${clip}\n\n${image}`],
    ])).toStrictEqual([[], [], [['j-aaaa call_1', clip], ['j-aaaa call_1', image]]])
  })

  it('gives the asset to the nearest chip that started its job: of its own section, else of the nearest earlier reply that has one', () => {
    expect(foundIn([
      ['agent', invoke('j-aaaa')],
      ['user', 'Again.'],
      ['agent', `${invoke('j-aaaa', { id: 'call_2' })}\n\n${image}`],
      ['user', 'Go on.'],
      ['agent', 'More.'],
      ['agent', clip],
    ])).toStrictEqual([[], [], [['j-aaaa call_2', image]], [], [], [['j-aaaa call_2', clip]]])
    // A chip after the asset in its section wins over a chip of an
    // earlier section.
    expect(foundIn([['agent', invoke('j-aaaa', { id: 'call_0' })], ['user', 'Go on.'], ['agent', `${image}\n\n${invoke('j-aaaa')}`]]))
      .toStrictEqual([[], [], [['j-aaaa call_1', image]]])
  })

  it('gives an asset of a section with two chips of its job to the nearest one before it, else to the first one after it', () => {
    const [first, second, third] = ['b', 'c', 'd'].map((id) => hiddenImage('j-aaaa', id))
    const text = `${first}\n\n${invoke('j-aaaa')}\n\n${second}\n\n${invoke('j-aaaa', { id: 'call_2' })}\n\n${third}`

    expect(found(text)).toStrictEqual([['j-aaaa call_1', first], ['j-aaaa call_1', second], ['j-aaaa call_2', third]])
    // In an earlier section, the last one.
    expect(foundIn([['agent', `${invoke('j-aaaa')}\n${invoke('j-aaaa', { id: 'call_2' })}`], ['agent', image]])[1]).toStrictEqual([['j-aaaa call_2', image]])
  })

  it('shows an asset of a user section, and starts no job by a block of a user section', () => {
    expect(foundIn([['agent', invoke('j-aaaa')], ['user', `${image}\n\n${clip}`], ['agent', 'Done.']])).toStrictEqual([[], [], []])
    expect(foundIn([['user', invoke('j-aaaa')], ['agent', `${image}\n\n${clip}`]])).toStrictEqual([[], []])
  })

  it('shows an asset whose job only a later section started', () => {
    expect(foundIn([['agent', image], ['user', 'Go on.'], ['agent', invoke('j-aaaa')]])).toStrictEqual([[], [], []])
  })
})

describe('findKeptAssets', () => {
  const DATA = { count: 1, lastId: 'd', pictures: [] }
  const TAG = compactionTagText(DATA)
  const keptImage = idImage(HIDDEN_IMAGE_PATH, 'b', true)
  const keptClip = mediaTagTextWithKeptMark(findMediaTags(hiddenClip('j-aaaa'))[0], true)
  const linked = idImage('/home/u/Pictures/cat.png', 'a', true)

  // The text of each kept asset, for each section.
  function kept(sections: { role: 'user' | 'agent', text: string }[]): string[][] {
    return findKeptAssets(sections).map((assets, index) => assets.map((asset) => sections[index].text.slice(asset.from, asset.to)))
  }

  it('finds the assets of the compaction block and the kept assets of the section of the carried assets of the user', () => {
    const sections = [
      { role: 'agent' as const, text: compactionBlockText(DATA, `## Summary\n\nDone.\n\n${keptClip}\n@c | audio clip\n\n${keptImage}\n@b | image`) },
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

  // The block shows only as its chips, so no asset in it can show.
  it('takes every asset of the block, with or without the kept mark, and none after the block', () => {
    const shown = idImage(HIDDEN_IMAGE_PATH, 'b')
    const clip = hiddenClip('j-aaaa')
    const block = compactionBlockText(DATA, `See ${keptImage}\n\n${shown}\n\n${clip}`)

    expect(kept([{ role: 'agent', text: `${block}\n${shown}` }])).toStrictEqual([[keptImage, shown, clip]])
    // The old form: the notes run to the end of the section.
    expect(kept([{ role: 'agent', text: `${TAG.replace(/>$/, '/>')}\n${shown}` }])).toStrictEqual([[shown]])
  })

  it('takes in the section of the carried assets of the user an image only when it is alone on its line, and no asset with no mark', () => {
    const shown = idImage('/home/u/Pictures/dog.png', 'c')

    expect(kept([{ role: 'agent', text: compactionBlockText(DATA, '') }, { role: 'user', text: `${CARRIED_USER_ASSETS_LABEL}\nSee ${linked}\n\n${shown}` }]))
      .toStrictEqual([[], []])
  })
})

describe('the marker of a hidden asset', () => {
  it('stays in an image reference that gets a new id', () => {
    const text = hiddenImage('j-aaaa')
    const [reference] = findImageReferences(text, 'agent')
    const change = imageIdChange(reference, 'f')

    expect(text.slice(0, change.from) + change.insert + text.slice(change.to))
      .toBe(`![id=f|tool=model_invoke|hidden=j-aaaa](${HIDDEN_IMAGE_PATH})`)
  })

  it('stays in the tag of a clip that is saved, and of one whose saved file is deleted', () => {
    const [tag] = findMediaTags(hiddenClip('j-aaaa'))
    const saved = mediaTagText(savedMediaTag(tag, '/home/u/.config/dez/assets/generated/audio/two.wav'))

    expect(saved).toContain(' src="/home/u/.config/dez/assets/generated/audio/two.wav" ')
    expect(saved).toMatch(/ tool="model_invoke" hidden="j-aaaa"\/>$/)
    expect(mediaTagText(unsavedMediaTag(tag))).toMatch(/ src="https:\/\/clips\.example\/one\.wav" .* hidden="j-aaaa"\/>$/)
  })
})

describe('findJobResults', () => {
  const results = jobsWaitText([
    { id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.', call: { number: 1, label: 'A cat' } },
    { id: 'j-bbbb', tool: 'model_invoke', status: 'failed', text: 'The provider refused the prompt.', call: { number: 2, label: 'A dog' } },
  ], 1)

  // The status of the result of each block of each section of a
  // conversation of `texts`; null for none.
  function statuses(texts: [Role, string][]): (string | null)[][] {
    return findJobResults(conversation(texts)).map((blocks) => blocks.map((result) => result?.status ?? null))
  }

  it('gives each block that started a job the result that a jobs_wait block of its section holds for the job', () => {
    const text = `${invoke('j-aaaa')}\n${invoke('j-bbbb', { id: 'call_2' })}\n${wait('1 job ended.')}\n\n${wait(results)}`

    expect(findJobResults(conversation([['agent', text]]))).toStrictEqual([[
      { id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: 'The cat is blue.', call: { number: 1, label: 'A cat' } },
      { id: 'j-bbbb', tool: 'model_invoke', status: 'failed', text: 'The provider refused the prompt.', call: { number: 2, label: 'A dog' } },
      null,
      null,
    ]])
  })

  it('gives null for a job that no jobs_wait block gave, and reads no block of another tool', () => {
    const other = toolBlockText({ id: 'call_x', name: 'model_list', status: 'success', arguments: {}, result: results })

    expect(statuses([['agent', `${invoke('j-cccc')}\n${wait(results)}`]])).toStrictEqual([[null, null]])
    expect(statuses([['agent', `${invoke('j-aaaa')}\n${other}`]])).toStrictEqual([[null, null]])
  })

  it('gives the block of an earlier reply the result that a later reply gave for its job, past a user section', () => {
    expect(statuses([['agent', `${invoke('j-aaaa')}\n\nWorking.`], ['user', 'Go on.'], ['agent', wait(results)]])).toStrictEqual([['finished'], [], [null]])
  })

  it('gives a result to the nearest block that started its job, and reads no jobs_wait block of a user section', () => {
    expect(statuses([['agent', invoke('j-aaaa')], ['user', 'Again.'], ['agent', `${invoke('j-aaaa', { id: 'call_2' })}\n${wait(results)}`]]))
      .toStrictEqual([[null], [], ['finished', null]])
    expect(statuses([['agent', invoke('j-aaaa')], ['user', wait(results)]])).toStrictEqual([[null], [null]])
  })

  it('gives a result to each copy of the block that owns it, as each chip of a copy shows the assets of the job', () => {
    const copy = invoke('j-aaaa')

    // The owner is the nearest block before the jobs_wait block, a copy;
    // the first block started the same job with another call id.
    expect(statuses([['agent', `${invoke('j-aaaa', { id: 'call_2' })}\n${copy}\n${copy}\n${wait(results)}`]]))
      .toStrictEqual([[null, 'finished', 'finished', null]])
    expect(statuses([['agent', `${copy}\n${copy}`], ['user', 'Go on.'], ['agent', wait(results)]]))
      .toStrictEqual([['finished', 'finished'], [], [null]])
  })
})
