import type { SseTokenEvent } from './types'

interface AnthropicDelta {
  type?: unknown
  text?: unknown
}

interface AnthropicChunk {
  type?: unknown
  delta?: AnthropicDelta
}

export function parseAnthropicSseData(data: string): SseTokenEvent[] {
  if (data.trim() === '[DONE]') return [{ kind: 'done' }]

  const chunk = JSON.parse(data) as AnthropicChunk

  if (chunk.type === 'message_stop') return [{ kind: 'done' }]

  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && typeof chunk.delta.text === 'string' && chunk.delta.text.length > 0) {
    return [{ kind: 'token', token: chunk.delta.text }]
  }

  return []
}
