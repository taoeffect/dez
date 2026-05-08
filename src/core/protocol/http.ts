export type HttpTransportMode = 'auto' | 'webview' | 'plugin'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HttpFetchOptions extends RequestInit {
  providerId?: string
}

export interface HttpFetchPayload {
  input: URL | Request | string
  options?: HttpFetchOptions
}

export interface HttpFetchViaPayload extends HttpFetchPayload {
  mode: Exclude<HttpTransportMode, 'auto'>
}

export interface HttpModeState {
  mode: HttpTransportMode
  providerModes: Record<string, HttpTransportMode>
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerId?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function responseStatusError(response: Response, providerId?: string): HttpError {
  return new HttpError(
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    response.status,
    providerId,
  )
}

export async function readJsonResponse<T>(response: Response, providerId?: string): Promise<T> {
  if (!response.ok) {
    throw responseStatusError(response, providerId)
  }

  return await response.json() as T
}
