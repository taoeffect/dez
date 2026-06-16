import { bearerJsonRequest } from './openaiCompatible'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'

const VENICE_API_BASE = 'https://api.venice.ai/api/v1'

export const VENICE_CHAT_PARAMETERS = {
  include_venice_system_prompt: false,
  enable_web_search: 'on',
  enable_x_search: true,
  enable_web_scraping: true,
} as const

export const veniceProvider: ProviderSpec = {
  id: 'venice',
  name: 'Venice',
  modelsUrl: `${VENICE_API_BASE}/models`,
  chatUrl: `${VENICE_API_BASE}/chat/completions`,
  buildModelListRequest(secret) {
    return secret ? bearerJsonRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    return modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'name') ?? id
        return id ? providerModel('venice', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)
  },
}
