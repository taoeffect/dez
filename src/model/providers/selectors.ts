import sbp from '@sbp/sbp'
import { secret, type Secret } from '../../utils/secret'
import { nativeRequestFromFetch, nativeResponseJson, nativeResponseText, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk } from './errors'
import { getProviderInfos, getProviderSpec, getProviderSpecs } from './registry'
import { providerChatRequest } from './requests'
import { streamProviderTokens } from './streaming'
import type { ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import { ProviderNotConfiguredError, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderSpec } from './types'

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

export default sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return getProviderInfos(await configuredProviderIds())
  },

  async 'dez.provider/configuredIds' (): Promise<string[]> {
    return await configuredProviderIds()
  },

  'dez.provider/specs' () {
    return getProviderSpecs()
  },

  async 'dez.provider/listModels' (providerId: ProviderId): Promise<ModelInfo[]> {
    const spec = getProviderSpec(providerId)
    if (!spec) {
      throw new Error(`Unknown provider: ${providerId}`)
    }

    const providerSecretValue = await providerSecret(providerId)
    const options = spec.buildModelListRequest(providerSecretValue)
    if (!options) {
      return spec.fallbackModels ?? []
    }

    try {
      const request = nativeRequestFromFetch(spec.modelsUrl, options)
      const response = await sbp('dez.http/request', request) as NativeHttpResponse
      const responseText = nativeResponseText(response)
      assertProviderResponseOk(response, providerId, responseText)
      const data = nativeResponseJson<unknown>(response)
      return spec.parseModels(data)
    } catch (error) {
      if (spec.fallbackModels) {
        return spec.fallbackModels
      }

      throw error
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
