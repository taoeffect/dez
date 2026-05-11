import { registerProviderSpec } from './registry'
import { charmHyperProvider } from './charmHyper'
import { copilotProvider } from './copilot'
import { minimaxProvider } from './minimax'
import { openRouterProvider } from './openrouter'
import { veniceProvider } from './venice'
import { zaiProvider } from './zai'

export function registerBuiltInProviders(): void {
  registerProviderSpec(openRouterProvider)
  registerProviderSpec(zaiProvider)
  registerProviderSpec(veniceProvider)
  registerProviderSpec(charmHyperProvider)
  registerProviderSpec(minimaxProvider)
  registerProviderSpec(copilotProvider)
}

registerBuiltInProviders()
