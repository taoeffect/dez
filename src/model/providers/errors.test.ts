import { describe, expect, it } from 'vitest'
import { ExplainedError } from '../../utils/errorText'
import { NativeHttpError } from '../../utils/protocol/errors'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { ClipNotMadeError, explainedProviderError, providerConnectionError, providerStatusError, providerStreamError, UnusableAnswerError } from './errors'
import { Provider } from './provider'

function builtInProvider(id: string): Provider {
  const config = BUILT_IN_PROVIDER_CONFIGS.find((candidate) => candidate.id === id)
  if (!config) throw new Error(`No built-in provider ${id}`)
  return new Provider(config, { builtIn: true })
}

const venice = builtInProvider('venice')
const copilot = builtInProvider('copilot')
const custom = new Provider({ ...venice.config, id: 'my-server', name: 'My server' }, { builtIn: false })

const statusError = (status: number, body: string, provider = venice, keyed = true) =>
  providerStatusError(provider, { status, headers: {} }, body, keyed)

describe('provider status errors', () => {
  it.each([
    ['an OpenAI-format error object', '{"error":{"message":"Model not found","code":404}}', 'HTTP 404: Model not found'],
    ['a string error', '{"error":"Unknown model"}', 'HTTP 404: Unknown model'],
    ['a message field', '{"message":"No such route"}', 'HTTP 404: No such route'],
    ['JSON with no text', '{"code":404}', 'HTTP 404: {"code":404}'],
    ['text that is not JSON', 'Not found\n', 'HTTP 404: Not found'],
    ['no body', '', 'HTTP 404'],
  ])('puts the status and the provider\'s text of %s into the details', (_name, body, details) => {
    expect(statusError(404, body).details).toBe(details)
  })

  it('adds the field texts of a refusal of the request\'s fields', () => {
    const body = JSON.stringify({
      details: { _errors: [], end_image_url: { _errors: ['This model does not support end_image_url'] }, duration: { _errors: ['Invalid option'] } },
      error: 'Invalid request parameters',
    })

    expect(statusError(400, body).details).toBe('HTTP 400: Invalid request parameters (end_image_url: This model does not support end_image_url; duration: Invalid option)')
  })

  it('tells whose fault the status is and what to do first, and the details last', () => {
    expect(statusError(401, '{"error":"Authentication failed"}').message).toBe(
      'Venice did not accept the API key. Check the API key of Venice in Settings › Providers.\n\nDetails: HTTP 401: Authentication failed',
    )
  })

  it.each([
    [401, copilot, true, 'GitHub Copilot did not accept the sign-in. Sign in to GitHub Copilot again in Settings › Providers.'],
    [402, venice, true, 'Your Venice account does not have enough credit. Add credit at Venice, then try again.'],
    // The causes of these differ between providers, so the text names each.
    [403, venice, true, 'Venice refused access. Venice tells its reason in the details below. The cause can be your Venice account (it may not use this model) or the message (Venice can block a prompt). Check your account at Venice, change the message, or choose another model.'],
    [429, venice, true, 'Venice refused the request because of a limit: too many requests in a short time, or a limit of your Venice account. Venice tells its reason in the details below. Wait a minute, then try again. If the error stays, check your account at Venice.'],
    [404, venice, true, 'Venice has nothing for this request: the model can be gone, or it does not take this kind of request. Venice tells its reason in the details below. Choose another model.'],
    // A custom provider's base URL can be wrong.
    [404, custom, true, 'My server has nothing for this request: the model can be gone, or it does not take this kind of request. My server tells its reason in the details below. Choose another model, or check the base URL of My server in Settings › Providers.'],
    [413, venice, true, 'The request is too large for Venice. Venice tells its reason in the details below. Send fewer or smaller images or clips, or start a new conversation.'],
    [503, venice, true, 'This is a problem at Venice, not in your message or in Dez. Try again later.'],
    [501, venice, true, 'Venice had an error. Venice tells its reason in the details below. This is a problem at Venice, not in your message or in Dez. Try again later, or choose another model.'],
    [422, venice, true, 'Venice refused the request. Venice tells its reason in the details below. The cause can be the message, the settings of the model, or the request that Dez made. Change the message or the settings, or choose another model. If the error stays, report it at Help › Dez on GitHub.'],
    [302, venice, true, 'Venice gave an answer that Dez did not expect. Venice tells its reason in the details below. Try again. If the error stays, report it at Help › Dez on GitHub.'],
    // A URL from a response gets no key: its refusal tells that the signed
    // URL expired, not that the key or the account is wrong.
    [401, venice, false, 'The file that Venice made is not at its link any more: the link can have expired. Send the request again to make a new one.'],
    [410, venice, false, 'The file that Venice made is not at its link any more: the link can have expired. Send the request again to make a new one.'],
    [503, venice, false, 'This is a problem at Venice, not in your message or in Dez. Try again later.'],
  ])('explains HTTP %i (%#)', (status, provider, keyed, explanation) => {
    expect(statusError(status, '{"error":"Refused"}', provider, keyed).explanation).toBe(explanation)
  })

  // A model has no settings page, no account, and no report form: its text
  // tells whose fault the status is and what a new call can change.
  it.each([
    [401, venice, true, 'Venice did not accept the API key of the user. This is not a fault of the call: no call to a model of Venice works until the user fixes it in Settings › Providers.'],
    [401, copilot, true, 'GitHub Copilot did not accept the sign-in of the user. This is not a fault of the call: no call to a model of GitHub Copilot works until the user fixes it in Settings › Providers.'],
    [402, venice, true, 'The Venice account of the user does not have enough credit. This is not a fault of the call: no paid call to Venice works until the user adds credit at Venice.'],
    [403, venice, true, 'Venice refused access. Venice tells its reason in the details below. The cause can be the Venice account of the user (it may not use this model) or the prompt (Venice can block a prompt). Change the prompt, or use another model.'],
    [429, venice, true, 'Venice refused the request because of a limit: too many requests in a short time, or a limit of the Venice account of the user. Venice tells its reason in the details below. Do not call again at once: wait for the jobs that run, and start fewer jobs at the same time.'],
    // A model cannot change a base URL.
    [404, custom, true, 'My server has nothing for this request: the model can be gone, or it does not take this kind of request. My server tells its reason in the details below. Use another model.'],
    [413, venice, true, 'The request is too large for Venice. Venice tells its reason in the details below. Name fewer or smaller images or clips in `prompt`.'],
    [503, venice, true, 'This is a problem at Venice, not in the call. Call again once, or use another model.'],
    [501, venice, true, 'Venice had an error. Venice tells its reason in the details below. This is a problem at Venice, not in the call. Call again once, or use another model.'],
    [422, venice, true, 'Venice refused the request. Venice tells its reason in the details below. The cause can be `prompt`, the inputs, `parameters`, or the request that Dez made.'],
    [302, venice, true, 'Venice gave an answer that Dez did not expect. Venice tells its reason in the details below. Call again once.'],
    [410, venice, false, 'The file that Venice made is not at its link any more: the link can have expired. Call again to make a new one.'],
  ])('explains HTTP %i to a model that called (%#)', (status, provider, keyed, explanation) => {
    expect(statusError(status, '{"error":"Refused"}', provider, keyed).modelExplanation).toBe(explanation)
  })

  it('says that the provider tells its reason only when it sent a text', () => {
    expect(statusError(422, '').message).toBe('Venice refused the request. The cause can be the message, the settings of the model, or the request that Dez made. Change the message or the settings, or choose another model. If the error stays, report it at Help › Dez on GitHub.\n\nDetails: HTTP 422')
  })

  // A body with no known text field shows its JSON in the details.
  it.each([
    ['{"error":"Bad header \\u0042earer sk-12345678901234567890"}', 'HTTP 400: Bad header Bearer [REDACTED]'],
    ['{"detail":"Bad header \\u0042earer sk-12345678901234567890"}', 'HTTP 400: {"detail":"Bad header Bearer [REDACTED]"}'],
  ])('hides a key in the text and in the JSON, also one behind a JSON escape (%s)', (body, details) => {
    const error = statusError(400, body)

    expect(error.details).toBe(details)
    expect(JSON.stringify(error.bodyJson)).not.toContain('sk-1234')
  })

  it('keeps the JSON of the body for a reader of a known cause, and none for text', () => {
    expect([statusError(400, '{"error":"x","details":{"a":1}}').bodyJson, statusError(400, 'x').bodyJson]).toStrictEqual([{ error: 'x', details: { a: 1 } }, undefined])
  })

  it('cuts a long text', () => {
    expect(statusError(400, 'x'.repeat(5000)).details).toBe(`HTTP 400: ${'x'.repeat(1000)}`)
  })
})

