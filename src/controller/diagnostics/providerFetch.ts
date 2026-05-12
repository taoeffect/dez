import sbp from '@sbp/sbp'
import type { Secret } from '../../utils/secret'
import { responseOk, sanitizeSensitiveErrorText } from '../../utils/protocol/errors'
import { nativeRequestFromFetch, nativeResponseText, readNativeChunkText, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk, providerStatusError } from '../../model/providers/errors'
import { getProviderSpec, type ChatMessage, type ProviderSpec } from '../../model/providers'
import { providerChatRequest } from '../../model/providers/requests'
import { buildProviderFetchReport, providerSecret, providerSecretError, readFirstToken, resolveRequestedProviders, selectProbeModel } from './providerFetchUtils'
import type { ChatProbeResult, ModelProbeResult, ProviderFetchProbeResult, ProviderFetchSpikeOptions } from './providerFetchTypes'

async function probeModelList(spec: ProviderSpec, providerSecretValue: Secret<string> | null): Promise<ModelProbeResult> {
  try {
    const options = spec.buildModelListRequest(providerSecretValue)
    if (!options) {
      throw providerSecretError()
    }

    const request = {
      ...nativeRequestFromFetch(spec.modelsUrl, options),
      timeoutMs: 20000,
    }
    const response = await sbp('dez.http/request', request) as NativeHttpResponse
    const responseText = nativeResponseText(response)
    assertProviderResponseOk(response, spec.id, responseText)
    return {
      ok: true,
      error: null,
      models: spec.parseModels(JSON.parse(responseText) as unknown),
    }
  } catch (error) {
    return {
      ok: false,
      error: sanitizeSensitiveErrorText(error),
      models: [],
    }
  }
}

function chatRequestForProvider(
  spec: ProviderSpec,
  providerSecretValue: Secret<string> | null,
  messages: ChatMessage[],
  modelId: string,
) {
  if (!providerSecretValue) {
    throw providerSecretError()
  }

  return providerChatRequest(spec, spec.id, messages, modelId, providerSecretValue)
}

async function probeChat(
  spec: ProviderSpec,
  providerSecretValue: Secret<string> | null,
  modelId: string,
  prompt: string,
): Promise<ChatProbeResult> {
  if (!modelId) {
    return {
      ok: false,
      error: 'No model available for provider',
      streaming: false,
    }
  }

  let result: NativeHttpStreamResult | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  try {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
    const request = chatRequestForProvider(spec, providerSecretValue, messages, modelId)
    result = await sbp('dez.http/stream', request) as NativeHttpStreamResult

    if (!responseOk(result.response)) {
      const text = await readNativeChunkText(result.chunks)
      throw providerStatusError(spec.id, result.response, text)
    }

    const streaming = await Promise.race([
      readFirstToken(spec.id, result.chunks),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          reject(new Error('Probe timed out before first token'))
        }, 20000)
      }),
    ])
    return {
      ok: true,
      error: null,
      streaming,
    }
  } catch (error) {
    return {
      ok: false,
      error: sanitizeSensitiveErrorText(timedOut ? new Error('Probe timed out before first token') : error),
      streaming: false,
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    if (result) {
      await sbp('dez.http/cancelStream', result.requestId).catch(() => undefined)
    }
  }
}

export default sbp('sbp/selectors/register', {
  async 'dez.diagnostics/runProviderFetchSpike' (options?: ProviderFetchSpikeOptions): Promise<ProviderFetchProbeResult[]> {
    const providerIds = await resolveRequestedProviders(options?.providers)
    const results: ProviderFetchProbeResult[] = []
    const prompt = options?.prompt ?? 'ping'

    for (const providerId of providerIds) {
      const spec = getProviderSpec(providerId)
      if (!spec) {
        const error = new Error(`Unknown provider: ${providerId}`)
        console.error(error)
        throw error
      }

      const providerSecretValue = await providerSecret(providerId)
      const nativeModels = await probeModelList(spec, providerSecretValue)
      const modelId = selectProbeModel(providerId, spec, nativeModels.models, options?.modelOverride)
      const nativeChat = await probeChat(spec, providerSecretValue, modelId, prompt)

      results.push({
        providerId,
        modelId,
        nativeChatOk: nativeChat.ok,
        nativeChatError: nativeChat.error,
        nativeChatStreaming: nativeChat.streaming,
        nativeModelsOk: nativeModels.ok,
        nativeModelsError: nativeModels.error,
      })
    }

    return results
  },

  'dez.diagnostics/printProviderFetchReport' (results: ProviderFetchProbeResult[]): string {
    const report = buildProviderFetchReport(results)
    console.log(report)
    return report
  },
})
