import sbp from '@sbp/sbp'
import type { Secret } from '../../utils/secret'
import { responseOk, sanitizeSensitiveErrorText } from '../../utils/protocol/errors'
import { nativeResponseText, readNativeChunkText, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk, providerStatusError } from '../../model/providers/errors'
import { providerSecret, type ChatMessage, type Provider } from '../../model/providers'
import { buildProviderFetchReport, providerSecretError, readFirstToken, resolveRequestedProviders, selectProbeModel } from './providerFetchUtils'
import type { ChatProbeResult, ModelProbeResult, ProviderFetchProbeResult, ProviderFetchSpikeOptions } from './providerFetchTypes'

// The models the server reports, without the config models, so the report
// shows what the endpoint itself returned.
async function probeModelList(provider: Provider, providerSecretValue: Secret<string> | null): Promise<ModelProbeResult> {
  try {
    if (!providerSecretValue && provider.requiresKey) {
      throw providerSecretError()
    }

    const listRequest = provider.modelListRequest(providerSecretValue)
    if (!listRequest) {
      return { ok: true, error: null, models: [] }
    }

    const response = await sbp('dez.native/httpRequest', listRequest) as NativeHttpResponse
    const responseText = nativeResponseText(response)
    assertProviderResponseOk(response, provider, responseText)
    return {
      ok: true,
      error: null,
      models: provider.parseModels(JSON.parse(responseText) as unknown),
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
  provider: Provider,
  providerSecretValue: Secret<string> | null,
  messages: ChatMessage[],
  modelId: string,
) {
  if (!providerSecretValue && provider.requiresKey) {
    throw providerSecretError()
  }

  // Only the id: a probe sends every toggle of the provider at its default.
  return provider.chatRequest(messages, { id: modelId }, providerSecretValue).request
}

async function probeChat(
  provider: Provider,
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
    const request = chatRequestForProvider(provider, providerSecretValue, messages, modelId)
    result = await sbp('dez.http/stream', request) as NativeHttpStreamResult

    if (!responseOk(result.response)) {
      const text = await readNativeChunkText(result.chunks)
      throw providerStatusError(provider, result.response, text)
    }

    const streaming = await Promise.race([
      readFirstToken(provider, result.chunks),
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
    const providers = await resolveRequestedProviders(options?.providers)
    const results: ProviderFetchProbeResult[] = []
    const prompt = options?.prompt ?? 'ping'

    for (const provider of providers) {
      const providerSecretValue = await providerSecret(provider.id)
      const nativeModels = await probeModelList(provider, providerSecretValue)
      const modelId = selectProbeModel(provider, nativeModels.models, options?.modelOverride)
      const nativeChat = await probeChat(provider, providerSecretValue, modelId, prompt)

      results.push({
        providerId: provider.id,
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
