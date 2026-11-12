import { responseOk } from '../../utils/protocol/errors'
import { readNativeChunkText, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { decodeSseData } from '../../utils/protocol/sse'
import { providerStatusError, providerStreamError } from './errors'
import type { Provider, ProviderChatRequest } from './provider'
import type { ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import type { GeneratedMedia, SseTokenEvent } from './types'

// A refused response's body is read to its end, and the error tells the
// provider's text in it (`providerStatusError`; `keyed` too).
export async function assertStreamResponseOk(provider: Provider, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>, keyed = true): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await readNativeChunkText(chunks)
  throw providerStatusError(provider, response, bodyText, keyed)
}

// Sends the answer text to `onToken`, each image to `onImage` (`readImage`
// gives the bytes of its URL), and, when the request asked for thinking
// (`requestThinking`), the thinking to `onThinking`. Returns the replay of a
// complete thinking, for the next request, and the tool calls, with the
// Thinking toggle on or off. An error event inside the stream throws, after
// the text before it went out.
//
// A provider that supports thinking always has its thinking split from the
// answer text, so with the Thinking toggle off its thinking is dropped, not
// shown as answer text.
export async function streamProviderTokens(
  provider: Provider,
  input: ProviderStreamChatInput,
  result: NativeHttpStreamResult,
  requestThinking: ProviderChatRequest['thinking'],
  readImage: (url: string) => Promise<GeneratedMedia>,
): Promise<Omit<ProviderStreamChatResult, 'requestId'>> {
  await assertStreamResponseOk(provider, result.response, result.chunks)

  const parser = provider.format.createStreamParser(provider.supportsThinking)
  // True at the end of the stream.
  const deliver = async (events: SseTokenEvent[]): Promise<boolean> => {
    for (const event of events) {
      if (event.kind === 'done') return true
      if (event.kind === 'error') throw providerStreamError(provider, event)
      if (event.kind === 'token') {
        await input.onToken(event.token)
      } else if (event.kind === 'image') {
        await input.onImage(await readImage(event.url))
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
