import { anthropicModelListRequest } from './anthropicCompatible'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'

const MINIMAX_ANTHROPIC_API_BASE = 'https://api.minimax.io/anthropic/v1'

export const minimaxFallbackModels: ModelInfo[] = [
  providerModel('minimax', 'MiniMax-M2.7', 'MiniMax M2.7'),
  providerModel('minimax', 'MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed'),
  providerModel('minimax', 'MiniMax-M2.5', 'MiniMax M2.5'),
  providerModel('minimax', 'MiniMax-M2.5-highspeed', 'MiniMax M2.5 Highspeed'),
  providerModel('minimax', 'MiniMax-M2.1', 'MiniMax M2.1'),
  providerModel('minimax', 'MiniMax-M2.1-highspeed', 'MiniMax M2.1 Highspeed'),
  providerModel('minimax', 'MiniMax-M2', 'MiniMax M2'),
]

export const minimaxProvider: ProviderSpec = {
  id: 'minimax',
  name: 'MiniMax',
  modelsUrl: `${MINIMAX_ANTHROPIC_API_BASE}/models`,
  chatUrl: `${MINIMAX_ANTHROPIC_API_BASE}/messages`,
  fallbackModels: minimaxFallbackModels,
  buildModelListRequest(secret) {
    return secret ? anthropicModelListRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    const models = modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'display_name') ?? id
        return id ? providerModel('minimax', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)

    return models.length > 0 ? models : minimaxFallbackModels
  },
}
