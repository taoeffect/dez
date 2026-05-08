import type { Secret } from '../secret'
import type { ChatMessage } from './types'
import type { HttpFetchOptions } from '../protocol/http'

export interface AnthropicChatRequestBody {
  model: string
  messages: {
    role: 'user' | 'assistant'
    content: string
  }[]
  stream: boolean
}

export function anthropicModelListRequest(secret: Secret<string>): HttpFetchOptions {
  return {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret.reveal()}`,
    },
  }
}

export function anthropicChatBody(messages: ChatMessage[], model: string): AnthropicChatRequestBody {
  return {
    model,
    messages: messages.map((message) => ({
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
    })),
    stream: true,
  }
}

export function anthropicChatRequest(
  secret: Secret<string>,
  messages: ChatMessage[],
  model: string,
): HttpFetchOptions {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret.reveal()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicChatBody(messages, model)),
  }
}
