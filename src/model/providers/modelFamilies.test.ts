import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import modelFamiliesFile from './modelFamilies.json'
import {
  contextWindowOf,
  DEFAULT_FAMILY,
  familyImageLimit,
  imageLimitOf,
  imageTokens,
  messageImageLimitOf,
  modelFamiliesFileSchema,
  modelFamily,
  parseModelFamilies,
  type ImageTokenRule,
} from './modelFamilies'
import { today } from './testing'

const FILE = modelFamiliesFileSchema.safeParse(modelFamiliesFile)

describe('modelFamilies.json', () => {
  it('has the form of a model families file, with unique ids and no check day after today', () => {
    expect(FILE.error).toBeUndefined()
    const families = FILE.data?.families ?? []
    expect(new Set(families.map(({ id }) => id)).size).toBe(families.length)
    expect(families.filter(({ checked }) => checked > today()).map(({ id }) => id)).toStrictEqual([])
  })
})

describe('parseModelFamilies', () => {
  let consoleError: MockInstance<typeof console.error>
  const good = { id: 'good', match: 'acme', contextWindow: 1000, sources: ['https://acme.example/docs'], checked: '2026-11-01' }

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['a match that is no regular expression', { ...good, match: 'acme-(' }],
    ['an image rule that Dez does not know', { ...good, imageTokens: { rule: 'grid', tokens: 100 } }],
    ['an image rule with a field of another rule', { ...good, imageTokens: { rule: 'fixed', tokens: 100, patchPx: 28 } }],
    ['a window that is no positive whole number', { ...good, contextWindow: 0 }],
    ['a source that is no URL', { ...good, sources: ['The Acme docs'] }],
    ['no source', { ...good, sources: [] }],
    ['a check day that is no date', { ...good, checked: 'November' }],
    ['a field that the form does not have', { ...good, window: 1000 }],
  ])('leaves out an entry with %s, logs it, and keeps the others', (_name, bad) => {
    expect(parseModelFamilies({ families: [bad, good] })).toStrictEqual([{ ...good, match: /acme/i }])
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('gives no family, and logs it, for a file with no list of families', () => {
    expect(parseModelFamilies({ entries: [good] })).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledOnce()
  })
})

