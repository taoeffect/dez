import { describe, expect, it } from 'vitest'
import type { ModelRef } from '../chat/types'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { unstoredOutputMessage, unusableModelMessage } from '../providers/unusableModel'
import { MODEL_INFO_SIZE_CAP, modelInfoPart, modelInfoTarget, modelInfoText, type ModelInfoFacts } from './modelInfo'
import { modelUsage, USAGE_TEXTS } from './modelUsage'
import { ToolError } from './types'

// The built-in OpenRouter config has `thinking`.
const OPENROUTER = { ...providerInfo('openrouter', 'OpenRouter'), supportsThinking: true }
const CLOSED = providerInfo('closed', 'Closed', false)
const FAILING = providerInfo('failing', 'Failing')
const PROVIDERS = [OPENROUTER, CLOSED, FAILING]

// Model ids can hold `/`; provider ids cannot.
const GEMINI: ModelInfo = { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', provider: OPENROUTER.id, released: '2025-11-18', imageInput: true, outputs: ['text', 'image'], request: 'chat' }
const UNKNOWN: ModelInfo = { id: 'mystery', name: 'Mystery', provider: OPENROUTER.id }
const VIDEO: ModelInfo = {
  id: 'x-ai/grok-video',
  name: 'Grok Video',
  provider: OPENROUTER.id,
  outputs: ['video'],
  request: 'video',
  parameters: [
    { name: 'duration', label: 'Length (seconds)', options: [1, 5, 10], default: 1 },
    { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] },
    { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5 },
  ],
}

const CACHE: ModelCache = {
  version: 1,
  providers: {
    openrouter: { models: [GEMINI, UNKNOWN], working: true, updatedAt: 0, lastCheckedAt: 0 },
    closed: { models: [{ id: 'm', name: 'M', provider: CLOSED.id }], working: true, updatedAt: 0, lastCheckedAt: 0 },
    failing: { models: [{ id: 'm', name: 'M', provider: FAILING.id }], working: false, updatedAt: 0, lastCheckedAt: 0 },
  },
}

const FIND_MODELS = 'Use model_list to find the full ids of the models that the user can use.'

describe('modelInfoTarget', () => {
  // The model of the reply that makes the call.
  const REPLY: ModelRef = { providerId: OPENROUTER.id, modelId: UNKNOWN.id }

  it('finds the provider and the cached model of a full id, split at the first /', () => {
    expect(modelInfoTarget(CACHE, PROVIDERS, { model: 'openrouter/google/gemini-3-pro' }, REPLY)).toStrictEqual({ provider: OPENROUTER, model: GEMINI })
  })

  it('gives the model of the reply for a call with no `model`', () => {
    expect(modelInfoTarget(CACHE, PROVIDERS, {}, REPLY)).toStrictEqual({ provider: OPENROUTER, model: UNKNOWN })
  })

  // A blank id is not "no model": only a call with no `model` gets the
  // model of the reply.
  it.each(['', 'gemini-3-pro', 'openrouter/', '/google/gemini-3-pro'])('refuses %j, which is not a full id', (model) => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model }, REPLY))
      .toThrow(new ToolError(`${JSON.stringify(model)} is not a full model id (provider/model). ${FIND_MODELS} Leave out \`model\` to get the info of your own model.`))
  })

  it('refuses a provider id that no provider has', () => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model: 'google/gemini-3-pro' }, REPLY))
      .toThrow(new ToolError(`No provider has the id "google". ${FIND_MODELS}`))
  })

  // The models that model_list lists: a configured provider whose last check
  // did not fail, and a model in its cached list.
  const UNLISTED = ['closed/m', 'failing/m', 'openrouter/gemini-3-pro']

  it.each(UNLISTED)('refuses %s, which model_list does not list', (model) => {
    expect(() => modelInfoTarget(CACHE, PROVIDERS, { model }, REPLY))
      .toThrow(new ToolError(`The user cannot use the model ${JSON.stringify(model)}. ${FIND_MODELS}`))
  })

  // A reply needs no listed model, so the call is not at fault.
  it.each([...UNLISTED, 'gone/m'])('tells a call with no `model` that Dez cannot give the model of the reply, %s, which model_list does not list', (model) => {
    const [providerId, modelId] = model.split('/')

    expect(() => modelInfoTarget(CACHE, PROVIDERS, {}, { providerId, modelId }))
      .toThrow(new ToolError(`Dez cannot give the info of your own model (${JSON.stringify(model)}) now: it is not among the models that model_list lists. `
        + 'The last model check of its provider can have failed. This is not a fault of the call: tell the user. '
        + `To get the info of another model, give its full id in \`model\`. ${FIND_MODELS}`))
  })
})

