import type { AnthropicThinkingBlock } from '../chat/types'
import type { SseStreamEnd, SseStreamParser, SseTokenEvent } from './types'

interface AnthropicContentBlock {
  type?: unknown
  thinking?: unknown
  signature?: unknown
  data?: unknown
}

interface AnthropicDelta {
  type?: unknown
  text?: unknown
  thinking?: unknown
  signature?: unknown
}

interface AnthropicChunk {
  type?: unknown
  index?: unknown
  content_block?: AnthropicContentBlock | null
  delta?: AnthropicDelta | null
}

interface StreamedBlock {
  block: AnthropicThinkingBlock
  // `content_block_stop` arrived for it.
  complete: boolean
}

// Messages API streams. With `thinking`, it also keeps the `thinking` and
// `redacted_thinking` blocks exactly as they stream, by their `index`, as
// the replay: the provider checks each block against its signature.
export class AnthropicStreamParser implements SseStreamParser {
  // Stream order, which is the order the blocks must go back in.
  private readonly blocks = new Map<number, StreamedBlock>()
  private thinkingShown = false

  constructor(private readonly thinking: boolean) {}

  parse(data: string): SseTokenEvent[] {
    if (data.trim() === '[DONE]') return [{ kind: 'done' }]

    const chunk = JSON.parse(data) as AnthropicChunk
    const delta = chunk.delta

    if (chunk.type === 'message_stop') return [{ kind: 'done' }]

    if (chunk.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return [{ kind: 'token', token: delta.text }]
    }

    if (!this.thinking || typeof chunk.index !== 'number') return []

    if (chunk.type === 'content_block_start') {
      const block = chunk.content_block
      if (block?.type === 'thinking') {
        this.blocks.set(chunk.index, {
          block: { type: 'thinking', thinking: '', signature: typeof block.signature === 'string' ? block.signature : '' },
          complete: false,
        })
        return this.addThinking(chunk.index, block.thinking)
      }
      if (block?.type === 'redacted_thinking') {
        this.blocks.set(chunk.index, {
          block: { type: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' },
          complete: false,
        })
      }
    } else if (chunk.type === 'content_block_delta') {
      if (delta?.type === 'thinking_delta') return this.addThinking(chunk.index, delta.thinking)

      const streamed = this.blocks.get(chunk.index)
      if (delta?.type === 'signature_delta' && streamed?.block.type === 'thinking' && typeof delta.signature === 'string') {
        streamed.block.signature = delta.signature
      }
    } else if (chunk.type === 'content_block_stop') {
      const streamed = this.blocks.get(chunk.index)
      if (streamed) streamed.complete = true
    }

    return []
  }

  // Every thinking block must be complete: a block cut off before its
  // signature would be refused. The signature itself may be empty, because
  // compatible servers (MiniMax) may send none and the blocks go back as
  // they came.
  finish(): SseStreamEnd {
    const streamed = [...this.blocks.values()]
    if (streamed.length === 0 || streamed.some((entry) => !entry.complete)) return { events: [] }
    return { events: [], replay: { kind: 'anthropicBlocks', blocks: streamed.map((entry) => entry.block) } }
  }

  // The shown text puts a blank line between the blocks of one reply (a
  // model can think again between tool calls). The block keeps only its own
  // text, which its signature covers.
  private addThinking(index: number, text: unknown): SseTokenEvent[] {
    const streamed = this.blocks.get(index)
    if (streamed?.block.type !== 'thinking' || typeof text !== 'string' || text === '') return []

    const separator = this.thinkingShown && streamed.block.thinking === '' ? '\n\n' : ''
    streamed.block.thinking += text
    this.thinkingShown = true
    return [{ kind: 'thinking', token: separator + text }]
  }
}
