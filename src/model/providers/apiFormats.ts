import type { Secret } from '../../utils/secret'
import { parseAnthropicSseData } from './anthropicSse'
import { trimTrailingSlashes, type ApiFormatId, type ProviderConfig } from './config'
import { parseOpenAiSseData } from './openaiSse'
import type { ChatMessage, SseTokenEvent } from './types'

// Anthropic requires `max_tokens` on every /v1/messages request; current
// Claude 4.x models accept this value.
const DEFAULT_ANTHROPIC_MAX_TOKENS = 32000

// Everything that differs between the wire formats a provider can speak.
export interface ApiFormat {
  chatUrl(baseUrl: string): string
  modelsUrl(baseUrl: string): string
  // Sent on every request, with or without a key.
  headers: Record<string, string>
  // Sent only when a key is stored.
  authHeaders(secret: Secret<string>): Record<string, string>
  chatBody(messages: ChatMessage[], modelId: string, config: ProviderConfig): Record<string, unknown>
  parseSseData(data: string): SseTokenEvent[]
}

// Both formats send the same message list; only the extras differ.
function chatMessagesBody(messages: ChatMessage[], model: string): Record<string, unknown> {
  return {
    model,
    messages: messages.map((message) => ({
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
    })),
    stream: true,
  }
}

// OpenAI SDK style: the base URL already includes the version, e.g.
// http://localhost:11434/v1.
const openAiFormat: ApiFormat = {
  chatUrl: (baseUrl) => `${trimTrailingSlashes(baseUrl)}/chat/completions`,
  modelsUrl: (baseUrl) => `${trimTrailingSlashes(baseUrl)}/models`,
  headers: {},
  authHeaders: (secret) => ({ Authorization: `Bearer ${secret.reveal()}` }),
  chatBody: (messages, modelId) => chatMessagesBody(messages, modelId),
  parseSseData: parseOpenAiSseData,
}

// Anthropic SDK style base URLs have no version (https://api.anthropic.com),
// but users often paste one that ends in `/v1`; strip it so the versioned
// paths below are not doubled.
function anthropicApiRoot(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl).replace(/\/v1$/, '')
}

const anthropicFormat: ApiFormat = {
  chatUrl: (baseUrl) => `${anthropicApiRoot(baseUrl)}/v1/messages`,
  // The model list is paged, 20 models by default; 1000 is Anthropic's
  // largest page, so one request gets every model.
  modelsUrl: (baseUrl) => `${anthropicApiRoot(baseUrl)}/v1/models?limit=1000`,
  // Required by the Anthropic API on every request, the model list included.
  headers: { 'anthropic-version': '2023-06-01' },
  authHeaders: (secret) => ({ 'x-api-key': secret.reveal() }),
  chatBody: (messages, modelId, config) => ({
    ...chatMessagesBody(messages, modelId),
    max_tokens: config.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
  }),
  parseSseData: parseAnthropicSseData,
}

export const API_FORMATS: Record<ApiFormatId, ApiFormat> = {
  openai: openAiFormat,
  anthropic: anthropicFormat,
}
