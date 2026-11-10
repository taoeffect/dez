import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { providerInfo } from '../model/providers/testing'
import type { ProviderInfo } from '../model/providers/types'
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

sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return providers
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
  })
})
