import { bearerJsonRequest } from './openaiCompatible'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSpec } from './types'

const CHARM_HYPER_API_BASE = 'https://hyper.charm.land/v1'

export const charmHyperProvider: ProviderSpec = {
  id: 'charm_hyper',
  name: 'Charm Hyper',
  modelsUrl: `${CHARM_HYPER_API_BASE}/models`,
  chatUrl: `${CHARM_HYPER_API_BASE}/chat/completions`,
  buildModelListRequest(secret) {
    return secret ? bearerJsonRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    return modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'name') ?? id
        return id ? providerModel('charm_hyper', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)
  },
}
