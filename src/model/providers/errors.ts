import type { NativeHttpResponse, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import type { Provider } from './provider'
import type { ProviderId } from './types'

// The message names the provider, because custom provider ids are UUIDs that
// the user never sees; the id stays in `providerId`.
export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: ProviderId,
    providerName: string,
    readonly status: number,
    readonly bodyPreview: string,
  ) {
    super(`${providerName} returned HTTP ${status}${bodyPreview ? `: ${bodyPreview}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

type ProviderIdentity = Pick<Provider, 'id' | 'name'>

export function providerStatusError(provider: ProviderIdentity, response: NativeHttpResponseHead, bodyText = ''): ProviderHttpError {
  return new ProviderHttpError(provider.id, provider.name, response.status, sanitizeErrorText(bodyText, 1000))
}

export function assertProviderResponseOk(response: NativeHttpResponse, provider: ProviderIdentity, bodyText = ''): void {
  if (responseOk(response)) return
  throw providerStatusError(provider, response, bodyText)
}
