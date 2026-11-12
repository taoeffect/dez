import sbp from '@sbp/sbp'
import type { ModelCache } from '../model/persistence/types'
import { listProviders, type ProviderConfig, type ProviderId } from '../model/providers'
import { configIssueText, customProviderConfigSchema } from '../model/providers/config'
import { ExplainedError, rawErrorText } from '../utils/errorText'
import type { CopilotDeviceFlowResponse } from './nativeTypes'

interface CopilotDeviceFlowViewState {
  userCode: string
  verificationUri: string
}

interface CopilotSignInOptions {
  onDeviceFlow?(flow: CopilotDeviceFlowViewState): void | Promise<void>
}

const NEW_PROVIDER_NAME = 'New provider'

export default sbp('sbp/selectors/register', {
  // Adds a custom provider with placeholder values for Settings to edit, and
  // returns it. Its models are checked when the user saves a change.
  'dez.controller/providers/add' (): ProviderConfig {
    const names = new Set((sbp('dez.model/customProviders/list') as ProviderConfig[]).map((config) => config.name))
    let name = NEW_PROVIDER_NAME
    for (let suffix = 2; names.has(name); suffix += 1) name = `${NEW_PROVIDER_NAME} ${suffix}`

    const config = customProviderConfigSchema.parse({
      // A random id, not one made from the name, so a rename keeps the key,
      // favorites, and conversation headers that refer to the provider.
      id: crypto.randomUUID(),
      name,
      baseUrl: 'http://localhost:8080/v1',
    })
    sbp('dez.model/customProviders/save', config)
    return config
  },

  // Validates and stores a custom provider, then returns the stored config,
  // normalized by the schema (trimmed text, no trailing '/'). A change can make
  // the cached models wrong (another base URL or format), so they are dropped
  // and the provider is checked again at once. The name and `thinking` are not
  // in the model list request, so a change of only those keeps the cached
  // models and starts no check. A provider with no cached result yet (one that
  // was just added) is still checked.
  'dez.controller/providers/save' (config: ProviderConfig): ProviderConfig {
    const result = customProviderConfigSchema.safeParse(config)
    if (!result.success) {
      const error = new ExplainedError(
        'Dez cannot save this provider, because a field has a value that is not valid. The details name the field. Change its value, and try again.',
        configIssueText(result.error),
      )
      console.error(error)
      throw error
    }

    const saved = result.data
    // Both configs are read back from the model, so they come from the same
    // clone and their keys are in the same order for JSON.stringify. The clone
    // writes `thinking` last, so the spread below adds a missing one in the
    // same place.
    const previous = (sbp('dez.model/customProviders/list') as ProviderConfig[])
      .find((existing) => existing.id === saved.id)
    sbp('dez.model/customProviders/save', saved)
    const current = (sbp('dez.model/customProviders/list') as ProviderConfig[])
      .find((existing) => existing.id === saved.id)
    const cached = (sbp('dez.model/modelCache/snapshot') as ModelCache).providers[saved.id]
    if (cached && previous && current
      && JSON.stringify({ ...previous, name: current.name, thinking: current.thinking }) === JSON.stringify(current)) {
      return saved
    }

    sbp('dez.model/modelCache/removeProvider', saved.id)
    void sbp('dez.controller/modelCache/refresh', { providerIds: [saved.id], force: true })
    return saved
  },

  // Removes a custom provider and everything that refers to it: settings
  // (favorites, default and last-used model, popup toggles), cached models,
  // and the stored key. Built-in providers cannot be removed.
  async 'dez.controller/providers/remove' (providerId: ProviderId): Promise<void> {
    if (!sbp('dez.model/customProviders/remove', providerId)) {
      const error = new ExplainedError(
        'Dez cannot delete the provider: only a custom provider can be deleted, and no custom provider has its id. If the provider is still in the list, report this at Help › Dez on GitHub.',
        `Provider id: "${providerId}"`,
      )
      console.error(error)
      throw error
    }

    sbp('dez.model/modelCache/removeProvider', providerId)
    try {
      await sbp('dez.native/deleteProviderSecret', providerId)
    } catch (error) {
      // The provider is already gone, so the removal does not fail; the key
      // stays unused in provider_keys.json.
      console.error(`Failed to delete the API key of removed provider ${providerId}:`, error)
    }
  },

  // Saves a provider's API key, or deletes it when the key is empty or null.
  // The key decides whether the model list loads, so the provider is checked
  // again at once.
  async 'dez.controller/providers/setApiKey' (providerId: ProviderId, key: string | null): Promise<void> {
    const value = key?.trim() ?? ''
    try {
      if (value) await sbp('dez.native/saveProviderSecret', providerId, value)
      else await sbp('dez.native/deleteProviderSecret', providerId)
    } catch (error) {
      console.error(`Failed to ${value ? 'save' : 'delete'} the API key of provider ${providerId}:`, error)
      throw new ExplainedError(
        `Dez could not ${value ? 'save the API key in' : 'remove the API key from'} its key file (provider_keys.json in the Dez folder). The system did not let Dez read or write the file, or the file is not valid JSON: the details tell which. Fix that, and try again.`,
        rawErrorText(error),
        { cause: error },
      )
    }

    void sbp('dez.controller/modelCache/refresh', { providerIds: [providerId], force: true })
  },

  async 'dez.controller/signInWithCopilot' (options: CopilotSignInOptions = {}): Promise<void> {
    try {
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
          // Copilot just became configured; check its models at once, in the
          // background so sign-in does not wait for them.
          const copilotIds = listProviders()
            .filter((provider) => provider.config.auth === 'githubCopilot')
            .map((provider) => provider.id)
          void sbp('dez.controller/modelCache/refresh', { providerIds: copilotIds, force: true })
          return
        }
      }

      throw new ExplainedError('The GitHub sign-in did not end within 5 minutes. Sign in again, and enter the code on GitHub within 5 minutes.')
    } catch (error) {
      console.error('Copilot sign-in failed:', error)
      if (error instanceof ExplainedError) throw error
      throw new ExplainedError(
        'The GitHub sign-in failed. The details tell why: the network or GitHub failed, the sign-in was refused on GitHub, the GitHub account cannot use Copilot, '
          + 'or the system did not let Dez read or write its key file (provider_keys.json in the Dez folder). Fix that, and sign in again.',
        rawErrorText(error),
        { cause: error },
      )
    }
  },
})
