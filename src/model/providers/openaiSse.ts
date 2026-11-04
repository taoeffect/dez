import type { SseTokenEvent } from './types'

interface OpenAiChoiceDelta {
  content?: unknown
}

interface OpenAiChoice {
  delta?: OpenAiChoiceDelta
}

interface OpenAiChunk {
  choices?: OpenAiChoice[]
}

export function parseOpenAiSseData(data: string): SseTokenEvent[] {
  if (data.trim() === '[DONE]') return [{ kind: 'done' }]

  const chunk = JSON.parse(data) as OpenAiChunk
  const events: SseTokenEvent[] = []

  for (const choice of chunk.choices ?? []) {
    const content = choice.delta?.content
    if (typeof content === 'string' && content.length > 0) {
      events.push({ kind: 'token', token: content })
    }
  }

  return events
}
