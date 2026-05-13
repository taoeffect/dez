import sbp from '@sbp/sbp'
import type { ModelInfo, ProviderId, ProviderInfo } from '../model/providers'
import type { CopilotDeviceFlowResponse } from './nativeTypes'

interface ProviderSettingsData {
  providers: ProviderInfo[]
  providerModels: Record<string, ModelInfo[]>
}

interface CopilotDeviceFlowViewState {
  userCode: string
  verificationUri: string
}

interface CopilotSignInOptions {
  onDeviceFlow?(flow: CopilotDeviceFlowViewState): void | Promise<void>
}

async function loadConfiguredProviderModels(providers: ProviderInfo[]): Promise<Record<string, ModelInfo[]>> {
  const providerModels: Record<string, ModelInfo[]> = {}

  for (const provider of providers) {
    if (!provider.configured) continue

    try {
      providerModels[provider.id] = await sbp('dez.provider/listModels', provider.id) as ModelInfo[]
    } catch (error) {
      console.error(`Failed to load models for ${provider.id}`, error)
      providerModels[provider.id] = []
    }
  }

  return providerModels
}

export default sbp('sbp/selectors/register', {
  async 'dez.controller/loadProviderSettings' (): Promise<ProviderSettingsData> {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    return {
      providers,
      providerModels: await loadConfiguredProviderModels(providers),
    }
  },

  async 'dez.controller/saveProviderSecret' (providerId: ProviderId, value: string): Promise<ProviderSettingsData> {
    await sbp('dez.native/saveProviderSecret', providerId, value)
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    return {
      providers,
      providerModels: await loadConfiguredProviderModels(providers),
    }
  },

  async 'dez.controller/signInWithCopilot' (options: CopilotSignInOptions = {}): Promise<ProviderSettingsData> {
    const flow = await sbp('dez.native/copilotStartDeviceFlow') as CopilotDeviceFlowResponse
    const viewState = {
      userCode: flow.user_code,
      verificationUri: flow.verification_uri,
    }

    await options.onDeviceFlow?.(viewState)
    await sbp('dez.ui/copyText', viewState.userCode).catch(() => undefined)
    sbp('dez.controller/openUrl', viewState.verificationUri)

    for (let i = 0; i < 60; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const done = await sbp('dez.native/copilotPollDeviceFlow', flow.device_code) as boolean
      if (done) {
        const providers = await sbp('dez.provider/infos') as ProviderInfo[]
        return {
          providers,
          providerModels: await loadConfiguredProviderModels(providers),
        }
      }
    }

    throw new Error('Copilot sign-in timed out. Please try again.')
  },
})
