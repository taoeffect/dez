import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ProviderMediaQuoteInput } from '../model/providers/streamTypes'
import { providerInfo } from '../model/providers/testing'
import type { ModelInfo, ProviderInfo } from '../model/providers/types'
import { modelInfoText } from '../model/tools/modelInfo'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToolRunResult } from '../model/tools/types'
import type { ToolRunCall } from './tools'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './tools'

const providers = [providerInfo('venice', 'Venice'), providerInfo('closed', 'Closed', false)]
const MODELS = (id: string) => [
  { id: `${id}-gemini-3-pro`, name: 'Gemini 3 Pro', provider: id },
  { id: `${id}-glm-5`, name: 'GLM 5', provider: id },
]

// The options of each model cache refresh, and what the refresh does. Set in
// beforeEach and by the tests.
let refreshes: unknown[] = []
let refreshCheck: () => Promise<void>
// The price requests, and what the provider answers to one.
let quotes: ProviderMediaQuoteInput[] = []
let quoteAnswer: () => Promise<number | null>

sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return providers
  },
  async 'dez.provider/mediaQuote' (input: ProviderMediaQuoteInput): Promise<number | null> {
    quotes.push(input)
    return quoteAnswer()
  },
  async 'dez.controller/modelCache/refresh' (options: unknown): Promise<void> {
    refreshes.push(options)
    await refreshCheck()
  },
})

