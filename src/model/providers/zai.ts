import { bearerJsonRequest } from './openaiCompatible'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'

const ZAI_API_BASE = 'https://api.z.ai/api/coding/paas/v4'
const ZAI_EXTRA_MODEL_IDS = ['glm-5.2']

function modelDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) => {
      if (part.toLowerCase() === 'glm') {
        return 'GLM'
      }

      return part ? `${part[0].toUpperCase()}${part.slice(1)}` : ''
    })
    .join(' ')
}

export const zaiFallbackModels: ModelInfo[] = [
  providerModel('zai', 'glm-5.2', 'GLM 5.2'),
  providerModel('zai', 'glm-5.1', 'GLM 5.1'),
  providerModel('zai', 'glm-5', 'GLM 5'),
  providerModel('zai', 'glm-5-turbo', 'GLM 5 Turbo'),
  providerModel('zai', 'glm-4.7', 'GLM 4.7'),
  providerModel('zai', 'glm-4.6', 'GLM 4.6'),
  providerModel('zai', 'glm-4.5', 'GLM 4.5'),
]

function mergeZaiExtraModels(models: ModelInfo[]): ModelInfo[] {
  const seenIds = new Set<string>()
  const mergedModels: ModelInfo[] = []

  for (const model of [
    ...ZAI_EXTRA_MODEL_IDS.map((id) => providerModel('zai', id, modelDisplayName(id))),
    ...models,
  ]) {
    if (seenIds.has(model.id)) {
      continue
    }

    seenIds.add(model.id)
    mergedModels.push(model)
  }

  return mergedModels
}

export const zaiProvider: ProviderSpec = {
  id: 'zai',
  name: 'Z.ai',
  modelsUrl: `${ZAI_API_BASE}/models`,
  chatUrl: `${ZAI_API_BASE}/chat/completions`,
  fallbackModels: zaiFallbackModels,
  buildModelListRequest(secret) {
    return secret ? bearerJsonRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    const models = modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        return id ? providerModel('zai', id, modelDisplayName(id)) : null
      })
      .filter((model): model is ModelInfo => model !== null)

    return models.length > 0 ? mergeZaiExtraModels(models) : zaiFallbackModels
  },
}
