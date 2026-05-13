import sbp from '@sbp/sbp'
import { Channel } from '@tauri-apps/api/core'
import {
  createNativeHttpByteStream,
  type NativeHttpRequest,
  type NativeHttpResponseHead,
  type NativeHttpStreamEvent,
  type NativeHttpStreamResult,
} from '../utils/protocol/nativeHttp'

interface ActiveNativeHttpStream {
  byteStream: ReturnType<typeof createNativeHttpByteStream>
  rejectHeaders(reason: unknown): void
}

const activeStreams = new Map<string, ActiveNativeHttpStream>()

export default sbp('sbp/selectors/register', {
  async 'dez.http/stream' (request: NativeHttpRequest, requestId = crypto.randomUUID()): Promise<NativeHttpStreamResult> {
    const channel = new Channel<NativeHttpStreamEvent>()
    const byteStream = createNativeHttpByteStream()
    let response: NativeHttpResponseHead | null = null
    let headersReceived: (value: NativeHttpResponseHead) => void
    let headersRejected!: (reason: unknown) => void
    const headersPromise = new Promise<NativeHttpResponseHead>((resolve, reject) => {
      headersReceived = resolve
      headersRejected = reject
    })
    activeStreams.set(requestId, {
      byteStream,
      rejectHeaders: headersRejected,
    })

    channel.onmessage = (event) => {
      if (event.kind === 'Headers') {
        response = event.data
        headersReceived(response)
        return
      }

      if (event.kind === 'Error' && !response) {
        headersRejected(new Error(event.data.message))
      }

      byteStream.pushEvent(event)

      if (event.kind === 'Done' || event.kind === 'Error') {
        activeStreams.delete(requestId)
      }
    }

    try {
      await sbp('dez.native/streamHttp', request, requestId, channel)
      response = await headersPromise
      return {
        requestId,
        response,
        chunks: byteStream.stream,
      }
    } catch (error) {
      byteStream.close()
      activeStreams.delete(requestId)
      throw error
    }
  },

  async 'dez.http/cancelStream' (requestId: string): Promise<void> {
    const activeStream = activeStreams.get(requestId)
    activeStream?.byteStream.close()
    activeStream?.rejectHeaders(new Error('HTTP stream cancelled'))
    activeStreams.delete(requestId)
    await sbp('dez.native/cancelHttpStream', requestId)
  },
})