function run(call: ToolRunCall): Promise<ToolRunResult> {
  return sbp('dez.controller/tools/run', call, new AbortController().signal) as Promise<ToolRunResult>
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  // As at app start: the cached models, with no raw entries.
  for (const { id } of providers) {
    sbp('dez.model/modelCache/applyProviderResult', id, { ok: true, models: MODELS(id) })
  }
  refreshes = []
  quotes = []
  quoteAnswer = async () => 0.07
  // A check that the provider passes, with an entry for each model.
  refreshCheck = async () => {
    sbp('dez.model/modelCache/applyProviderResult', 'venice', {
      ok: true,
      models: MODELS('venice'),
      entries: new Map(MODELS('venice').map(({ id }) => [id, { id, checked: true }])),
    })
  }
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/tools/run', () => {
  const columns = '(full id | name | provider | outputs). Outputs: t text, i image, a audio, v video.'

  it('lists the cached models of the configured providers that match the filter', async () => {
    expect(await run({ name: 'model_list', arguments: { filter: 'gemini' } })).toStrictEqual({
      content: `1 model matches "gemini" ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice`,
      isError: false,
    })
    expect(await run({ name: 'model_list', arguments: {} })).toStrictEqual({
      content: `2 models ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice\nvenice/venice-glm-5 | GLM 5 | Venice`,
      isError: false,
    })
  })

  it('gives an error result that names the valid letters for outputs with an unknown letter', async () => {
    expect(await run({ name: 'model_list', arguments: { outputs: 'q' } })).toStrictEqual({
      content: 'The tool failed: Unknown output letter "q". Valid letters: t text, i image, a audio, v video.',
      isError: true,
    })
  })

  it('has a runner for every tool that requests offer', async () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect((await run({ name: definition.name, arguments: {} })).content).not.toMatch(/^Unknown tool/)
    }
    expect(await run({ name: 'toString', arguments: {} })).toStrictEqual({ content: 'Unknown tool: "toString".', isError: true })
  })

  describe('model_info', () => {
    const gemini = (entry: unknown) => modelInfoText(providers[0], MODELS('venice')[0], entry)

    it('gives the raw entry in memory, with no model check', async () => {
      sbp('dez.model/modelCache/applyProviderResult', 'venice', {
        ok: true,
        models: MODELS('venice'),
        entries: new Map([['venice-gemini-3-pro', { id: 'venice-gemini-3-pro', checked: false }]]),
      })

      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: gemini({ id: 'venice-gemini-3-pro', checked: false }),
        isError: false,
      })
      expect(refreshes).toStrictEqual([])
    })

    it('checks only the model\'s provider, at once, when no raw entry is in memory, and gives the new entry', async () => {
      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: gemini({ id: 'venice-gemini-3-pro', checked: true }),
        isError: false,
      })
      expect(refreshes).toStrictEqual([{ providerIds: ['venice'], force: true }])
    })

    it('gives an error result that points to model_list when the model is gone after the check', async () => {
      refreshCheck = async () => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [], entries: new Map() })
      }

      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: 'The tool failed: The user cannot use the model "venice/venice-gemini-3-pro". '
          + 'Use model_list to find the full ids of the models that the user can use.',
        isError: true,
      })
    })

    it('stops waiting for the model check when the user stops the reply', async () => {
      // A server that never answers.
      refreshCheck = () => new Promise(() => {})
      const abort = new AbortController()
      const result = sbp('dez.controller/tools/run', { name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } }, abort.signal) as Promise<ToolRunResult>
      await vi.waitFor(() => expect(refreshes).toHaveLength(1))

      abort.abort()

      expect((await result).isError).toBe(true)
      // A stop is not a failure.
      expect(consoleError).not.toHaveBeenCalled()
    })

    describe('for a model with parameters', () => {
      const VIDEO: ModelInfo = {
        id: 'wan',
        name: 'Wan',
        provider: 'venice',
        request: 'video',
        parameters: [
          { name: 'duration', label: 'Length', options: ['4s', '8s', '12s'], default: '4s' },
          { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
          { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'], default: '16:9' },
        ],
      }
      const entry = { id: 'wan' }
      const mediaEntry = { id: 'wan', pricing_skus: { per_second: '2' } }
      const info = (call: Record<string, string> = {}) => run({ name: 'model_info', arguments: { model: 'venice/wan', ...call } })

      beforeEach(() => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', {
          ok: true,
          models: [VIDEO],
          entries: new Map([['wan', entry]]),
          mediaEntries: new Map([['wan', mediaEntry]]),
        })
        // The user's choice in the provider settings popup.
        sbp('dez.model/settings/setModelParameter', { providerId: 'venice', modelId: 'wan' }, 'duration', '8s')
        sbp('dez.model/settings/setModelParameter', { providerId: 'venice', modelId: 'wan' }, 'resolution', '720p')
      })

      it('gives the values that a request sends now, their price, and the entry of the media list', async () => {
        const values = { duration: '8s', resolution: '720p', aspect_ratio: '16:9' }

        expect(await info()).toStrictEqual({
          content: modelInfoText(providers[0], VIDEO, entry, { values, cost: { usd: 0.07 }, mediaEntry }),
          isError: false,
        })
        expect(quotes).toStrictEqual([{ providerId: 'venice', modelId: 'wan', kind: 'video', parameters: values }])
      })

      it('lets a value of the call win over the user\'s value, for this call only', async () => {
        const values = { duration: '12s', resolution: '720p', aspect_ratio: '1:1' }

        expect((await info({ parameters: '{"duration": "12s", "aspect_ratio": "1:1"}' })).content)
          .toBe(modelInfoText(providers[0], VIDEO, entry, { values, cost: { usd: 0.07 }, mediaEntry }))
        expect(quotes.map(({ parameters }) => parameters)).toStrictEqual([values])
        expect(sbp('dez.model/settings/snapshot').modelParameters).toStrictEqual({ 'venice/wan': { duration: '8s', resolution: '720p' } })
      })

      it('gives an error result, and asks for no price, for a value that the model does not take', async () => {
        expect(await info({ parameters: '{"duration": "5s"}' })).toStrictEqual({
          content: 'The tool failed: The parameter "duration" takes one of: "4s", "8s", "12s".',
          isError: true,
        })
        expect(quotes).toStrictEqual([])
      })

      it('gives no price where the provider has no price request', async () => {
        quoteAnswer = async () => null

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, entry, { values: { duration: '8s', resolution: '720p', aspect_ratio: '16:9' }, mediaEntry }))
      })

      // The provider's text can echo details of the user's account.
      it('still gives the model when the price request fails, without the provider\'s error text', async () => {
        quoteAnswer = async () => { throw new Error('Venice returned HTTP 402: account u-123 has no funds') }

        const result = await info()

        expect(result.isError).toBe(false)
        expect(result.content).not.toContain('u-123')
        expect(JSON.parse(result.content).dez.cost).toStrictEqual({ error: expect.any(String) })
        expect(consoleError).toHaveBeenCalledOnce()
      })

      it('stops waiting for the price when the user stops the reply', async () => {
        quoteAnswer = () => new Promise(() => {})
        const abort = new AbortController()
        const result = sbp('dez.controller/tools/run', { name: 'model_info', arguments: { model: 'venice/wan' } }, abort.signal) as Promise<ToolRunResult>
        await vi.waitFor(() => expect(quotes).toHaveLength(1))

        abort.abort()

        expect((await result).isError).toBe(true)
        expect(consoleError).not.toHaveBeenCalled()
      })
    })

    it('asks for no price of a model that makes no clip', async () => {
      await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })

      expect(quotes).toStrictEqual([])
    })
  })
})
