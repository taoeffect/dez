import { bearerJsonRequest } from './openaiCompatible'
import { isRecord, modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'

export const openRouterProvider: ProviderSpec = {
  id: 'openrouter',
  name: 'OpenRouter',
  modelsUrl: `${OPENROUTER_API_BASE}/models`,
  chatUrl: `${OPENROUTER_API_BASE}/chat/completions`,
  buildModelListRequest(secret) {
    return secret ? bearerJsonRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    return modelData(data)
      .filter((model) => {
        const architecture = model.architecture
        if (!isRecord(architecture) || !Array.isArray(architecture.output_modalities)) {
          return false
        }

        return architecture.output_modalities.length === 1 && architecture.output_modalities[0] === 'text'
      })
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'name') ?? id
        return id ? providerModel('openrouter', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)
  },
}
