import { responseOk } from '../../utils/protocol/errors'
import { readNativeChunkText, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { decodeSseData } from '../../utils/protocol/sse'
import { providerStatusError } from './errors'
import type { Provider, ProviderChatRequest } from './provider'
import type { ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import type { SseTokenEvent } from './types'

// A refused response's body is read to its end; its first 1000 characters
// go into the error.
export async function assertStreamResponseOk(provider: Provider, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await readNativeChunkText(chunks)
  throw providerStatusError(provider, response, bodyText)
}

// Sends the answer text to `onToken` and, when the request asked for
// thinking (`requestThinking`), the thinking to `onThinking`. Returns the
// replay of a complete thinking, for the next request, and the tool calls,
// with the Thinking toggle on or off.
//
// A provider that supports thinking always has its thinking split from the
// answer text, so with the Thinking toggle off its thinking is dropped, not
// shown as answer text.
export async function streamProviderTokens(
  provider: Provider,
  input: ProviderStreamChatInput,
  result: NativeHttpStreamResult,
  requestThinking: ProviderChatRequest['thinking'],
): Promise<Omit<ProviderStreamChatResult, 'requestId'>> {
  await assertStreamResponseOk(provider, result.response, result.chunks)

  const parser = provider.format.createStreamParser(provider.supportsThinking)
  // True at the end of the stream.
  const deliver = async (events: SseTokenEvent[]): Promise<boolean> => {
    for (const event of events) {
      if (event.kind === 'done') return true
      if (event.kind === 'token') {
        await input.onToken(event.token)
      } else if (requestThinking) {
        await input.onThinking(event.token)
      }
    }
    return false
  }

  for await (const data of decodeSseData(result.chunks)) {
    if (await deliver(parser.parse(data))) break
  }

  const end = parser.finish()
  await deliver(end.events)
  const toolCalls = end.toolCalls && { toolCalls: end.toolCalls }
  if (!requestThinking || !end.replay) return { ...toolCalls }
  const thinkingReplay = end.replay.kind === 'field' ? end.replay : { ...end.replay, prefixHash: requestThinking.prefixHash }
  return { thinkingReplay, ...toolCalls }
}
