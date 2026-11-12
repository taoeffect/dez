import type { AnthropicThinkingBlock } from '../chat/types'
import type { StreamedToolCall } from '../tools/types'
import { isRecord } from './modelParsing'
import type { SseErrorEvent, SseStreamEnd, SseStreamParser, SseTokenEvent, StreamedThinkingReplay } from './types'

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
  error?: unknown
}

// The HTTP status of each error type of the Messages API. An `error` event
// inside a stream has only the type, and the status tells whose fault the
// error is (`providerStreamError`). An unknown type gets no status. A Map,
// as the type is the server's text (a Record would find `constructor`).
// https://platform.claude.com/docs/en/api/errors
const ERROR_TYPE_STATUSES: ReadonlyMap<string, number> = new Map([
  ['invalid_request_error', 400],
  ['authentication_error', 401],
  ['billing_error', 402],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['request_too_large', 413],
  ['rate_limit_error', 429],
  ['api_error', 500],
  ['timeout_error', 504],
  ['overloaded_error', 529],
])

// `{ type: "error", error: { type, message } }`: the server stopped a stream
// that it started with a 200 status.
// https://platform.claude.com/docs/en/build-with-claude/streaming
function streamErrorEvent(error: unknown): SseErrorEvent {
  const fields: Record<string, unknown> = isRecord(error) ? error : {}
  const code = typeof fields.type === 'string' && fields.type !== '' ? fields.type : undefined
  const status = code === undefined ? undefined : ERROR_TYPE_STATUSES.get(code)
  return {
    kind: 'error',
    ...(status !== undefined && { status }),
    ...(code !== undefined && { code }),
    message: typeof fields.message === 'string' ? fields.message : '',
  }
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
  // `message_stop` (or `[DONE]`) arrived: the stream was not cut off.
  private stopped = false
  // An `error` event came out: the reader throws at it, and the replay and
  // tool calls of the stream may be cut off.
  private failed = false

  constructor(private readonly thinking: boolean) {}

  parse(data: string): SseTokenEvent[] {
    if (data.trim() === '[DONE]') {
      this.stopped = true
      return [{ kind: 'done' }]
    }

    const chunk = JSON.parse(data) as AnthropicChunk
    const delta = chunk.delta

    if (chunk.type === 'message_stop') {
      this.stopped = true
      return [{ kind: 'done' }]
    }
    if (chunk.type === 'error') {
      this.failed = true
      return [streamErrorEvent(chunk.error)]
    }

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
  // they came. A stream that was cut off or failed gives no tool calls, as
  // their input may be cut off; every tool_use block must be complete too.
  // A failed stream gives no replay either.
  finish(): SseStreamEnd {
    if (this.failed) return { events: [] }
    const blocks = completeBlocks(this.thinkingBlocks)
    const replay: StreamedThinkingReplay | undefined = blocks && { kind: 'anthropicBlocks', blocks }
    const toolCalls = this.stopped ? completeBlocks(this.toolUses) : undefined
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
