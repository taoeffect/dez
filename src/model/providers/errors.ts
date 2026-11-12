import { ExplainedError, rawErrorText, REPORT_ADVICE } from '../../utils/errorText'
import type { NativeHttpResponse, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { NativeHttpError, responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import { isRecord } from './modelParsing'
import type { Provider } from './provider'
import type { ProviderId, SseErrorEvent } from './types'

// The most characters of the provider's text in a message.
const PROVIDER_TEXT_LENGTH = 1000

// The statuses of a problem at the server that can end by itself (529:
// Anthropic's "overloaded"; 408: the server waited too long for the
// request). 501 and the others do not end by themselves.
const PASSING_SERVER_ERRORS: ReadonlySet<number> = new Set([408, 500, 502, 503, 504, 529])

// The statuses of a file URL from a response (a reply image, a clip) whose
// file is not there any more: such a URL is signed, and it expires.
const GONE_FILE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410])

/** Whether the server of a file URL from a provider's response (a reply
 *  image, a clip), asked with no key, refused it with a status that tells
 *  that the file is not there any more: the URL is signed, and it expired,
 *  or the provider deleted the file. */
export function signedUrlGone(status: number): boolean {
  return GONE_FILE_STATUSES.has(status)
}

// The explanation names the provider, because custom provider ids are UUIDs
// that the user never sees; the id stays in `providerId`. It tells whose
// fault the status is and what to do (`statusExplanation`); the details,
// last, hold the status and the provider's own text.
export class ProviderHttpError extends ExplainedError {
  constructor(
    readonly providerId: ProviderId,
    readonly status: number,
    // The provider's text (`providerText`), after sanitizeErrorText.
    providerText: string,
    // The JSON of the whole body, with each string after sanitizeErrorText,
    // for a media format that reads a known cause in it
    // (`ClipFormat.refusedImages`). Undefined for a body that is not JSON.
    readonly bodyJson: unknown,
    explanation: string,
  ) {
    super(explanation, `HTTP ${status}${providerText ? `: ${providerText}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

type ProviderIdentity = Pick<Provider, 'id' | 'name' | 'config' | 'builtIn'>

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// `value` with each of its strings sanitized. A pass over the body text
// misses a key behind a JSON escape (`\u0042earer`), and can break the
// JSON when it cuts a key that ends in an escape.
function sanitizedJson(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeErrorText(value, Infinity)
  if (Array.isArray(value)) return value.map(sanitizedJson)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizedJson(item)]))
  return value
}

// The texts of a zod error format (`{ _errors: [...], <field>: { _errors:
// [...] } }`), one level deep, each one after the name of its field.
function fieldErrorTexts(details: unknown): string[] {
  if (!isRecord(details)) return []
  return Object.entries(details).flatMap(([field, value]) => {
    const errors = field === '_errors' ? value : isRecord(value) ? value._errors : undefined
    const texts = Array.isArray(errors) ? errors.filter((text): text is string => typeof text === 'string' && text !== '') : []
    return field === '_errors' ? texts : texts.map((text) => `${field}: ${text}`)
  })
}

// The provider's own text in the JSON of an error body, so that the user
// reads it and not the JSON: `error.message` (the OpenAI and Anthropic
// formats, OpenRouter), a string `error` (Venice), or `message`. Venice adds
// the texts of each field (`details`, a zod error format) to a refusal of the
// request's fields, and they tell which field. Null for JSON with none.
// https://openrouter.ai/docs/api/reference/errors-and-debugging
// https://docs.venice.ai/api-reference/error-codes
function providerText(data: unknown): string | null {
  if (!isRecord(data)) return null
  const { error, message } = data
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') {
    const fields = fieldErrorTexts(data.details)
    return fields.length > 0 ? `${error} (${fields.join('; ')})` : error
  }
  if (typeof message === 'string' && message.trim() !== '') return message
  return null
}

// Whose fault a status is and what to do, from the meaning of the status in
// HTTP and the docs of the providers that Dez knows. Where the cause of a
// status differs between providers, the text names each cause: OpenRouter
// answers 403 for a blocked prompt too, and Z.ai answers 429 for an account
// with no credit. `keyed`: the request had the provider's key. A file at a
// URL from a response (a reply image, a clip) has none, so a 401 or 402
// there tells nothing of the key or the account; such a URL is signed, and
// a refusal of it tells that it has expired. `hasReason`: the details hold
// the provider's own text. No `status`: an error inside a stream whose kind
// the provider did not tell.
// https://openrouter.ai/docs/api/reference/errors-and-debugging
// https://docs.venice.ai/api-reference/error-codes
// https://docs.z.ai/api-reference/api-code
function statusExplanation(provider: ProviderIdentity, status: number | undefined, keyed: boolean, hasReason: boolean): string {
  const name = provider.name
  const reason = hasReason ? ` ${name} tells its reason in the details below.` : ''
  if (status === undefined) {
    return `The cause can be a problem at ${name} or the request.${reason} Try again, or choose another model. ${REPORT_ADVICE}`
  }
  if (!keyed && signedUrlGone(status)) {
    return `The file that ${name} made is not at its link any more: the link can have expired. Send the request again to make a new one.`
  }
  if (keyed && status === 401) {
    return provider.config.auth === 'githubCopilot'
      ? `${name} did not accept the sign-in. Sign in to ${name} again in Settings › Providers.`
      : `${name} did not accept the API key. Check the API key of ${name} in Settings › Providers.`
  }
  if (keyed && status === 402) return `Your ${name} account does not have enough credit. Add credit at ${name}, then try again.`
  if (keyed && status === 403) {
    return `${name} refused access.${reason} The cause can be your ${name} account (it may not use this model) or the message (${name} can block a prompt). Check your account at ${name}, change the message, or choose another model.`
  }
  if (keyed && status === 404) {
    const baseUrl = provider.builtIn ? '' : `, or check the base URL of ${name} in Settings › Providers`
    return `${name} has nothing for this request: the model can be gone, or it does not take this kind of request.${reason} Choose another model${baseUrl}.`
  }
  if (status === 413) return `The request is too large for ${name}.${reason} Send fewer or smaller images or clips, or start a new conversation.`
  if (status === 429) {
    return `${name} refused the request because of a limit: too many requests in a short time, or a limit of your ${name} account.${reason} Wait a minute, then try again. If the error stays, check your account at ${name}.`
  }
  if (PASSING_SERVER_ERRORS.has(status)) return `This is a problem at ${name}, not in your message or in Dez. Try again later.`
  if (status >= 500) return `${name} had an error.${reason} This is a problem at ${name}, not in your message or in Dez. Try again later, or choose another model.`
  if (status >= 400) {
    return `${name} refused the request.${reason} The cause can be the message, the settings of the model, or the request that Dez made. Change the message or the settings, or choose another model. ${REPORT_ADVICE}`
  }
  return `${name} gave an answer that Dez did not expect.${reason} Try again. ${REPORT_ADVICE}`
}

