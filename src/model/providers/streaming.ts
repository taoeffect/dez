import { responseOk } from '../../utils/protocol/errors'
import { decodeSseData } from '../../utils/protocol/sse'
import type { NativeHttpResponseHead, NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { extractAnthropicSseTokens } from './anthropicSse'
import { providerStatusError } from './errors'
import { extractOpenAiSseTokens } from './openaiSse'
import { providerStreamProtocol } from './requests'
import type { ProviderId } from './types'
import type { ProviderStreamChatInput } from './streamTypes'

async function streamBodyText(chunks: AsyncIterable<Uint8Array>, maxLength = 1000): Promise<string> {
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

async function assertStreamResponseOk(providerId: ProviderId, response: NativeHttpResponseHead, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  if (responseOk(response)) return

  const bodyText = await streamBodyText(chunks)
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
