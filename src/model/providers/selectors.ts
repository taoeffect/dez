import sbp from '@sbp/sbp'
import { secret, type Secret } from '../../utils/secret'
import { nativeRequestFromFetch, nativeResponseJson, nativeResponseText, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk } from './errors'
import { getProviderInfos, getProviderSpec } from './registry'
import { providerChatRequest } from './requests'
import { streamProviderTokens } from './streaming'
import type { ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import { ProviderNotConfiguredError, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderModelsResult, type ProviderSpec } from './types'

async function configuredProviderIds(): Promise<string[]> {
  const ids = await sbp('dez.native/getConfiguredProviderIds') as string[]
  return ids
}

async function providerSecret(providerId: ProviderId): Promise<Secret<string> | null> {
  const value = await sbp('dez.native/getProviderSecret', providerId) as string | null
  return value ? secret(value) : null
}

async function refreshCopilotSecret(): Promise<Secret<string>> {
  const value = await sbp('dez.native/getCopilotChatToken') as { token: string }
  return secret(value.token)
}

async function nativeChatStream(input: ProviderStreamChatInput, spec: ProviderSpec, requestId: string, refreshCopilot = false): Promise<NativeHttpStreamResult> {
  const providerSecretValue = input.providerId === 'copilot' && refreshCopilot
    ? await refreshCopilotSecret()
    : await providerSecret(input.providerId)

  if (!providerSecretValue) {
    throw new ProviderNotConfiguredError(input.providerId)
  }

  const request = providerChatRequest(spec, input.providerId, input.messages, input.modelId, providerSecretValue)
  return await sbp('dez.http/stream', request, requestId) as NativeHttpStreamResult
}

// Fetches a provider's live model list over the network. Returns null when the
// provider needs no network request (buildModelListRequest returns null), in
// which case callers should fall back to spec.fallbackModels. Throws on any
// HTTP/parse failure WITHOUT substituting fallbackModels, so callers that need
// to detect a non-working provider (listModelsResult) can see the real error.
async function fetchProviderModels(spec: ProviderSpec, providerId: ProviderId): Promise<ModelInfo[] | null> {
  const providerSecretValue = await providerSecret(providerId)
  const options = spec.buildModelListRequest(providerSecretValue)
  if (!options) {
    return null
  }

  const request = nativeRequestFromFetch(spec.modelsUrl, options)
  const response = await sbp('dez.native/httpRequest', request) as NativeHttpResponse
  const responseText = nativeResponseText(response)
  assertProviderResponseOk(response, providerId, responseText)
  const data = nativeResponseJson<unknown>(response)
  return spec.parseModels(data)
}

export default sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return getProviderInfos(await configuredProviderIds())
  },

  async 'dez.provider/listModels' (providerId: ProviderId): Promise<ModelInfo[]> {
    const spec = getProviderSpec(providerId)
    if (!spec) {
      throw new Error(`Unknown provider: ${providerId}`)
    }

    try {
      const models = await fetchProviderModels(spec, providerId)
      // null means no network request needed → use fallback models.
      return models ?? spec.fallbackModels ?? []
    } catch (error) {
      // Existing behavior: mask failures with fallbackModels so the settings
      // UI and popup keep showing something. Callers needing real failure
      // detection use dez.provider/listModelsResult instead.
      if (spec.fallbackModels) {
        return spec.fallbackModels
      }

      throw error
    }
  },

  // Like listModels but surfaces success/failure without masking errors as
  // fallback. Basis for per-provider "working" status in the model cache.
  async 'dez.provider/listModelsResult' (providerId: ProviderId): Promise<ProviderModelsResult> {
    const spec = getProviderSpec(providerId)
    if (!spec) {
      throw new Error(`Unknown provider: ${providerId}`)
    }

    try {
      const models = await fetchProviderModels(spec, providerId)
      // null means no network request needed → counts as a working provider
      // with its fallback models.
      if (models === null) {
        return { ok: true, models: spec.fallbackModels ?? [] }
      }

      return { ok: true, models }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to list models for provider ${providerId}:`, error)
      return { ok: false, models: [], error: message }
    }
  },

  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    const spec = getProviderSpec(input.providerId)
    if (!spec) {
      throw new Error(`Unknown provider: ${input.providerId}`)
    }

    const requestId = input.requestId ?? crypto.randomUUID()
    let result = await nativeChatStream(input, spec, requestId)

    if (input.providerId === 'copilot' && result.response.status === 401) {
      await sbp('dez.http/cancelStream', result.requestId)
      result = await nativeChatStream(input, spec, requestId, true)
    }

    await streamProviderTokens(input, result)
    return { requestId: result.requestId }
  },
})
