import type { Secret } from '../../utils/secret'
import { nativeRequestFromFetch, type NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { anthropicChatRequest } from './anthropicCompatible'
import { copilotHeaders } from './copilot'
import { openAiChatRequest } from './openaiCompatible'
import type { ChatMessage, ProviderId, ProviderSpec } from './types'
import { buildVeniceParameters } from './venice'

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
  // Sparse user overrides for this provider's settings (see
  // ProviderSpec.settings); missing keys fall back to descriptor defaults.
  providerSettings?: Record<string, boolean>,
): NativeHttpRequest {
  const options = providerId === 'minimax'
    ? anthropicChatRequest(providerSecretValue, messages, modelId)
    : openAiChatRequest(
      providerSecretValue,
      messages,
      modelId,
      providerId === 'copilot' ? copilotHeaders : {},
      providerId === 'venice' ? { venice_parameters: buildVeniceParameters(providerSettings) } : {},
    )

  return nativeRequestFromFetch(spec.chatUrl, options)
}
