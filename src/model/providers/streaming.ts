import { responseOk } from '../../utils/protocol/errors'
import { readNativeChunkText, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { decodeSseData } from '../../utils/protocol/sse'
import { providerStatusError } from './errors'
import type { Provider } from './provider'
import type { ProviderStreamChatInput } from './streamTypes'

async function assertStreamResponseOk(provider: Provider, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await readNativeChunkText(chunks)
  throw providerStatusError(provider, response, bodyText)
}

export async function streamProviderTokens(provider: Provider, input: ProviderStreamChatInput, result: NativeHttpStreamResult): Promise<void> {
  await assertStreamResponseOk(provider, result.response, result.chunks)

  for await (const data of decodeSseData(result.chunks)) {
    for (const event of provider.format.parseSseData(data)) {
      if (event.kind === 'done') return
      await input.onToken(event.token)
    }
  }
}
