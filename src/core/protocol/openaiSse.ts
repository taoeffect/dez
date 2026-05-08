export type OpenAiSseTokenEvent =
  | { kind: 'token', token: string }
  | { kind: 'done' }

interface OpenAiChoiceDelta {
  content?: unknown
}

interface OpenAiChoice {
  delta?: OpenAiChoiceDelta
}

interface OpenAiChunk {
  choices?: OpenAiChoice[]
}

export function parseOpenAiSseData(data: string): OpenAiSseTokenEvent[] {
  if (data.trim() === '[DONE]') return [{ kind: 'done' }]

  const chunk = JSON.parse(data) as OpenAiChunk
  const events: OpenAiSseTokenEvent[] = []

  for (const choice of chunk.choices ?? []) {
    const content = choice.delta?.content
    if (typeof content === 'string' && content.length > 0) {
      events.push({ kind: 'token', token: content })
    }
  }

  return events
}

export async function* extractOpenAiSseTokens(data: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const item of data) {
    for (const event of parseOpenAiSseData(item)) {
      if (event.kind === 'done') return
      yield event.token
    }
  }
}
