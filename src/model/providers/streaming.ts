import { responseOk } from '../../utils/protocol/errors'
import { readNativeChunkText, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { decodeSseData } from '../../utils/protocol/sse'
import { extractAnthropicSseTokens } from './anthropicSse'
import { providerStatusError } from './errors'
import { extractOpenAiSseTokens } from './openaiSse'
import { providerStreamProtocol } from './requests'
import type { ProviderId } from './types'
import type { ProviderStreamChatInput } from './streamTypes'

async function assertStreamResponseOk(providerId: ProviderId, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await readNativeChunkText(chunks)
  throw providerStatusError(providerId, response, bodyText)
}

export async function streamProviderTokens(input: ProviderStreamChatInput, result: NativeHttpStreamResult): Promise<void> {
  await assertStreamResponseOk(input.providerId, result.response, result.chunks)

  const data = decodeSseData(result.chunks)
  const tokens = providerStreamProtocol(input.providerId) === 'anthropic'
    ? extractAnthropicSseTokens(data)
    : extractOpenAiSseTokens(data)

  for await (const token of tokens) {
    await input.onToken(token)
  }
}
