import type { Secret } from '../../utils/secret'
import { nativeRequestFromFetch, type NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { anthropicChatRequest } from './anthropicCompatible'
import { copilotHeaders } from './copilot'
import { openAiChatRequest } from './openaiCompatible'
import type { ChatMessage, ProviderId, ProviderSpec } from './types'
import { VENICE_CHAT_PARAMETERS } from './venice'

export type ProviderStreamProtocol = 'openai' | 'anthropic'

export function providerStreamProtocol(providerId: ProviderId): ProviderStreamProtocol {
  return providerId === 'minimax' ? 'anthropic' : 'openai'
}

export function providerChatRequest(
  spec: ProviderSpec,
  providerId: ProviderId,
  messages: ChatMessage[],
  modelId: string,
  providerSecretValue: Secret<string>,
): NativeHttpRequest {
  const options = providerId === 'minimax'
    ? anthropicChatRequest(providerSecretValue, messages, modelId)
    : openAiChatRequest(
      providerSecretValue,
      messages,
      modelId,
      providerId === 'copilot' ? copilotHeaders : {},
      providerId === 'venice' ? { venice_parameters: VENICE_CHAT_PARAMETERS } : {},
    )

  return nativeRequestFromFetch(spec.chatUrl, options)
}