describe('modelFamily', () => {
  // The ids of one model at OpenRouter (`maker/model`, with a `:variant`), at
  // Venice (no dots), and at the maker. `null`: a model of no family.
  const FAMILIES: [string | null, string[]][] = [
    ['claude-1m', ['anthropic/claude-opus-4.6', 'claude-opus-4-6', 'claude-fable-5-2', 'claude-sonnet-5', 'claude-haiku-5-5']],
    ['claude', ['~anthropic/claude-opus-latest', 'anthropic/claude-opus-4.5', 'anthropic/claude-haiku-4.5', 'claude-opus-4-5', 'claude-3-5-sonnet-20241022']],
    ['gpt-oss', ['openai/gpt-oss-120b', 'openai-gpt-oss-120b', 'e2ee-gpt-oss-120b-p']],
    ['openai-gpt-3.5', ['openai/gpt-3.5-turbo-0613', 'gpt-35-turbo']],
    ['openai-gpt-5-chat', ['openai/gpt-5.1-chat', 'gpt-5-chat-latest']],
    ['openai-gpt-4o-mini', ['openai/gpt-4o-mini-2024-07-18', 'openai-gpt-4o-mini-2024-07-18']],
    ['openai-small-patches', ['openai/gpt-4.1-mini:batch', 'openai/o4-mini:batch', 'gpt-4.1-nano', 'gpt-5-nano', 'o4-mini']],
    ['openai-gpt-5-tiles', ['openai/gpt-5', 'openai/gpt-5:batch', 'openai/gpt-5.1-codex', 'gpt-5']],
    ['openai-tiles', ['openai/gpt-4o-2024-11-20', 'openai-gpt-4o-2024-11-20', 'openai/gpt-4.1', 'openai/o3', 'openai/o3-pro', 'openai/o3-mini:batch', 'o1']],
    ['openai-gpt-4-128k', ['openai/gpt-4-turbo', 'gpt-4.5-preview']],
    ['openai-gpt-4', ['openai/gpt-4', 'gpt-4-0613']],
    ['openai', ['openai/gpt-5-mini', 'openai/gpt-5-pro', 'openai/gpt-5.6-sol', 'openai/gpt-6-astra', 'openai/gpt-chat-latest', 'openai-gpt-56-sol', 'openai-gpt-52', 'openai-gpt-54-mini', 'openai-gpt-61-sol']],
    ['gemini-image', ['google/gemini-3-pro-image', 'google/gemini-2.5-flash-image', 'nano-banana-pro']],
    ['gemini-128k', ['google/gemini-2.5-computer-use-preview-10-2025', 'gemini-omni-flash']],
    ['gemini-2', ['google/gemini-2.5-flash']],
    ['gemini', ['google/gemini-4-carbon', 'gemini-3-5-flash']],
    ['grok', ['x-ai/grok-4.7', 'grok-4-7', 'grok-build-0-1']],
    ['glm-1m', ['z-ai/glm-5.3-flashx', 'z-ai-glm-5-3', 'zai-org-glm-5-2', 'e2ee-glm-5-2-p', 'glm-5.2']],
    ['glm', ['z-ai/glm-4.6v', 'z-ai/glm-5.1', 'zai-org-glm-4.6', 'glm-5']],
    ['kimi-k3', ['moonshotai/kimi-k3', 'kimi-k3-1-pro']],
    ['kimi', ['moonshotai/kimi-k2', 'kimi-for-coding']],
    ['minimax-m3', ['minimax/minimax-m3', 'minimax-m3-1-flash', 'MiniMax-M3']],
    ['deepseek-v4', ['deepseek/deepseek-v4.1-flash', 'deepseek-v4-1-flash', 'deepseek-flash']],
    // A model of a maker with no entry, a model that only has letters of an
    // entry in its id (`marco-o1`), a model whose docs state no window
    // (MiniMax M2, the Kimi Code ids), and an old model of a maker whose
    // entry is for its new ones.
    [null, ['google/gemma-3-27b-it', 'aidc-ai/marco-o1', 'openai/gpt-audio', 'minimax/minimax-m2.7', 'minimax-m27', 'MiniMax-M2.7', 'k3', 'k3.1-pro-highspeed', 'deepseek/deepseek-r1', 'qwen/qwen3-max']],
  ]

  it.each(FAMILIES.flatMap(([family, ids]) => ids.map((id) => [id, family] as const)))('finds the family of %s: %s', (id, family) => {
    expect(modelFamily(id).id).toBe(family)
  })

  const source = { sources: ['https://acme.example/docs'], checked: '2026-11-01' }
  const entries = parseModelFamilies({
    families: [
      { id: 'acme-big', match: 'acme-big', contextWindow: 1000, ...source },
      { id: 'acme', match: 'acme', charsPerToken: 3, imageTokens: { rule: 'fixed', tokens: 100 }, maxImages: null, manyImages: { over: 5, maxSidePx: 2000 }, ...source },
    ],
  })

  it('gives the first entry that matches, with no case, and the default numbers for the ones that it does not state', () => {
    expect(modelFamily('vendor/Acme-Big-2', entries)).toStrictEqual({ ...DEFAULT_FAMILY, id: 'acme-big', contextWindow: 1000 })
    expect(modelFamily('other', entries)).toStrictEqual(DEFAULT_FAMILY)
  })

  it('gives an entry whose docs state that there is no image limit no limit', () => {
    expect(modelFamily('acme-small', entries)).toStrictEqual({
      id: 'acme',
      charsPerToken: 3,
      imageTokens: { rule: 'fixed', tokens: 100 },
      contextWindow: DEFAULT_FAMILY.contextWindow,
      maxImages: Infinity,
      manyImages: { over: 5, maxSidePx: 2000 },
    })
  })
})

describe('imageTokens', () => {
  const tokens = (modelId: string, width: number, height: number) => imageTokens(modelFamily(modelId).imageTokens, { width, height })

  // The examples of the makers' docs (the sources of each entry).
  it.each([
    ['claude-opus-4-7', 200, 200, 64],
    ['claude-opus-4-7', 1000, 1000, 1296],
    ['claude-opus-4-7', 1092, 1092, 1521],
    ['claude-opus-4-7', 1920, 1080, 2691],
    ['claude-opus-4-7', 2000, 1500, 3888],
    // Made smaller to 2576 by 1449 pixels first.
    ['claude-opus-4-7', 3840, 2160, 4784],
    ['gpt-6-astra', 1024, 1024, 1229],
    ['gpt-6-astra', 4096, 512, 2458],
    // 768 by 768 pixels: 4 tiles.
    ['gpt-4o', 1024, 1024, 765],
    // 768 by 1536 pixels: 6 tiles.
    ['gpt-4o', 2048, 4096, 1105],
    ['gpt-5.1', 1024, 1024, 630],
    ['gpt-4o-mini', 1024, 1024, 25501],
    ['gemini-3-pro', 4000, 3000, 1120],
    ['gemini-2.5-flash', 100, 100, 2304],
    ['deepseek-flash', 8192, 8192, 1024],
  ])('counts an image for %s of %i by %i pixels as %i tokens', (modelId, width, height, expected) => {
    expect(tokens(modelId, width, height)).toBe(expected)
  })

  it('counts an upright image as the same image on its side', () => {
    expect(tokens('claude-opus-4-7', 2160, 3840)).toBe(4784)
    expect(tokens('gpt-4o', 4096, 2048)).toBe(1105)
  })

  it('counts at most the patches of the rule, and at least one square', () => {
    expect(tokens('claude-opus-4-7', 2576, 2576)).toBe(4784)
    expect(tokens('claude-opus-4-7', 1, 1)).toBe(1)
    expect(tokens('gpt-4o', 1, 1)).toBe(255)
  })

  // A model of no family: one token for each square of 28 pixels, with no
  // scale down first.
  it('counts an image for a model of no family with the default rule', () => {
    expect(tokens('mystery', 1000, 1000)).toBe(1296)
    expect(tokens('mystery', 3840, 2160)).toBe(4784)
  })

  it.each([
    ['claude-opus-4-7', 4784],
    // 30,000 patches.
    ['gpt-6-astra', 36000],
    // 2048 by 768 pixels: 8 tiles.
    ['gpt-4o', 1445],
    ['gemini-3-pro', 1120],
  ])('counts an image of an unknown size for %s as the most of its rule, %i tokens', (modelId, expected) => {
    expect(imageTokens(modelFamily(modelId).imageTokens, null)).toBe(expected)
  })

  // Floating point: 150 × 1.62 is 243.00000000000003, and 881 × 600 / 881
  // is 600.0000000000001.
  it('counts no token and no tile more for a number that comes out a hair over a whole one', () => {
    const patches: ImageTokenRule = { rule: 'patches', patchPx: 32, maxPatches: 30000, tokensPerPatch: 1.62 }
    const tiles: ImageTokenRule = { rule: 'tiles', fitPx: 1568, shortSidePx: 600, tilePx: 300, baseTokens: 0, tileTokens: 1 }

    expect(imageTokens(patches, { width: 480, height: 320 })).toBe(243)
    expect(imageTokens(tiles, { width: 881, height: 1574 })).toBe(8)
  })
})

