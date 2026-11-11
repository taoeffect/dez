import { describe, expect, it } from 'vitest'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { providerStatusError } from './errors'
import { Provider } from './provider'

function builtInProvider(id: string): Provider {
  const config = BUILT_IN_PROVIDER_CONFIGS.find((candidate) => candidate.id === id)
  if (!config) throw new Error(`No built-in provider ${id}`)
  return new Provider(config, { builtIn: true })
}

const venice = builtInProvider('venice')
const copilot = builtInProvider('copilot')

const message = (status: number, body: string, provider = venice, keyed = true) =>
  providerStatusError(provider, { status, headers: {} }, body, keyed).message

describe('provider status errors', () => {
  it.each([
    ['an OpenAI-format error object', '{"error":{"message":"Model not found","code":404}}', 'Venice returned HTTP 404: Model not found'],
    ['a string error', '{"error":"Unknown model"}', 'Venice returned HTTP 404: Unknown model'],
    ['a message field', '{"message":"No such route"}', 'Venice returned HTTP 404: No such route'],
    ['JSON with no text', '{"code":404}', 'Venice returned HTTP 404: {"code":404}'],
    ['text that is not JSON', 'Not found\n', 'Venice returned HTTP 404: Not found'],
    ['no body', '', 'Venice returned HTTP 404'],
  ])('tells the provider\'s text of %s', (_name, body, text) => {
    expect(message(404, body)).toBe(text)
  })

  it('adds the field texts of a refusal of the request\'s fields', () => {
    const body = JSON.stringify({
      details: { _errors: [], end_image_url: { _errors: ['This model does not support end_image_url'] }, duration: { _errors: ['Invalid option'] } },
      error: 'Invalid request parameters',
    })

    expect(message(400, body)).toBe('Venice returned HTTP 400: Invalid request parameters (end_image_url: This model does not support end_image_url; duration: Invalid option)')
  })

  it.each([
    [401, venice, true, 'Venice returned HTTP 401: Authentication failed. Check the API key of Venice in Settings › Providers.'],
    [401, copilot, true, 'GitHub Copilot returned HTTP 401: Authentication failed. Sign in to GitHub Copilot again in Settings › Providers.'],
    [402, venice, true, 'Venice returned HTTP 402: Authentication failed. Check the credit of your Venice account.'],
    [503, venice, true, 'Venice returned HTTP 503: Authentication failed. This is a problem at Venice: try again later.'],
    // A URL from a response gets no key, so its refusal tells nothing of it.
    [401, venice, false, 'Venice returned HTTP 401: Authentication failed'],
    [503, venice, false, 'Venice returned HTTP 503: Authentication failed. This is a problem at Venice: try again later.'],
    // The causes of these differ between providers.
    [403, venice, true, 'Venice returned HTTP 403: Authentication failed'],
    [429, venice, true, 'Venice returned HTTP 429: Authentication failed'],
  ])('tells what to do after HTTP %i when the cause is known (%#)', (status, provider, keyed, text) => {
    expect(message(status, '{"error":"Authentication failed"}', provider, keyed)).toBe(text)
  })

  it('adds no period to a text that ends with one, and tells what to do with no text', () => {
    expect([message(500, '{"error":"Server error."}'), message(500, '')]).toStrictEqual([
      'Venice returned HTTP 500: Server error. This is a problem at Venice: try again later.',
      'Venice returned HTTP 500. This is a problem at Venice: try again later.',
    ])
  })

  it('hides a key in the text and in the JSON, also one behind a JSON escape', () => {
    const error = providerStatusError(venice, { status: 400, headers: {} }, '{"error":"Bad header \\u0042earer sk-12345678901234567890"}')

    expect(error.message).toBe('Venice returned HTTP 400: Bad header Bearer [REDACTED]')
    expect(JSON.stringify(error.bodyJson)).not.toContain('sk-1234')
  })

  it('keeps the JSON of the body for a reader of a known cause, and none for text', () => {
    expect([
      providerStatusError(venice, { status: 400, headers: {} }, '{"error":"x","details":{"a":1}}').bodyJson,
      providerStatusError(venice, { status: 400, headers: {} }, 'x').bodyJson,
    ]).toStrictEqual([{ error: 'x', details: { a: 1 } }, undefined])
  })

  it('cuts a long text', () => {
    expect(message(400, 'x'.repeat(5000))).toBe(`Venice returned HTTP 400: ${'x'.repeat(1000)}`)
  })
})
