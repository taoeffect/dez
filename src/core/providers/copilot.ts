import type { Secret } from '../secret'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'
import type { HttpFetchOptions } from '../protocol/http'

const COPILOT_API_BASE = 'https://api.githubcopilot.com'

export const copilotHeaders = {
  'Editor-Version': 'vscode/1.97.2',
  'Editor-Plugin-Version': 'copilot-chat/0.24.2',
  'User-Agent': 'GitHubCopilotChat/0.24.2',
  'Copilot-Integration-Id': 'vscode-chat',
}

export const copilotFallbackModels: ModelInfo[] = [
  providerModel('copilot', 'gpt-4o', 'GPT-4o'),
  providerModel('copilot', 'claude-sonnet-4-20250514', 'Claude Sonnet 4'),
]

export function copilotBearerRequest(secret: Secret<string>): HttpFetchOptions {
  return {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret.reveal()}`,
      ...copilotHeaders,
    },
  }
}

export const copilotProvider: ProviderSpec = {
  id: 'copilot',
  name: 'GitHub Copilot',
  modelsUrl: `${COPILOT_API_BASE}/models`,
  chatUrl: `${COPILOT_API_BASE}/chat/completions`,
  fallbackModels: copilotFallbackModels,
  buildModelListRequest(secret) {
    return secret ? copilotBearerRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    const models = modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'name') ?? id
        return id ? providerModel('copilot', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)

    return models.length > 0 ? models : [providerModel('copilot', 'gpt-4o', 'GPT-4o')]
  },
}
