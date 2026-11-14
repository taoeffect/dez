import { describe, expect, it } from 'vitest'
import { assetInfoIds, assetInfoLine, assetOriginText, MAX_ASSET_INFO_IDS } from './assetInfo'
import { ToolError } from './types'

function idsError(assets: string): string {
  try {
    assetInfoIds({ assets })
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('assetInfoIds did not throw')
}

describe('assetInfoIds', () => {
  it('takes ids with and without the @, split by spaces and commas, each one once', () => {
    expect(assetInfoIds({ assets: ' @c, a\n@c  bb,' })).toStrictEqual(['c', 'a', 'bb'])
  })

  it('refuses a word that is no id, and no ids', () => {
    expect(idsError('@a @B')).toBe('`assets` holds "@B", which is no id of an image or a clip. Give the ids of the images and the clips, as in "@a @c". Dez read no facts.')
    expect(idsError(' , ')).toBe('`assets` names no image and no clip. Give the ids of the images and the clips, as in "@a @c". Dez read no facts.')
  })

  it(`refuses more than ${MAX_ASSET_INFO_IDS} ids, and counts a repeated id once`, () => {
    const ids = Array.from({ length: MAX_ASSET_INFO_IDS }, (_, index) => `@${'a'.repeat(index + 1)}`)

    expect(assetInfoIds({ assets: [...ids, ids[0]].join(' ') })).toHaveLength(MAX_ASSET_INFO_IDS)
    expect(idsError([...ids, '@z'].join(' '))).toBe(`\`assets\` names ${MAX_ASSET_INFO_IDS + 1} images and clips, and one call reads at most ${MAX_ASSET_INFO_IDS}. `
      + `Call again with the first ${MAX_ASSET_INFO_IDS}, then again with the rest. Dez read no facts.`)
  })
})

describe('assetOriginText', () => {
  it('names the user or the model', () => {
    expect(assetOriginText({ kind: 'user' })).toBe('from the user')
    expect(assetOriginText({ kind: 'model', model: { providerId: 'venice', modelId: 'flux-2' } })).toBe('made by the model venice/flux-2')
    expect(assetOriginText({ kind: 'model', model: null })).toBe('made by a model')
  })

  it('names a job with its number and its call when they are known', () => {
    expect(assetOriginText({ kind: 'job', tool: 'model_invoke', number: 3, label: 'scene 3: the fox runs…' })).toBe('made by the model_invoke job 3 of its reply: "scene 3: the fox runs…"')
    expect(assetOriginText({ kind: 'job', tool: 'video', number: null, label: '' })).toBe('made by a job of the video tool')
  })

  it('names the tool of a call', () => {
    expect(assetOriginText({ kind: 'call', tool: 'image', label: 'crop {\'image\':\'a\'}' })).toBe('made by the image tool: "crop {\'image\':\'a\'}"')
    expect(assetOriginText({ kind: 'call', tool: 'audio', label: '' })).toBe('made by the audio tool')
  })
})

describe('assetInfoLine', () => {
  it('gives the id, the kind, the facts, the place, and the origin', () => {
    expect(assetInfoLine('f', 'video', 'MP4 | 5.04 s', { hidden: true, origin: { kind: 'job', tool: 'model_invoke', number: 2, label: 'scene 2' } }))
      .toBe('@f | video | MP4 | 5.04 s | hidden | made by the model_invoke job 2 of its reply: "scene 2"')
    expect(assetInfoLine('a', 'image', 'PNG', { hidden: false, origin: { kind: 'user' } })).toBe('@a | image | PNG | shown | from the user')
  })
})
