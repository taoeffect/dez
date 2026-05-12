import type { NativeHttpResponse, NativeHttpResponseHead } from './nativeHttp'

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

export function sanitizeErrorText(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/Bearer\s+[^\s,}]+/gi, 'Bearer [REDACTED]').slice(0, maxLength)
}

export function assertNativeResponseOk(response: NativeHttpResponse): void {
  if (responseOk(response)) return

  throw new NativeHttpError(`HTTP ${response.status}`, response.status)
}

export function normalizeNativeHttpError(error: unknown): NativeHttpError {
  if (error instanceof NativeHttpError) return error
  return new NativeHttpError(sanitizeErrorText(error))
}
