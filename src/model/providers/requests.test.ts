import { describe, expect, it } from 'vitest'
import { secret } from '../../utils/secret'
import { openRouterProvider } from './openrouter'
import { providerChatRequest } from './requests'
import type { ChatMessage } from './types'
import { veniceProvider } from './venice'

const messages: ChatMessage[] = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'agent', content: 'I can help with that.' },
]

function requestBody(request: ReturnType<typeof providerChatRequest>): Record<string, unknown> {
  expect(typeof request.body).toBe('string')
  return JSON.parse(request.body as string) as Record<string, unknown>
}

describe('provider chat requests', () => {
  it('adds default Venice chat parameters when no settings are stored', () => {
    const request = providerChatRequest(veniceProvider, 'venice', messages, 'venice-model', secret('test-token'))
    const body = requestBody(request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_x_search: true,
      enable_web_scraping: true,
    })
    expect(body.model).toBe('venice-model')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'user', content: 'Search the web for current info.' },
      { role: 'assistant', content: 'I can help with that.' },
    ])
  })

  it('applies stored provider setting overrides to Venice chat parameters', () => {
    const request = providerChatRequest(
      veniceProvider,
      'venice',
      messages,
      'venice-model',
      secret('test-token'),
      { webSearch: false, veniceSystemPrompt: true },
    )
    const body = requestBody(request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: true,
      enable_web_scraping: true,
    })
  })

  it('does not add Venice chat parameters to other OpenAI-compatible providers', () => {
    const request = providerChatRequest(
      openRouterProvider,
      'openrouter',
      messages,
      'openrouter-model',
      secret('test-token'),
      { webSearch: false },
    )
    const body = requestBody(request)

    expect(body.venice_parameters).toBeUndefined()
    expect(body.model).toBe('openrouter-model')
    expect(body.stream).toBe(true)
  })
})
