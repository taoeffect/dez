export interface SseEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

export async function* decodeSseData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  for await (const event of decodeSseEvents(chunks)) {
    if (event.data) yield event.data
  }
}

export async function* decodeSseEvents(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let eventId: string | undefined
  let retry: number | undefined
  let dataLines: string[] = []

  const emit = function* (): Generator<SseEvent> {
    if (dataLines.length === 0) {
      eventName = undefined
      retry = undefined
      return
    }

    const event: SseEvent = {
      data: dataLines.join('\n'),
    }
    if (eventName !== undefined) event.event = eventName
    if (eventId !== undefined) event.id = eventId
    if (retry !== undefined) event.retry = retry

    dataLines = []
    eventName = undefined
    retry = undefined
    yield event
  }

  const processLine = function* (rawLine: string): Generator<SseEvent> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line === '') {
      yield* emit()
      return
    }

    if (line.startsWith(':')) return

    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    const value = colonIndex === -1 ? '' : line.slice(colonIndex + (line[colonIndex + 1] === ' ' ? 2 : 1))

    if (field === 'data') {
      dataLines.push(value)
    } else if (field === 'event') {
      eventName = value
    } else if (field === 'id') {
      eventId = value
    } else if (field === 'retry') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed)) retry = parsed
    }
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })

    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      yield* processLine(line)
    }
  }

  buffer += decoder.decode()
  if (buffer) {
    yield* processLine(buffer)
  }
  yield* emit()
}
