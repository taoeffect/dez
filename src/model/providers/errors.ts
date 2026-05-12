import type { NativeHttpResponse, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import type { ProviderId } from './types'

export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly status: number,
    readonly bodyPreview: string,
  ) {
    super(`Provider ${providerId} returned HTTP ${status}${bodyPreview ? `: ${bodyPreview}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

export function providerStatusError(providerId: ProviderId, response: NativeHttpResponseHead, bodyText = ''): ProviderHttpError {
  return new ProviderHttpError(providerId, response.status, sanitizeErrorText(bodyText, 1000))
}

export function assertProviderResponseOk(response: NativeHttpResponse, providerId: ProviderId, bodyText = ''): void {
  if (responseOk(response)) return
  throw providerStatusError(providerId, response, bodyText)
}
