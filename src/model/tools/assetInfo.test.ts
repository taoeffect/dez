import { describe, expect, it } from 'vitest'
import { assetIdsArgument, assetInfoLine, assetOriginText } from './assetInfo'
import { ToolError } from './types'

const RULE = { max: 3, notDone: 'Dez did nothing.' }

function idsError(assets: string): string {
  try {
    assetIdsArgument({ assets }, RULE)
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('assetIdsArgument did not throw')
}

describe('assetIdsArgument', () => {
  it('takes ids with and without the @, split by spaces and commas, each one once', () => {
    expect(assetIdsArgument({ assets: ' @c, a\n@c  bb,' }, RULE)).toStrictEqual(['c', 'a', 'bb'])
  })

  it('refuses a word that is no id, and no ids, and tells what Dez did not do', () => {
    expect(idsError('@a @B')).toMatch(/"@B".*Dez did nothing\.$/)
    expect(idsError(' , ')).toMatch(/Dez did nothing\.$/)
  })

  it('refuses more than the most ids of one call, and counts a repeated id once', () => {
    expect(assetIdsArgument({ assets: '@a @b @c @a' }, RULE)).toHaveLength(3)
    expect(idsError('@a @b @c @d')).toMatch(/at most 3\b.*Dez did nothing\.$/)
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
