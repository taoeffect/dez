import { describe, expect, it } from 'vitest'
import { secret } from '../../utils/secret'
import { openRouterProvider } from './openrouter'
import { providerChatRequest } from './requests'
import type { ChatMessage } from './types'
import { VENICE_CHAT_PARAMETERS, veniceProvider } from './venice'

const messages: ChatMessage[] = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'agent', content: 'I can help with that.' },
]

function requestBody(request: ReturnType<typeof providerChatRequest>): Record<string, unknown> {
  expect(typeof request.body).toBe('string')
  return JSON.parse(request.body as string) as Record<string, unknown>
}

describe('provider chat requests', () => {
  it('adds Venice chat parameters only to Venice requests', () => {
    const request = providerChatRequest(veniceProvider, 'venice', messages, 'venice-model', secret('test-token'))
    const body = requestBody(request)

    expect(body.venice_parameters).toEqual(VENICE_CHAT_PARAMETERS)
    expect(body.model).toBe('venice-model')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'user', content: 'Search the web for current info.' },
      { role: 'assistant', content: 'I can help with that.' },
    ])
  })

  it('does not add Venice chat parameters to other OpenAI-compatible providers', () => {
    const request = providerChatRequest(openRouterProvider, 'openrouter', messages, 'openrouter-model', secret('test-token'))
    const body = requestBody(request)

    expect(body.venice_parameters).toBeUndefined()
    expect(body.model).toBe('openrouter-model')
    expect(body.stream).toBe(true)
  })
})
