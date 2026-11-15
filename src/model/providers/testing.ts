import type { ProviderInfo } from './types'

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