describe('provider stream errors', () => {
  const openRouter = builtInProvider('openrouter')
  const minimax = builtInProvider('minimax')

  it.each([
    [529, minimax, 'MiniMax stopped the answer with an error. This is a problem at MiniMax, not in your message or in Dez. Try again later.'],
    [500, openRouter, 'OpenRouter stopped the answer with an error. This is a problem at OpenRouter, not in your message or in Dez. Try again later.'],
    [429, openRouter, 'OpenRouter stopped the answer with an error. OpenRouter refused the request because of a limit: too many requests in a short time, or a limit of your OpenRouter account. OpenRouter tells its reason in the details below. Wait a minute, then try again. If the error stays, check your account at OpenRouter.'],
    [403, openRouter, 'OpenRouter stopped the answer with an error. OpenRouter refused access. OpenRouter tells its reason in the details below. The cause can be your OpenRouter account (it may not use this model) or the message (OpenRouter can block a prompt). Check your account at OpenRouter, change the message, or choose another model.'],
    [400, openRouter, 'OpenRouter stopped the answer with an error. OpenRouter refused the request. OpenRouter tells its reason in the details below. The cause can be the message, the settings of the model, or the request that Dez made. Change the message or the settings, or choose another model. If the error stays, report it at Help › Dez on GitHub.'],
    [undefined, venice, 'Venice stopped the answer with an error. The cause can be a problem at Venice or the request. Venice tells its reason in the details below. Try again, or choose another model. If the error stays, report it at Help › Dez on GitHub.'],
  ])('explains an error event with status %s by the status', (status, provider, explanation) => {
    expect(providerStreamError(provider, { kind: 'error', ...(status !== undefined && { status }), code: 'x', message: 'Failed' }).explanation).toBe(explanation)
  })

  it('puts the code and the text into the details, with no HTTP word, and leaves out what is empty', () => {
    const details = (code: string | undefined, message: string) =>
      providerStreamError(minimax, { kind: 'error', status: 529, ...(code !== undefined && { code }), message }).details

    expect([details('overloaded_error', ' Overloaded '), details(undefined, 'Overloaded'), details('overloaded_error', '')])
      .toStrictEqual(['overloaded_error: Overloaded', 'Overloaded', 'overloaded_error'])
  })

  it('says that the provider tells its reason only when it sent a text', () => {
    expect(providerStreamError(venice, { kind: 'error', message: '' }).message).toBe(
      'Venice stopped the answer with an error. The cause can be a problem at Venice or the request. Try again, or choose another model. If the error stays, report it at Help › Dez on GitHub.',
    )
  })

  it('hides a key and cuts a long text', () => {
    expect([
      providerStreamError(venice, { kind: 'error', message: 'Bad header Bearer sk-12345678901234567890' }).details,
      providerStreamError(venice, { kind: 'error', code: 'x', message: 'y'.repeat(5000) }).details,
    ]).toStrictEqual(['Bad header Bearer [REDACTED]', `x: ${'y'.repeat(997)}`])
  })

  it('explains an error event to a model that called', () => {
    expect([
      providerStreamError(venice, { kind: 'error', status: 503, message: 'Failed' }).modelExplanation,
      providerStreamError(venice, { kind: 'error', message: 'Failed' }).modelExplanation,
    ]).toStrictEqual([
      'Venice stopped the answer with an error. This is a problem at Venice, not in the call. Call again once, or use another model.',
      'Venice stopped the answer with an error. The cause can be a problem at Venice or the request. Venice tells its reason in the details below. Call again once, or use another model.',
    ])
  })
})

