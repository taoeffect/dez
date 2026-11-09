import type { ProviderInfo } from './types'

/** Unit tests only: the info of a custom OpenAI-format provider with no
 *  thinking, configured (with a key) unless `configured` is false. */
export function providerInfo(id: string, name: string, configured = true): ProviderInfo {
  return { id, name, builtIn: false, auth: 'apiKey', apiFormat: 'openai', baseUrl: 'http://localhost/v1', hasKey: configured, configured, supportsThinking: false }
}