describe('modelInfoPart', () => {
  it('reads the entry that `part` names, and none for a call with no `part`', () => {
    expect(modelInfoPart({ model: 'openrouter/m', part: 'mediaEntry' })).toBe('mediaEntry')
    expect(modelInfoPart({ model: 'openrouter/m' })).toBeUndefined()
  })

  it.each(['dez', 'usage', '', 'providerentry'])('refuses %j, which is no entry', (part) => {
    expect(() => modelInfoPart({ part })).toThrow(`${JSON.stringify(part)} is not an entry of a model_info result. Use one of: providerEntry, mediaEntry, priceEntry.`)
  })
})

describe('modelInfoText', () => {
  const entry = { id: 'google/gemini-3-pro', pricing: { prompt: '0.000002' }, context_length: 1048576 }
  const chatFacts = { toggles: [], inputImages: {} }
  const parsed = (text: string) => JSON.parse(text) as Record<string, unknown> & { dez: Record<string, unknown> }

  it('gives the full id, the provider, the facts that Dez uses, the usage, and the provider entry as pretty JSON', () => {
    expect(modelInfoText(OPENROUTER, GEMINI, { entry })).toBe(JSON.stringify({
      id: 'openrouter/google/gemini-3-pro',
      name: 'Gemini 3 Pro',
      provider: { id: 'openrouter', name: 'OpenRouter' },
      dez: { request: 'chat', outputs: ['text', 'image'], inputs: ['text', 'image'], released: '2025-11-18', imageInput: true, toolCalling: true, thinking: true, unknown: ['toolCalling', 'thinking'] },
      usage: modelUsage(GEMINI, chatFacts),
      providerEntry: entry,
    }, null, 2))
  })

  // An unknown release date has no value: Dez does not act on it.
  it('gives each fact that the provider does not tell the value that Dez acts on, and names it in `unknown`', () => {
    expect(parsed(modelInfoText(OPENROUTER, UNKNOWN, { entry: { id: 'mystery' } })).dez).toStrictEqual({
      request: 'chat',
      outputs: ['text'],
      inputs: ['text', 'image'],
      imageInput: true,
      toolCalling: true,
      thinking: true,
      unknown: ['request', 'outputs', 'released', 'imageInput', 'toolCalling', 'thinking'],
    })
  })

  // Dez asks no model of such a provider for thinking, and drops the
  // reasoning of its replies.
  it('says that no model of a provider with no thinking config thinks, also one that says it thinks', () => {
    const plain = providerInfo('plain', 'Plain')
    const thinker: ModelInfo = { ...GEMINI, provider: plain.id, toolCalling: true, thinking: true }
    const facts = (model: ModelInfo) => parsed(modelInfoText(plain, model, { entry: { id: model.id } })).dez

    expect(facts({ ...UNKNOWN, provider: plain.id })).toStrictEqual({
      request: 'chat',
      outputs: ['text'],
      inputs: ['text', 'image'],
      imageInput: true,
      toolCalling: true,
      thinking: false,
      unknown: ['request', 'outputs', 'released', 'imageInput', 'toolCalling'],
    })
    expect(facts(thinker)).toStrictEqual({ request: 'chat', outputs: ['text', 'image'], inputs: ['text', 'image'], released: '2025-11-18', imageInput: true, toolCalling: true, thinking: false })
  })

  it('gives the toggles that apply, with their values, and the toggles that the model does not take', () => {
    const model: ModelInfo = { ...GEMINI, toolCalling: false, thinking: false, unsupportedSettings: ['webSearch'] }
    const toggles = [{ key: 'xSearch', label: 'X search', on: false }]

    expect(parsed(modelInfoText(OPENROUTER, model, { entry, toggles })).dez).toStrictEqual({
      request: 'chat',
      outputs: ['text', 'image'],
      inputs: ['text', 'image'],
      released: '2025-11-18',
      imageInput: true,
      toolCalling: false,
      thinking: false,
      toggles,
      togglesNotTaken: ['webSearch'],
    })
  })

  it('gives a media model its text and image rules, and image input, tools, and thinking only when the provider tells them', () => {
    const edit: ModelInfo = {
      id: 'edit',
      name: 'Edit',
      provider: OPENROUTER.id,
      outputs: ['image'],
      request: 'imageEdit',
      imageInput: true,
      toolCalling: false,
      text: { maxPromptLength: 1000 },
      images: { maxImages: 3, size: { minShortSide: 256 } },
    }
    const inputImages = { size: { minShortSide: 256, maxPixels: 4_000_000 }, limits: { maxBytes: 1000 } }

    expect(parsed(modelInfoText(OPENROUTER, edit, { entry: { id: 'edit' }, inputImages })).dez).toStrictEqual({
      request: 'imageEdit',
      outputs: ['image'],
      inputs: ['text', 'image'],
      imageInput: true,
      toolCalling: false,
      unknown: ['released'],
      text: { maxPromptLength: 1000 },
      images: { minImages: 1, maxImages: 3, size: { minShortSide: 256, maxPixels: 4_000_000 }, limits: { maxBytes: 1000 } },
    })
    expect(parsed(modelInfoText(OPENROUTER, { ...edit, imageInput: undefined, toolCalling: undefined }, { entry: { id: 'edit' } })).dez).toStrictEqual({
      request: 'imageEdit',
      outputs: ['image'],
      inputs: ['text', 'image'],
      unknown: ['released'],
      text: { maxPromptLength: 1000 },
      images: { minImages: 1, maxImages: 3 },
    })
  })

  // JSON has no Infinity: an edit model with no image rules takes every
  // image of the message.
  it('gives no `maxImages` to a model that takes every image', () => {
    const edit: ModelInfo = { id: 'edit', name: 'Edit', provider: OPENROUTER.id, outputs: ['image'], request: 'imageEdit', imageInput: true }

    expect(parsed(modelInfoText(OPENROUTER, edit, { entry: { id: 'edit' } })).dez.images).toStrictEqual({ minImages: 1 })
  })

  // The rules of an OpenRouter video model depend on its "Images as"
  // value (mediaFormats.ts); `values` are the ones that a request sends.
  it('gives the image rules and usage of the parameter values that a request sends', () => {
    const video: ModelInfo = {
      id: 'video',
      name: 'Video',
      provider: OPENROUTER.id,
      outputs: ['video'],
      request: 'video',
      imageInput: true,
      images: { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, references: { promptName: '@Image{n}' } } } },
    }
    const info = (values: Record<string, string>) => parsed(modelInfoText(OPENROUTER, video, { entry: { id: 'video' }, values }))
    const asFrames = info({ images_as: 'frames' })
    const asReferences = info({ images_as: 'references' })

    expect([asFrames.dez.images, asReferences.dez.images]).toStrictEqual([
      { minImages: 0, maxImages: 2 },
      { minImages: 0, maxImages: 16, references: true, promptName: '@Image{n}' },
    ])
    expect([asFrames, asReferences].map(({ usage }) => (usage as string[]).includes(USAGE_TEXTS.videoReferences))).toStrictEqual([false, true])
  })

  // The submit refuses a message with more images (learnedImageLimit.ts).
  it('gives the most images that a refusal of the provider told, in the facts and in the usage', () => {
    const film: ModelInfo = { id: 'film', name: 'Film', provider: OPENROUTER.id, outputs: ['video'], request: 'imageToVideo', imageInput: true, images: { maxImages: 2 } }
    const learned = parsed(modelInfoText(OPENROUTER, { ...film, learnedImageLimit: { maxImages: 1, entry: '0badf00d' } }, { entry: { id: 'film' } }))
    const usage = (maxImages: number) => parsed(modelInfoText(OPENROUTER, { ...film, images: { maxImages } }, { entry: { id: 'film' } })).usage

    expect(learned.dez.images).toStrictEqual({ minImages: 1, maxImages: 1 })
    expect(learned.usage).toStrictEqual(usage(1))
    expect(learned.usage).not.toStrictEqual(usage(2))
  })

  it('tells why Dez sends no request to a model that it cannot use, or whose images it cannot store', () => {
    const sketcher: ModelInfo = { id: 'sketch', name: 'Sketcher', provider: OPENROUTER.id, outputs: ['image'], request: 'none' }
    const scanner: ModelInfo = { id: 'scan', name: 'Scanner', provider: OPENROUTER.id, outputs: ['image'], request: 'image', imageInput: false, unstoredOutput: 'TIFF' }

    expect(parsed(modelInfoText(OPENROUTER, sketcher, { entry: {} })).dez).toStrictEqual({
      request: 'none',
      outputs: ['image'],
      inputs: [],
      unknown: ['released'],
      cannotUse: unusableModelMessage('Sketcher', sketcher),
    })
    expect(parsed(modelInfoText(OPENROUTER, scanner, { entry: {} })).dez).toStrictEqual({
      request: 'image',
      outputs: ['image'],
      inputs: [],
      imageInput: false,
      unknown: ['released'],
      images: { minImages: 0, maxImages: 0 },
      unstoredOutput: 'TIFF',
      cannotUse: unstoredOutputMessage('Scanner', 'TIFF'),
    })
  })

  it('gives the known limits of the model, and no `limits` when it has none', () => {
    const limits = [
      { text: 'At most 5 images and videos together.', source: 'The provider docs', limit: { maxImagesAndVideos: 5 } },
      { text: 'Dez checks no length of a voice.', source: 'Dez' },
    ]

    expect(parsed(modelInfoText(OPENROUTER, GEMINI, { entry, limits })).dez.limits).toStrictEqual(limits)
    expect(parsed(modelInfoText(OPENROUTER, GEMINI, { entry, limits: [] })).dez).not.toHaveProperty('limits')
  })

  it('says so in a note when Dez has no provider entry, and keeps the other entries', () => {
    const result = parsed(modelInfoText(OPENROUTER, VIDEO, { mediaEntry: { id: 'm' }, priceEntry: [{ cost: 1 }] }))

    expect(result).not.toHaveProperty('providerEntry')
    expect(result.mediaEntry).toStrictEqual({ id: 'm' })
    expect(result.priceEntry).toStrictEqual([{ cost: 1 }])
    expect(result.note).toBe('Dez has no entry from the provider\'s model list for this model now. Try again later.')
  })

  describe(`within ${MODEL_INFO_SIZE_CAP} characters`, () => {
    const padded = (padding: string) => ({ ...entry, description: padding })
    const withPadding = (padding: string, facts: ModelInfoFacts = {}) => modelInfoText(OPENROUTER, GEMINI, { entry: padded(padding), ...facts })
    const fitting = 'x'.repeat(MODEL_INFO_SIZE_CAP - withPadding('').length)

    it('keeps an entry up to the limit', () => {
      expect(withPadding(fitting)).toHaveLength(MODEL_INFO_SIZE_CAP)
      expect(parsed(withPadding(fitting)).providerEntry).toStrictEqual(padded(fitting))
    })

    it('leaves out an entry over the limit, names it with its size in the note, and keeps `dez` and `usage`', () => {
      const result = parsed(withPadding(`${fitting}x`))

      expect(result).not.toHaveProperty('providerEntry')
      expect(result.note).toContain(`providerEntry (${JSON.stringify(padded(`${fitting}x`), null, 2).length} characters)`)
      expect(result.dez).toStrictEqual(parsed(withPadding('')).dez)
      expect(result.usage).toStrictEqual(modelUsage(GEMINI, chatFacts))
      expect(withPadding(`${fitting}x`).length).toBeLessThanOrEqual(MODEL_INFO_SIZE_CAP)
    })

    it('keeps a later entry that fits when an earlier one does not', () => {
      const result = parsed(withPadding('x'.repeat(MODEL_INFO_SIZE_CAP), { mediaEntry: { id: 'm' }, priceEntry: [{ cost: 1 }] }))

      expect(result).not.toHaveProperty('providerEntry')
      expect(result.mediaEntry).toStrictEqual({ id: 'm' })
      expect(result.priceEntry).toStrictEqual([{ cost: 1 }])
      expect(result.note).not.toContain('mediaEntry')
    })

    it('keeps the entries in order while the result fits, and leaves out the rest', () => {
      const half = 'x'.repeat(MODEL_INFO_SIZE_CAP / 2)
      const text = modelInfoText(OPENROUTER, GEMINI, { entry, mediaEntry: { a: half }, priceEntry: { b: half } })
      const result = parsed(text)

      expect(result.providerEntry).toStrictEqual(entry)
      expect(result.mediaEntry).toStrictEqual({ a: half })
      expect(result).not.toHaveProperty('priceEntry')
      expect(result.note).toContain('priceEntry')
      expect(text.length).toBeLessThanOrEqual(MODEL_INFO_SIZE_CAP)
    })
  })

  describe('with `part`', () => {
    it('gives only the id and that entry', () => {
      expect(modelInfoText(OPENROUTER, VIDEO, { entry: { id: 'v' }, mediaEntry: { id: 'm' } }, 'mediaEntry'))
        .toBe(JSON.stringify({ id: 'openrouter/x-ai/grok-video', mediaEntry: { id: 'm' } }, null, 2))
    })

    it('refuses an entry that the model does not have', () => {
      expect(() => modelInfoText(OPENROUTER, VIDEO, { entry: { id: 'v' } }, 'priceEntry'))
        .toThrow('Dez has no priceEntry for this model now. Call model_info without `part` to see which entries it has.')
    })

    // In the result each line of the entry has 2 more spaces, so an entry
    // under the limit alone can make a result over it.
    it('cuts an entry whose result is over the limit, and gives the checked length in the note', () => {
      const big = { lines: Array.from({ length: 2300 }, (_, index) => `"line" ${index}`) }
      const entryText = JSON.stringify(big, null, 2)
      const wholeLength = JSON.stringify({ id: 'openrouter/x-ai/grok-video', providerEntry: big }, null, 2).length
      const text = modelInfoText(OPENROUTER, VIDEO, { entry: big }, 'providerEntry')
      const result = JSON.parse(text) as { providerEntry: string, note: string }

      expect(entryText.length).toBeLessThan(MODEL_INFO_SIZE_CAP)
      expect(wholeLength).toBeGreaterThan(MODEL_INFO_SIZE_CAP)
      expect(entryText.startsWith(result.providerEntry)).toBe(true)
      expect(result.note).toContain(`${wholeLength} characters, over the limit of ${MODEL_INFO_SIZE_CAP}`)
      expect(result.note).toContain(`${entryText.length} characters`)
      // One more character of the text is at most 2 more of the result
      // (an escape such as `\n` or `\"`).
      expect(text.length).toBeLessThanOrEqual(MODEL_INFO_SIZE_CAP)
      expect(text.length).toBeGreaterThan(MODEL_INFO_SIZE_CAP - 2)
    })
  })

  describe('for a model with parameters', () => {
    const videoEntry = { id: 'x-ai/grok-video' }
    const mediaEntry = { id: 'x-ai/grok-video', pricing_skus: { cents_per_video_output_second_480p: '2' } }

    it('gives each parameter with the value that a request sends, the price, and the entries of the media list and the prices', () => {
      const priceEntry = [{ billable_type: 'output_image', cost: 0.04 }]
      const result = modelInfoText(OPENROUTER, VIDEO, { entry: videoEntry, values: { duration: 5, duration_seconds: 5 }, cost: { usd: 0.1 }, mediaEntry, priceEntry })

      expect(JSON.parse(result)).toStrictEqual({
        id: 'openrouter/x-ai/grok-video',
        name: 'Grok Video',
        provider: { id: 'openrouter', name: 'OpenRouter' },
        dez: {
          request: 'video',
          outputs: ['video'],
          inputs: ['text'],
          unknown: ['released'],
          images: { minImages: 0, maxImages: 0 },
          parameters: [
            { name: 'duration', label: 'Length (seconds)', options: [1, 5, 10], default: 1, value: 5 },
            // No value: the provider's own default applies.
            { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] },
            { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5, value: 5 },
          ],
          cost: { usd: 0.1 },
        },
        usage: modelUsage(VIDEO, { toggles: [], inputImages: {} }),
        providerEntry: videoEntry,
        mediaEntry,
        priceEntry,
      })
    })

    it('tells that the provider gave no price', () => {
      const result = parsed(modelInfoText(OPENROUTER, VIDEO, { entry: videoEntry, values: {}, cost: { error: 'No answer' } }))

      expect(result.dez.cost).toStrictEqual({ error: 'No answer' })
    })

    it('sends a stand-in for a local file path in an option and in the media and price entries', () => {
      const local: ModelInfo = { ...VIDEO, parameters: [{ name: 'voice', label: 'Voice', options: ['/home/alice/voices/a.bin', 'af_alloy'] }] }
      const result = parsed(modelInfoText(OPENROUTER, local, { entry: videoEntry, values: {}, mediaEntry: { root: '/home/alice/acme-bot' }, priceEntry: ['~/prices'] }))

      expect(result.dez.parameters).toStrictEqual([{ name: 'voice', label: 'Voice', options: ['/home/…', 'af_alloy'] }])
      expect(result.mediaEntry).toStrictEqual({ root: '/home/…' })
      expect(result.priceEntry).toStrictEqual(['~/…'])
    })
  })

  // A local server can use a file path as the model id, and its entry can
  // hold more paths (vLLM's `root`).
  describe('with local file paths in the provider entry', () => {
    const LOCAL = providerInfo('local', 'Local')
    const path = '/home/alice/acme-bot/llama-3'
    const served: ModelInfo = { id: path, name: path, provider: LOCAL.id, outputs: ['text'], request: 'chat', imageInput: false, toolCalling: false, thinking: false }

    it('sends a stand-in for each path of the entry, and keeps the model\'s own id and name', () => {
      const result = modelInfoText(LOCAL, served, { entry: { id: path, object: 'model', root: path, parent: null, max_model_len: 8192 } })

      expect(JSON.parse(result)).toStrictEqual({
        id: `local/${path}`,
        name: path,
        provider: { id: 'local', name: 'Local' },
        dez: { request: 'chat', outputs: ['text'], inputs: ['text'], imageInput: false, toolCalling: false, thinking: false, unknown: ['released'] },
        usage: modelUsage(served, { toggles: [], inputImages: {} }),
        providerEntry: { id: '/home/…', object: 'model', root: '/home/…', parent: null, max_model_len: 8192 },
      })
    })

    it('counts the stand-ins, not the paths, for the size limit', () => {
      const result = parsed(modelInfoText(LOCAL, served, { entry: { root: `${path}/${'x'.repeat(MODEL_INFO_SIZE_CAP)}` } }))

      expect(result.providerEntry).toStrictEqual({ root: '/home/…' })
      expect(result).not.toHaveProperty('note')
    })
  })
})
