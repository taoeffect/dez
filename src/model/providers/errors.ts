import type { NativeHttpResponse, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import { isRecord } from './modelParsing'
import type { Provider } from './provider'
import type { ProviderId } from './types'

// The most characters of the provider's text in a message.
const PROVIDER_TEXT_LENGTH = 1000

// The statuses of a problem at the server that can end by itself (529:
// Anthropic's "overloaded"). 501 and the others do not end by themselves.
const PASSING_SERVER_ERRORS: ReadonlySet<number> = new Set([500, 502, 503, 504, 529])

// The message names the provider, because custom provider ids are UUIDs that
// the user never sees; the id stays in `providerId`. Then it tells the
// provider's own text, and what to do when Dez knows the cause of the status
// (`statusAdvice`).
export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: ProviderId,
    providerName: string,
    readonly status: number,
    // The provider's text (`providerText`), after sanitizeErrorText.
    providerText: string,
    // The JSON of the whole body, with each string after sanitizeErrorText,
    // for a media format that reads a known cause in it
    // (`ClipFormat.refusedImages`). Undefined for a body that is not JSON.
    readonly bodyJson: unknown,
    advice: string,
  ) {
    const text = providerText && advice && !/[.!?]$/.test(providerText) ? `${providerText}.` : providerText
    super(`${providerName} returned HTTP ${status}${text ? `: ${text}` : advice ? '.' : ''}${advice ? ` ${advice}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

type ProviderIdentity = Pick<Provider, 'id' | 'name' | 'config'>

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

// What to do after a status whose cause is the same at every provider that
// Dez knows (the docs of OpenRouter, Venice, and Z.ai, and the meaning of the
// status in HTTP). 403 and 429 are left out: OpenRouter answers 403 for a
// blocked prompt too, and Z.ai answers 429 for an account with no credit.
// `keyed`: the request had the provider's key. A file at a URL from a
// response (a reply image, a clip) has none, so a 401 or 402 there tells
// nothing of the key or the account.
// https://openrouter.ai/docs/api/reference/errors-and-debugging
// https://docs.venice.ai/api-reference/error-codes
// https://docs.z.ai/api-reference/api-code
function statusAdvice(provider: ProviderIdentity, status: number, keyed: boolean): string {
  if (keyed && status === 401) {
    return provider.config.auth === 'githubCopilot'
      ? `Sign in to ${provider.name} again in Settings › Providers.`
      : `Check the API key of ${provider.name} in Settings › Providers.`
  }
  if (keyed && status === 402) return `Check the credit of your ${provider.name} account.`
  if (PASSING_SERVER_ERRORS.has(status)) return `This is a problem at ${provider.name}: try again later.`
  return ''
}

// The error of a provider's response with a status that is not 2xx, with
// `bodyText`, its body (or the start of it). The body is sanitized before
// anything keeps it. `keyed`: see `statusAdvice`.
export function providerStatusError(provider: ProviderIdentity, response: NativeHttpResponseHead, bodyText = '', keyed = true): ProviderHttpError {
  const bodyJson = sanitizedJson(parsedJson(bodyText))
  // Sanitized again after the join: a field name and its text can make a
  // key pair (`token: …`).
  const text = sanitizeErrorText((providerText(bodyJson) ?? bodyText).trim(), PROVIDER_TEXT_LENGTH)
  return new ProviderHttpError(provider.id, provider.name, response.status, text, bodyJson, statusAdvice(provider, response.status, keyed))
}

export function assertProviderResponseOk(response: NativeHttpResponse, provider: ProviderIdentity, bodyText = ''): void {
  if (responseOk(response)) return
  throw providerStatusError(provider, response, bodyText)
}
