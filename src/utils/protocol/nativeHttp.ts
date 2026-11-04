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

export function createNativeHttpByteStream(): {
  stream: AsyncIterable<Uint8Array>
  pushEvent(event: NativeHttpStreamEvent): void
  close(): void
} {
  const chunks: Uint8Array[] = []
  const waiters: (() => void)[] = []
  let closed = false
  let error: Error | null = null

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
        error = new Error(event.data.message)
      }

      wake()
    },
    close() {
      closed = true
      wake()
    },
  }
}
