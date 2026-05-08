export type AnthropicSseTokenEvent =
  | { kind: 'token', token: string }
  | { kind: 'done' }

interface AnthropicDelta {
  type?: unknown
  text?: unknown
}

interface AnthropicChunk {
  type?: unknown
  delta?: AnthropicDelta
}

export function parseAnthropicSseData(data: string): AnthropicSseTokenEvent[] {
  if (data.trim() === '[DONE]') return [{ kind: 'done' }]

  const chunk = JSON.parse(data) as AnthropicChunk

  if (chunk.type === 'message_stop') return [{ kind: 'done' }]

  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && typeof chunk.delta.text === 'string' && chunk.delta.text.length > 0) {
    return [{ kind: 'token', token: chunk.delta.text }]
  }

  return []
}

export async function* extractAnthropicSseTokens(data: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const item of data) {
    for (const event of parseAnthropicSseData(item)) {
      if (event.kind === 'done') return
      yield event.token
    }
  }
}
