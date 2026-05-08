import sbp from '@sbp/sbp'
import { secret, type Secret } from '../core/secret'
import { assertNativeResponseOk, providerStatusError, responseOk } from '../core/protocol/errors'
import { nativeRequestFromFetch, nativeResponseJson, nativeResponseText, type NativeHttpResponse, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../core/protocol/nativeHttp'
import { decodeSseData } from '../core/protocol/sse'
import { extractAnthropicSseTokens } from '../core/protocol/anthropicSse'
import { extractOpenAiSseTokens } from '../core/protocol/openaiSse'
import { anthropicChatRequest } from '../core/providers/anthropicCompatible'
import { copilotHeaders } from '../core/providers/copilot'
import { openAiChatRequest } from '../core/providers/openaiCompatible'
import { getProviderInfos, getProviderSpec, getProviderSpecs, ProviderNotConfiguredError, type ChatMessage, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderSpec } from '../core/providers'

type ProviderStreamProtocol = 'openai' | 'anthropic'

export interface ProviderStreamChatInput {
  providerId: ProviderId
  modelId: string
  messages: ChatMessage[]
  requestId?: string
  onToken(token: string): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
}

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

function providerStreamProtocol(providerId: ProviderId): ProviderStreamProtocol {
  return providerId === 'minimax' ? 'anthropic' : 'openai'
}

function providerChatRequest(spec: ProviderSpec, input: ProviderStreamChatInput, providerSecretValue: Secret<string>) {
  const options = input.providerId === 'minimax'
    ? anthropicChatRequest(providerSecretValue, input.messages, input.modelId)
    : openAiChatRequest(
      providerSecretValue,
      input.messages,
      input.modelId,
      input.providerId === 'copilot' ? copilotHeaders : {},
    )

  return nativeRequestFromFetch(spec.chatUrl, options)
}

async function nativeChatStream(input: ProviderStreamChatInput, spec: ProviderSpec, requestId: string, refreshCopilot = false): Promise<NativeHttpStreamResult> {
  const providerSecretValue = input.providerId === 'copilot' && refreshCopilot
    ? await refreshCopilotSecret()
    : await providerSecret(input.providerId)

  if (!providerSecretValue) {
    throw new ProviderNotConfiguredError(input.providerId)
  }

  const request = providerChatRequest(spec, input, providerSecretValue)
  return await sbp('dez.http/stream', request, requestId) as NativeHttpStreamResult
}

async function streamBodyText(chunks: AsyncIterable<Uint8Array>, maxLength = 1000): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''

  for await (const chunk of chunks) {
    const part = decoder.decode(chunk, { stream: true })
    if (text.length < maxLength) {
      text = `${text}${part}`.slice(0, maxLength)
    }
  }

  if (text.length < maxLength) {
    text = `${text}${decoder.decode()}`.slice(0, maxLength)
  }

  return text
}

async function assertStreamResponseOk(providerId: ProviderId, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await streamBodyText(chunks)
  throw providerStatusError(providerId, response, bodyText)
}

async function streamTokens(input: ProviderStreamChatInput, result: NativeHttpStreamResult): Promise<void> {
  await assertStreamResponseOk(input.providerId, result.response, result.chunks)

  const data = decodeSseData(result.chunks)
  const tokens = providerStreamProtocol(input.providerId) === 'anthropic'
    ? extractAnthropicSseTokens(data)
    : extractOpenAiSseTokens(data)

  for await (const token of tokens) {
    await input.onToken(token)
  }
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
      assertNativeResponseOk(response, providerId, responseText)
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

    await streamTokens(input, result)
    return { requestId: result.requestId }
  },
})
