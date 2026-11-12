import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import knownLimitsFile from './knownLimits.json'
import { knownLimitsFileSchema, knownLimitsOf, parseKnownLimits, type KnownLimit, type KnownLimitEntry, type KnownLimitTarget } from './knownLimits'

const FILE = knownLimitsFileSchema.safeParse(knownLimitsFile)

// The shipped limit `id`, as model_info gives it.
function shipped(id: string): KnownLimit {
  const entry = FILE.data?.limits.find((limit) => limit.id === id)
  if (!entry) throw new Error(`knownLimits.json has no limit ${id}`)
  return { text: entry.text, source: entry.source, ...(entry.limit && { limit: entry.limit }) }
}

// Today in the local time zone, as an ISO date.
function today(): string {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-')
}

describe('knownLimits.json', () => {
  it('has the form of a known limits file, with unique ids and no check day after today', () => {
    expect(FILE.error).toBeUndefined()
    const limits = FILE.data?.limits ?? []
    expect(new Set(limits.map(({ id }) => id)).size).toBe(limits.length)
    expect(limits.filter(({ checked }) => checked > today()).map(({ id }) => id)).toStrictEqual([])
  })
})

describe('parseKnownLimits', () => {
  let consoleError: MockInstance<typeof console.error>
  const good: KnownLimitEntry = { id: 'good', match: { providerId: 'acme' }, text: 'A rule.', source: 'The Acme docs', checked: '2026-11-01' }

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['a match that names no media format and no provider', { ...good, match: { modelIds: ['m'] } }],
    ['a media format that Dez does not know', { ...good, match: { mediaFormat: 'acme' } }],
    ['a request kind that Dez does not know', { ...good, match: { providerId: 'acme', request: ['painting'] } }],
    ['a check day that is no date', { ...good, checked: 'November' }],
    ['a limit that is no number', { ...good, limit: { maxImages: 'one' } }],
    ['a field that the form does not have', { ...good, note: 'x' }],
  ])('leaves out an entry with %s, logs it, and keeps the others', (_name, bad) => {
    expect(parseKnownLimits({ limits: [bad, good] })).toStrictEqual([good])
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('gives no limit, and logs it, for a file with no list of limits', () => {
    expect(parseKnownLimits({ rules: [good] })).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledOnce()
  })
})

describe('knownLimitsOf', () => {
  const venice = (modelId: string, request?: KnownLimitTarget['request']): KnownLimitTarget =>
    ({ providerId: 'venice', mediaFormat: 'venice', modelId, ...(request && { request }) })
  const BODY = 'venice-video-queue-body-size'
  const WAN_2_7 = ['venice-wan-2-7-reference-images-and-videos', 'venice-wan-2-7-voice-clips']

  // The ids are in the order of the file.
  it.each([
    ['the Wan 2.7 reference model', venice('wan-2-7-reference-to-video', 'imageToVideo'), [...WAN_2_7, BODY]],
    ['a Wan 2.7 text-to-video model', venice('wan-2-7-text-to-video', 'video'), [BODY]],
    ['a Wan 2.7 image-to-video model', venice('wan-2-7-image-to-video', 'imageToVideo'), [BODY]],
    ['a Wan 2.7 video-to-video model', venice('wan-2-7-video-to-video', 'videoToVideo'), [BODY]],
    ['a Wan 3.0 reference model', venice('wan-3-0-prime-reference-to-video', 'imageToVideo'), ['venice-wan-3-0-reference-videos-and-length', BODY]],
    ['a Kling V3 reference model', venice('kling-v3-4k-reference-to-video', 'imageToVideo'), ['venice-kling-elements-images-only', BODY]],
    ['a Kling V4 reference model', venice('kling-v4-reference-to-video', 'imageToVideo'), [BODY]],
    ['the Seedance 2.5 reference model', venice('seedance-2-5-reference-to-video-basic', 'imageToVideo'), [BODY, 'venice-seedance-2-5-reference-image-size']],
    ['Grok Imagine 1.5 Lite', venice('grok-imagine-1-5-lite-image-to-video', 'imageToVideo'), [BODY, 'venice-grok-imagine-lite-no-last-frame']],
    ['an edit model', venice('qwen-image-2-1-turbo-edit', 'imageEdit'), ['venice-image-edit-file-size']],
    ['a chat model', venice('venice-uncensored', 'chat'), []],
  ])('gives %s of a provider of the Venice format its limits', (_name, target, ids) => {
    expect(knownLimitsOf(target)).toStrictEqual(ids.map(shipped))
  })

  it('gives the Venice limits to every provider of the Venice format, and to no other provider', () => {
    const model = { modelId: 'wan-2-7-reference-to-video', request: 'imageToVideo' } as const

    expect([
      knownLimitsOf({ providerId: 'my-proxy', mediaFormat: 'venice', ...model }),
      knownLimitsOf({ providerId: 'openrouter', mediaFormat: 'openrouter', ...model }),
      knownLimitsOf({ providerId: 'venice-chat', ...model }),
    ]).toStrictEqual([[...WAN_2_7, BODY].map(shipped), [], []])
  })

  // The model cache tells the request kind.
  it('gives a limit of some request kinds to no model that Dez has no cached model of', () => {
    expect(knownLimitsOf(venice('wan-2-7-reference-to-video'))).toStrictEqual(WAN_2_7.map(shipped))
  })

  it('gives a limit only to a model that each part of its match names', () => {
    const entries: KnownLimitEntry[] = [{ id: 'acme-pictures', match: { providerId: 'acme', modelIdPrefixes: ['pic-'] }, text: 'A rule.', source: 'The Acme docs', checked: '2026-11-01', limit: { maxImages: 2 } }]
    const limits = (providerId: string, modelId: string) => knownLimitsOf({ providerId, modelId }, entries)

    expect([limits('acme', 'pic-1'), limits('other', 'pic-1'), limits('acme', 'vid-1')])
      .toStrictEqual([[{ text: 'A rule.', source: 'The Acme docs', limit: { maxImages: 2 } }], [], []])
  })
})
