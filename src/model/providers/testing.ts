import type { ModelDisplayNames, ProviderInfo } from './types'

/** Unit tests only: the info of a custom OpenAI-format provider with no
 *  thinking, configured (with a key) unless `configured` is false. */
export function providerInfo(id: string, name: string, configured = true): ProviderInfo {
  return { id, name, builtIn: false, auth: 'apiKey', apiFormat: 'openai', baseUrl: 'http://localhost/v1', hasKey: configured, configured, supportsThinking: false }
}

/** Unit tests only: today in the local time zone, as an ISO date. A data
 *  file's check days are not after it. */
export function today(): string {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-')
}

/** Unit tests only: the names of the models (`dez.provider/modelDisplayNames`):
 *  the model names and the readable names by `modelRefKey`, and the
 *  provider names by provider id. */
export function displayNames(models: Record<string, string> = {}, providers: Record<string, string> = {}, readableNames: Record<string, string> = {}): ModelDisplayNames {
  return { models: new Map(Object.entries(models)), providers: new Map(Object.entries(providers)), readableNames: new Map(Object.entries(readableNames)) }
}

/** Unit tests only: the error that `call` throws; undefined when it throws
 *  none. The class of an error tells which text the user gets
 *  (`explainedProviderError`), so a test compares the whole error. */
export function thrownError(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  return undefined
}