// The error of a provider's response with a status that is not 2xx, with
// `bodyText`, its body (or the start of it). The body is sanitized before
// anything keeps it. `keyed`: see `statusExplanation`.
export function providerStatusError(provider: ProviderIdentity, response: NativeHttpResponseHead, bodyText = '', keyed = true): ProviderHttpError {
  const bodyJson = sanitizedJson(parsedJson(bodyText))
  // JSON with no known text field shows as JSON, from the sanitized copy:
  // the raw text can hide a key behind an escape (see `sanitizedJson`).
  const fallback = bodyJson === undefined ? bodyText : JSON.stringify(bodyJson)
  // Sanitized again after the join: a field name and its text can make a
  // key pair (`token: …`).
  const text = sanitizeErrorText((providerText(bodyJson) ?? fallback).trim(), PROVIDER_TEXT_LENGTH)
  return new ProviderHttpError(provider.id, response.status, text, bodyJson, statusExplanation(provider, response.status, keyed, text !== ''))
}

export function assertProviderResponseOk(response: NativeHttpResponse, provider: ProviderIdentity, bodyText = ''): void {
  if (responseOk(response)) return
  throw providerStatusError(provider, response, bodyText)
}

// The error of an `error` event inside a stream: the provider started the
// answer with a 200 status, then stopped it. The status of the event tells
// whose fault it is, as for a refused response. The details hold the
// provider's code and text, with no "HTTP" word: the response itself had a
// good status. OpenRouter's `metadata.raw` (the upstream answer as it is)
// stays out: it is long, and the message tells the cause.
export function providerStreamError(provider: ProviderIdentity, failure: SseErrorEvent): ExplainedError {
  const raw = [failure.code, failure.message.trim()].filter((part) => part !== undefined && part !== '').join(': ')
  const details = sanitizeErrorText(raw, PROVIDER_TEXT_LENGTH)
  return new ExplainedError(
    `${provider.name} stopped the answer with an error. ${statusExplanation(provider, failure.status, true, details !== '')}`,
    details,
  )
}

// The error of a request to the provider that got no whole answer: no
// connection, a timeout, or a connection that broke in the body. The native
// text (`error`) goes into the details. A custom provider can have a wrong
// base URL, or a server on this computer that does not run.
export function providerConnectionError(provider: ProviderIdentity, error: unknown): ExplainedError {
  const custom = provider.builtIn ? '' : ` If the error stays, check the base URL of ${provider.name} in Settings › Providers (for a server on this computer: check that it runs).`
  return new ExplainedError(
    `Dez could not reach ${provider.name}, or the connection broke before the answer was complete. Check the internet connection, then try again.${custom}`,
    sanitizeErrorText(rawErrorText(error)),
    { cause: error },
  )
}

// An answer of a provider that Dez cannot use: no image or clip where one
// must be, or a form that Dez does not know. The wire formats
// (mediaFormats.ts, generatedImages.ts) know no provider name, so they
// throw this with what was wrong; `explainedProviderError` makes the text
// for the user. The cause can be a change at the provider that Dez does not
// know yet, so the text asks for a report.
export class UnusableAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableAnswerError'
  }
}

// A clip job that the provider ended with no clip (a failed, cancelled, or
// expired job). The message holds the provider's state and reason.
export class ClipNotMadeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipNotMadeError'
  }
}

// The error for the user of a failed provider request: an answer that
// Dez cannot use, a clip job that the provider ended, or no answer
// (`NativeHttpError`). Any other error as it is.
export function explainedProviderError(provider: ProviderIdentity, error: unknown): unknown {
  const name = provider.name
  if (error instanceof NativeHttpError) return providerConnectionError(provider, error)
  if (error instanceof UnusableAnswerError) {
    return new ExplainedError(`${name} sent an answer that Dez cannot use. Send the request again. ${REPORT_ADVICE}`, error.message, { cause: error })
  }
  if (error instanceof ClipNotMadeError) {
    return new ExplainedError(
      `${name} did not make the clip. The cause can be the prompt (${name} can refuse a prompt) or a problem at ${name}: the details below tell what ${name} said. Change the prompt, or send the request again later.`,
      error.message,
      { cause: error },
    )
  }
  return error
}