describe('contextWindowOf', () => {
  // A host can give a model a smaller window than its maker.
  it('gives the window of the model list over the one of the family', () => {
    expect(contextWindowOf({ id: 'anthropic/claude-opus-4.6', contextWindow: 198_000 })).toBe(198_000)
    expect(contextWindowOf({ id: 'anthropic/claude-opus-4.6' })).toBe(1_000_000)
    expect(contextWindowOf({ id: 'mystery' })).toBe(DEFAULT_FAMILY.contextWindow)
  })
})

describe('familyImageLimit', () => {
  // Claude takes 600 images, but only 20 when one of them has a side over
  // a number of pixels.
  const family = { maxImages: 600, manyImages: { over: 20, maxSidePx: 2000 } }

  it('gives the lower count of a family only when a picture can have a side over the side of that count', () => {
    expect(familyImageLimit(family, 2000)).toBe(600)
    expect(familyImageLimit(family, 2001)).toBe(20)
    expect(familyImageLimit({ maxImages: 600 }, 9000)).toBe(600)
  })

  it('never gives more than the limit of the family', () => {
    expect(familyImageLimit({ maxImages: 10, manyImages: { over: 20, maxSidePx: 2000 } }, 3000)).toBe(10)
  })
})

describe('imageLimitOf', () => {
  it('gives the limit of the model list over the one of the family', () => {
    expect(imageLimitOf({ id: 'claude-opus-4-6', imageLimit: 10 })).toBe(10)
    expect(imageLimitOf({ id: 'claude-opus-4-6' })).toBe(600)
    expect(imageLimitOf({ id: 'grok-4-7' })).toBe(Infinity)
    expect(imageLimitOf({ id: 'mystery' })).toBe(DEFAULT_FAMILY.maxImages)
  })

  // A refusal told the count of one message, not of a request.
  it('does not read the limit that a refusal told', () => {
    const model = { id: 'claude-opus-4-6', imageLimit: 10, learnedImageLimit: { maxImages: 4, entry: 'hash' } }

    expect(imageLimitOf(model)).toBe(10)
  })
})

describe('messageImageLimitOf', () => {
  const learned = (maxImages: number) => ({ maxImages, entry: 'hash' })

  it('gives the lowest of the message limit of the model list, the limit that a refusal told, and the request limit', () => {
    expect(messageImageLimitOf({ id: 'claude-opus-4-6', messageImageLimit: 10 })).toBe(10)
    expect(messageImageLimitOf({ id: 'claude-opus-4-6', messageImageLimit: 10, learnedImageLimit: learned(4) })).toBe(4)
    expect(messageImageLimitOf({ id: 'claude-opus-4-6', messageImageLimit: 10, learnedImageLimit: learned(50) })).toBe(10)
    expect(messageImageLimitOf({ id: 'grok-4-7', learnedImageLimit: learned(50) })).toBe(50)
    expect(messageImageLimitOf({ id: 'mystery', messageImageLimit: 30 })).toBe(DEFAULT_FAMILY.maxImages)
  })

  it('gives the request limit for a model with no limit of one message', () => {
    expect(messageImageLimitOf({ id: 'claude-opus-4-6' })).toBe(600)
    expect(messageImageLimitOf({ id: 'claude-opus-4-6', imageLimit: 10 })).toBe(10)
    expect(messageImageLimitOf({ id: 'grok-4-7' })).toBe(Infinity)
  })
})