describe('provider request errors', () => {
  it('explains a request with no whole answer, with the base URL advice only for a custom provider', () => {
    const native = new NativeHttpError('error sending request for url (http://127.0.0.1:9/v1/chat/completions?api_key=secret123&stream=true)')

    expect([providerConnectionError(venice, native).message, (explainedProviderError(custom, native) as Error).message]).toStrictEqual([
      'Dez could not reach Venice, or the connection broke before the answer was complete. Check the internet connection, then try again.\n\nDetails: error sending request for url (http://127.0.0.1:9/v1/chat/completions?api_key=[REDACTED]&stream=true)',
      'Dez could not reach My server, or the connection broke before the answer was complete. Check the internet connection, then try again. If the error stays, check the base URL of My server in Settings › Providers (for a server on this computer: check that it runs).\n\nDetails: error sending request for url (http://127.0.0.1:9/v1/chat/completions?api_key=[REDACTED]&stream=true)',
    ])
  })

  it('names the provider of an answer that Dez cannot use and of a clip that it did not make, and passes any other error', () => {
    const other = new TypeError('x is undefined')

    expect([
      (explainedProviderError(venice, new UnusableAnswerError('The answer holds no image.')) as Error).message,
      (explainedProviderError(venice, new ClipNotMadeError('State: failed: Content policy')) as Error).message,
    ]).toStrictEqual([
      'Venice sent an answer that Dez cannot use. Send the request again. If the error stays, report it at Help › Dez on GitHub.\n\nDetails: The answer holds no image.',
      'Venice did not make the clip. The cause can be the prompt (Venice can refuse a prompt) or a problem at Venice: the details below tell what Venice said. Change the prompt, or send the request again later.\n\nDetails: State: failed: Content policy',
    ])
    expect(explainedProviderError(venice, other)).toBe(other)
  })

  // The reader of a `model_invoke` request: a model reads the failure in
  // the result of its job.
  it('gives a model that called its own text of each failure, with the same details', () => {
    const native = new NativeHttpError('error sending request for url (http://127.0.0.1:9/v1/chat/completions?api_key=secret123&stream=true)')
    const forModel = (error: unknown) => explainedProviderError(custom, error, 'model')

    expect([
      forModel(native),
      forModel(new UnusableAnswerError('The answer holds no image.')),
      forModel(new ClipNotMadeError('State: failed: Content policy')),
      forModel(statusError(402, '{"error":"No credit"}', custom)),
      forModel(providerStreamError(custom, { kind: 'error', status: 503, message: 'Overloaded' })),
    ].map((error) => (error as Error).message)).toStrictEqual([
      'Dez could not reach My server, or the connection broke before the answer was complete. This is a problem of the network or of My server, not of the call. Call again once.\n\nDetails: error sending request for url (http://127.0.0.1:9/v1/chat/completions?api_key=[REDACTED]&stream=true)',
      'My server sent an answer that Dez cannot use. This is not a fault of the call. Call again once, or use another model.\n\nDetails: The answer holds no image.',
      'My server did not make the clip. The cause can be the prompt (My server can refuse a prompt) or a problem at My server: the details below tell what My server said. Change the prompt, or call again once.\n\nDetails: State: failed: Content policy',
      'The My server account of the user does not have enough credit. This is not a fault of the call: no paid call to My server works until the user adds credit at My server.\n\nDetails: HTTP 402: No credit',
      'My server stopped the answer with an error. This is a problem at My server, not in the call. Call again once, or use another model.\n\nDetails: Overloaded',
    ])
  })

  it('gives a model an error with no text for it as it is: a text that Dez wrote for the reader, and an error that Dez did not expect', () => {
    const written = new ExplainedError('The model takes no image.')
    const other = new TypeError('x is undefined')

    expect([explainedProviderError(venice, written, 'model'), explainedProviderError(venice, other, 'model')]).toStrictEqual([written, other])
    expect(explainedProviderError(venice, written, 'model')).toBe(written)
  })
})
