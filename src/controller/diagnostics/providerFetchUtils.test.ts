import { describe, expect, it } from 'vitest'
import { customProviderConfigSchema } from '../../model/providers/config'
import { Provider } from '../../model/providers/provider'
import { readFirstToken } from './providerFetchUtils'

const thinker = new Provider(customProviderConfigSchema.parse({
  id: 'local',
  name: 'Local',
  baseUrl: 'http://localhost:8080/v1',
  thinking: {},
}), { builtIn: false })

async function * sseChunks(...payloads: string[]): AsyncIterable<Uint8Array> {
  for (const payload of payloads) yield new TextEncoder().encode(`data: ${payload}\n\n`)
}

const content = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] })

describe('readFirstToken', () => {
  // The inline `<think>` splitter holds back text that could still start a
  // tag; it comes out only from `finish()`, after `[DONE]`.
  it('counts text held back for a possible inline tag when the stream ends with [DONE]', async () => {
    await expect(readFirstToken(thinker, sseChunks(content('<'), '[DONE]'))).resolves.toBe(true)
    await expect(readFirstToken(thinker, sseChunks(content(' '), '[DONE]'))).resolves.toBe(true)
  })

  it('gives false for a stream that ends with [DONE] and no text', async () => {
    await expect(readFirstToken(thinker, sseChunks('[DONE]'))).resolves.toBe(false)
  })

  it('throws the provider\'s error event that comes before the first token', async () => {
    const error = JSON.stringify({ error: { code: 429, message: 'Rate limited' }, choices: [{ delta: {}, finish_reason: 'error' }] })

    await expect(readFirstToken(thinker, sseChunks(error))).rejects.toThrow(
      'Local stopped the answer with an error. Local refused the request because of a limit',
    )
  })
})
