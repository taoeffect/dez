import sbp from '@sbp/sbp'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import type { ProviderConfig } from './config'
import { Provider } from './provider'
import { ProviderError, type ProviderId } from './types'

// Custom provider configs live only in the settings store
// (dez.model/customProviders/*). They are built into Provider objects on each
// lookup, so an edit takes effect at once and no copy needs to be kept in
// sync. Reading the store also lets view computeds track the configs.

const builtInProviders = new Map(
  BUILT_IN_PROVIDER_CONFIGS.map((config) => [config.id, new Provider(config, { builtIn: true })]),
)

export function getProvider(providerId: ProviderId): Provider | null {
  const builtIn = builtInProviders.get(providerId)
  if (builtIn) return builtIn
  const config = (sbp('dez.model/customProviders/list') as ProviderConfig[])
    .find((candidate) => candidate.id === providerId)
  return config ? new Provider(config, { builtIn: false }) : null
}

// An unknown id usually belongs to a deleted custom provider that a tab still
// uses. Its name is gone and its id is a UUID the user never saw, so the
// message names neither; the log keeps the id. The message does not mention
// a model, because model checks and the provider-fetch diagnostics use it too.
export function requireProvider(providerId: ProviderId): Provider {
  const provider = getProvider(providerId)
  if (!provider) {
    const error = new ProviderError('This provider does not exist. It may have been deleted.', providerId)
    console.error(`Unknown provider ${providerId}:`, error)
    throw error
  }

  return provider
}

// Built-ins in table order, then custom providers in saved order.
export function listProviders(): Provider[] {
  const customConfigs = sbp('dez.model/customProviders/list') as ProviderConfig[]
  return [
    ...builtInProviders.values(),
    ...customConfigs.map((config) => new Provider(config, { builtIn: false })),
  ]
}
