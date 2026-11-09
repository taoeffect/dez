import type { AnthropicThinkingBlock } from '../chat/types'
import type { StreamedToolCall } from '../tools/types'
import type { SseStreamEnd, SseStreamParser, SseTokenEvent, StreamedThinkingReplay } from './types'

interface AnthropicContentBlock {
  type?: unknown
  thinking?: unknown
  signature?: unknown
  data?: unknown
  id?: unknown
  name?: unknown
}

interface AnthropicDelta {
  type?: unknown
  text?: unknown
  thinking?: unknown
  signature?: unknown
  partial_json?: unknown
}

interface AnthropicChunk {
  type?: unknown
  index?: unknown
  content_block?: AnthropicContentBlock | null
  delta?: AnthropicDelta | null
}

interface StreamedBlock<Block> {
  block: Block
  // `content_block_stop` arrived for it.
  complete: boolean
}

// The blocks in stream order, or none when there are none or when one never
// stopped: the stream was cut off inside it.
function completeBlocks<Block>(streamed: Map<number, StreamedBlock<Block>>): Block[] | undefined {
  const entries = [...streamed.values()]
  if (entries.length === 0 || entries.some((entry) => !entry.complete)) return undefined
  return entries.map((entry) => entry.block)
}

// Messages API streams. With `thinking`, it also keeps the `thinking` and
// `redacted_thinking` blocks exactly as they stream, by their `index`, as
// the replay: the provider checks each block against its signature. It
// always collects the `tool_use` blocks as tool calls.
export class AnthropicStreamParser implements SseStreamParser {
  // Stream order, which is the order the blocks must go back in.
  private readonly thinkingBlocks = new Map<number, StreamedBlock<AnthropicThinkingBlock>>()
  private readonly toolUses = new Map<number, StreamedBlock<StreamedToolCall>>()
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

    // The other events that matter are about the block at their `index`.
    // `message_delta` has none; the tool loop does not need its
    // `stop_reason`, as it runs the calls whatever the reason.
    if (typeof chunk.index !== 'number') return []
    if (this.readToolUse(chunk.index, chunk)) return []
    if (!this.thinking) return []

    if (chunk.type === 'content_block_start') {
      const block = chunk.content_block
      if (block?.type === 'thinking') {
        this.thinkingBlocks.set(chunk.index, {
          block: { type: 'thinking', thinking: '', signature: typeof block.signature === 'string' ? block.signature : '' },
          complete: false,
        })
        return this.addThinking(chunk.index, block.thinking)
      }
      if (block?.type === 'redacted_thinking') {
        this.thinkingBlocks.set(chunk.index, {
          block: { type: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' },
          complete: false,
        })
      }
    } else if (chunk.type === 'content_block_delta') {
      if (delta?.type === 'thinking_delta') return this.addThinking(chunk.index, delta.thinking)

      const streamed = this.thinkingBlocks.get(chunk.index)
      if (delta?.type === 'signature_delta' && streamed?.block.type === 'thinking' && typeof delta.signature === 'string') {
        streamed.block.signature = delta.signature
      }
    } else if (chunk.type === 'content_block_stop') {
      const streamed = this.thinkingBlocks.get(chunk.index)
      if (streamed) streamed.complete = true
    }

    return []
  }

  // Every thinking block must be complete: a block cut off before its
  // signature would be refused. The signature itself may be empty, because
  // compatible servers (MiniMax) may send none and the blocks go back as
  // they came. Every tool_use block must be complete too, or its input may
  // be cut off.
  finish(): SseStreamEnd {
    const blocks = completeBlocks(this.thinkingBlocks)
    const replay: StreamedThinkingReplay | undefined = blocks && { kind: 'anthropicBlocks', blocks }
    const toolCalls = completeBlocks(this.toolUses)
    return { events: [], ...(replay && { replay }), ...(toolCalls && { toolCalls }) }
  }

  // A `tool_use` block gives the call's id and name at its start, and its
  // input as JSON text in `input_json_delta` pieces. True when the event is
  // about a tool_use block.
  private readToolUse(index: number, chunk: AnthropicChunk): boolean {
    const block = chunk.content_block
    if (chunk.type === 'content_block_start' && block?.type === 'tool_use') {
      this.toolUses.set(index, {
        block: {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          argumentsText: '',
        },
        complete: false,
      })
      return true
    }

    const streamed = this.toolUses.get(index)
    if (!streamed) return false
    const delta = chunk.delta
    if (chunk.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      streamed.block.argumentsText += delta.partial_json
    } else if (chunk.type === 'content_block_stop') {
      streamed.complete = true
    }
    return true
  }

  // The shown text puts a blank line between the blocks of one reply (a
  // model can think again between tool calls). The block keeps only its own
  // text, which its signature covers.
  private addThinking(index: number, text: unknown): SseTokenEvent[] {
    const streamed = this.thinkingBlocks.get(index)
    if (streamed?.block.type !== 'thinking' || typeof text !== 'string' || text === '') return []

    const separator = this.thinkingShown && streamed.block.thinking === '' ? '\n\n' : ''
    streamed.block.thinking += text
    this.thinkingShown = true
    return [{ kind: 'thinking', token: separator + text }]
  }
}
