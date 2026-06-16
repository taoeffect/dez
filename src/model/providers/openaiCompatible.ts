import type { Secret } from '../../utils/secret'
import type { ChatMessage, HttpFetchOptions } from './types'

export interface OpenAiChatRequestBody {
  model: string
  messages: {
    role: 'user' | 'assistant'
    content: string
  }[]
  stream: boolean
  [key: string]: unknown
}

export function bearerJsonRequest(secret: Secret<string>): HttpFetchOptions {
  return {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret.reveal()}`,
    },
  }
}

export function openAiChatBody(
  messages: ChatMessage[],
  model: string,
  extraBody: Record<string, unknown> = {},
): OpenAiChatRequestBody {
  return {
    ...extraBody,
    model,
    messages: messages.map((message) => ({
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
    })),
    stream: true,
  }
}

export function openAiChatRequest(
  secret: Secret<string>,
  messages: ChatMessage[],
  model: string,
  extraHeaders: Record<string, string> = {},
  extraBody: Record<string, unknown> = {},
): HttpFetchOptions {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret.reveal()}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(openAiChatBody(messages, model, extraBody)),
  }
}
