import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { providerInfo } from '../model/providers/testing'
import type { ProviderInfo } from '../model/providers/types'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToolRunResult } from '../model/tools/types'
import type { ToolRunCall } from './tools'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './tools'

const providers = [providerInfo('venice', 'Venice'), providerInfo('closed', 'Closed', false)]

sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return providers
  },
})

function run(call: ToolRunCall): Promise<ToolRunResult> {
  return sbp('dez.controller/tools/run', call, new AbortController().signal) as Promise<ToolRunResult>
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const { id } of providers) {
    sbp('dez.model/modelCache/applyProviderResult', id, {
      ok: true,
      models: [
        { id: `${id}-gemini-3-pro`, name: 'Gemini 3 Pro', provider: id },
        { id: `${id}-glm-5`, name: 'GLM 5', provider: id },
      ],
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
})
