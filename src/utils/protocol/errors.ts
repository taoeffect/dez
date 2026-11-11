import type { NativeHttpResponseHead } from './nativeHttp'

// A native HTTP request that got no whole answer: no connection, a timeout,
// or a body that broke off (the `Error` event of a native stream). The
// message is the native text. A provider turns it into a text for the user
// (`providerConnectionError`).
export class NativeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'NativeHttpError'
  }
}

export function responseOk(response: NativeHttpResponseHead): boolean {
  return response.status >= 200 && response.status < 300
}

export function sanitizeSensitiveErrorText(value: unknown, maxLength = 500, redactedValue = '[redacted]'): string {
  const text = value instanceof Error ? value.message : String(value)
  return text
    .replace(/Authorization\s*[:=]\s*Bearer\s+[^\s,'"}]+/gi, `Authorization: Bearer ${redactedValue}`)
    .replace(/Bearer\s+[^\s,'"}]+/gi, `Bearer ${redactedValue}`)
    .replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^&\s,'"}]+/gi, `$1${redactedValue}`)
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, redactedValue)
    .slice(0, maxLength)
}

export function sanitizeErrorText(value: unknown, maxLength = 500): string {
  return sanitizeSensitiveErrorText(value, maxLength, '[REDACTED]')
}
