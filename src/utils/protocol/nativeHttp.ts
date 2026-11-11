import { NativeHttpError } from './errors'

export type NativeHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type NativeHttpHeaders = Record<string, string>

export type NativeHttpBody = string | number[]

export interface NativeHttpRequest {
  method: NativeHttpMethod
  url: string
  headers?: NativeHttpHeaders
  body?: NativeHttpBody
  timeoutMs?: number
}

export interface NativeHttpResponseHead {
  status: number
  statusText?: string
  headers: NativeHttpHeaders
}

export interface NativeHttpResponse extends NativeHttpResponseHead {
  body: number[]
}

// What `dez.native/downloadAppFile` writes to its file (`DownloadRule` in
// src-tauri/src/http_bridge.rs).
export interface NativeDownloadRule {
  // The largest body that is saved, in bytes. A larger one is an error.
  maxBytes: number
  // When set, only a body whose content type starts with one of these (lower
  // case, such as `video/`) is saved.
  contentTypes?: string[]
}

// The result of `dez.native/downloadAppFile`. `saved` is true when the body
// is in the file. If not, `body` is the start of the body (at most 64 KiB):
// an error text or a JSON status.
export interface NativeHttpDownload extends NativeHttpResponseHead {
  saved: boolean
  body: number[]
}

export interface NativeHttpStreamHeadersEvent {
  kind: 'Headers'
  data: NativeHttpResponseHead
}

export interface NativeHttpStreamChunkEvent {
  kind: 'Chunk'
  data: {
    bytes: number[] | Uint8Array
  }
}

export interface NativeHttpStreamDoneEvent {
  kind: 'Done'
  data?: null
}

export interface NativeHttpStreamErrorEvent {
  kind: 'Error'
  data: {
    message: string
    status?: number
  }
}

export type NativeHttpStreamEvent =
  | NativeHttpStreamHeadersEvent
  | NativeHttpStreamChunkEvent
  | NativeHttpStreamDoneEvent
  | NativeHttpStreamErrorEvent

export interface NativeHttpStreamResult {
  requestId: string
  response: NativeHttpResponseHead
  chunks: AsyncIterable<Uint8Array>
}

export function bytesFromNativeBody(body: number[] | Uint8Array): Uint8Array {
  return body instanceof Uint8Array ? body : new Uint8Array(body)
}

export function textFromNativeBody(body: number[] | Uint8Array): string {
  return new TextDecoder().decode(bytesFromNativeBody(body))
}

export function nativeResponseText(response: NativeHttpResponse): string {
  return textFromNativeBody(response.body)
}

export function nativeResponseJson<T>(response: NativeHttpResponse): T {
  return JSON.parse(nativeResponseText(response)) as T
}

// The content type of a response in lower case, with its parameters; empty
// when the response names none. Response header names are lower case
// (reqwest), but a test server or a proxy may differ.
export function responseContentType(head: NativeHttpResponseHead): string {
  const entry = Object.entries(head.headers).find(([name]) => name.toLowerCase() === 'content-type')
  return entry?.[1].toLowerCase() ?? ''
}

export async function readNativeChunkText(chunks: AsyncIterable<Uint8Array>, maxLength = 1000): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''

  for await (const chunk of chunks) {
    const part = decoder.decode(chunk, { stream: true })
    if (text.length < maxLength) {
      text = `${text}${part}`.slice(0, maxLength)
    }
  }

  if (text.length < maxLength) {
    text = `${text}${decoder.decode()}`.slice(0, maxLength)
  }

  return text
}

/** The whole body of a response stream, in one array. */
export async function readNativeChunkBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks) {
    parts.push(chunk)
    length += chunk.length
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

export function createNativeHttpByteStream(): {
  stream: AsyncIterable<Uint8Array>
  pushEvent(event: NativeHttpStreamEvent): void
  close(): void
} {
  const chunks: Uint8Array[] = []
  const waiters: (() => void)[] = []
  let closed = false
  let error: NativeHttpError | null = null

  const wake = () => {
    const waiter = waiters.shift()
    if (waiter) waiter()
  }

  const wait = () => new Promise<void>((resolve) => waiters.push(resolve))

  async function* stream(): AsyncGenerator<Uint8Array> {
    while (true) {
      while (chunks.length > 0) {
        const chunk = chunks.shift()
        if (chunk) yield chunk
      }

      if (error) throw error
      if (closed) return
      await wait()
    }
  }

  return {
    stream: stream(),
    pushEvent(event) {
      if (closed || error) return

      if (event.kind === 'Chunk') {
        chunks.push(bytesFromNativeBody(event.data.bytes))
      } else if (event.kind === 'Done') {
        closed = true
      } else if (event.kind === 'Error') {
        error = new NativeHttpError(event.data.message, event.data.status)
      }

      wake()
    },
    close() {
      closed = true
      wake()
    },
  }
}
