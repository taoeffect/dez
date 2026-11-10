import type { JsonObject } from '../../utils/json'
import type { StreamedToolCall } from '../tools/types'
import { FORBIDDEN_BODY_KEYS } from './config'
import { isRecord } from './modelParsing'
import type { SseStreamEnd, SseStreamParser, SseTokenEvent, StreamedThinkingReplay } from './types'

interface OpenAiChoiceDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  reasoning_text?: unknown
  reasoning_details?: unknown
  reasoning_opaque?: unknown
  tool_calls?: unknown
  // OpenRouter: the images that the model made, each
  // `{ type: "image_url", image_url: { url } }`. A whole image comes in
  // one chunk, as a `data:` URL (checked live, 2026-11-10); the docs also
  // allow a plain URL. The docs name only the `message.images` of an
  // answer that is not streamed.
  // https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
  images?: unknown
}

interface OpenAiChoice {
  delta?: OpenAiChoiceDelta | null
  finish_reason?: unknown
}

interface OpenAiChunk {
  choices?: OpenAiChoice[]
  // OpenRouter reports a failure inside a 200 stream with a top-level
  // `error` and `finish_reason: "error"`.
  error?: unknown
}

// Servers name the reasoning text field differently: `reasoning_content`
// (Z.ai, DeepSeek, Kimi, Qwen, Venice), `reasoning` (OpenRouter, Ollama,
// vLLM, Groq) and `reasoning_text` (GitHub Copilot). Some send the same text
// in two fields, or in `reasoning_details` too, so a chunk's text comes from
// the first field that has any.
const REASONING_TEXT_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const

type ReasoningTextField = (typeof REASONING_TEXT_FIELDS)[number]

// Servers that write the reasoning into the answer text wrap it in one of
// these at the very start: Groq's default `raw` format, llama.cpp
// `--reasoning-format none` and MiniMax's OpenAI endpoint use `<think>`,
// Gemini's OpenAI-compatible endpoint uses `<thought>`.
const INLINE_TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '<thought>', close: '</thought>' },
]

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// The length of the longest end of `text` that is the start of `tag`, but
// not the whole tag: that end may become the tag with the next chunk.
function partialTagLength(text: string, tag: string): number {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

// Moves the reasoning that a server writes into the answer text, inside an
// inline tag at the start, to thinking. A chunk can end inside a tag, so the
// text that may still be part of a tag is held back until the next chunk.
// Whitespace around the reasoning and after the close tag is dropped, as it
// only frames the tags.
class InlineThinkingSplitter {
  private state: 'start' | 'inside' | 'afterClose' | 'text' = 'start'
  private held = ''
  private closeTag = ''
  private thinkingStarted = false
  // Whether the answer text started with a tag. Thinking from inside it
  // cannot go back to the provider: the server takes it only as answer
  // text.
  startedWithTag = false

  push(content: string, events: SseTokenEvent[]): void {
    let rest = content

    while (rest !== '') {
      if (this.state === 'text') {
        events.push({ kind: 'token', token: rest })
        return
      }

      if (this.state === 'start') {
        this.held += rest
        rest = ''
        const trimmed = this.held.trimStart()
        if (trimmed === '') return

        const tag = INLINE_TAGS.find((candidate) => trimmed.startsWith(candidate.open))
        if (tag) {
          this.state = 'inside'
          this.startedWithTag = true
          this.closeTag = tag.close
          this.held = ''
          rest = trimmed.slice(tag.open.length)
        } else if (INLINE_TAGS.some((candidate) => candidate.open.startsWith(trimmed))) {
          return
        } else {
          this.state = 'text'
          rest = this.held
          this.held = ''
        }
      } else if (this.state === 'inside') {
        const text = this.held + rest
        rest = ''
        const end = text.indexOf(this.closeTag)
        if (end >= 0) {
          this.pushThinking(text.slice(0, end).trimEnd(), events)
          this.state = 'afterClose'
          this.held = ''
          rest = text.slice(end + this.closeTag.length)
        } else {
          const shown = text.slice(0, text.length - partialTagLength(text, this.closeTag)).trimEnd()
          this.pushThinking(shown, events)
          this.held = text.slice(shown.length)
        }
      } else {
        const trimmed = rest.trimStart()
        rest = ''
        if (trimmed !== '') {
          this.state = 'text'
          rest = trimmed
        }
      }
    }
  }

  // A reasoning field came before the answer text, so the answer text has
  // no inline tags to split.
  stopLooking(events: SseTokenEvent[]): void {
    if (this.state !== 'start') return
    if (this.held !== '') events.push({ kind: 'token', token: this.held })
    this.held = ''
    this.state = 'text'
  }

  // The stream ended: text held back at the start is answer text, and text
  // held back inside the tag is thinking.
  flush(events: SseTokenEvent[]): void {
    if (this.state === 'start' && this.held !== '') {
      events.push({ kind: 'token', token: this.held })
    } else if (this.state === 'inside') {
      this.pushThinking(this.held.trimEnd(), events)
    }
    this.held = ''
  }

  private pushThinking(text: string, events: SseTokenEvent[]): void {
    const shown = this.thinkingStarted ? text : text.trimStart()
    if (shown === '') return
    this.thinkingStarted = true
    events.push({ kind: 'thinking', token: shown })
  }
}

// The shown text of the `reasoning_details` entries of one chunk. Encrypted
// entries have none.
function reasoningDetailsText(details: Record<string, unknown>[]): string {
  return details
    .map((detail) => {
      if (detail.type === 'reasoning.text') return detail.text
      if (detail.type === 'reasoning.summary') return detail.summary
      return undefined
    })
    .filter(nonEmptyString)
    .join('')
}

// Chat Completions streams. With `thinking`, it also reads the reasoning:
// the text, the OpenRouter/Venice `reasoning_details` and the GitHub Copilot
// `reasoning_opaque`, which `finish()` turns into the replay. It always
// collects the tool calls, which `finish()` gives too.
export class OpenAiStreamParser implements SseStreamParser {
  private readonly inline: InlineThinkingSplitter | null
  // OpenRouter streams each detail in pieces with the same `index`; the
  // pieces are merged into one entry, in stream order.
  private readonly details: JsonObject[] = []
  private readonly detailsByIndex = new Map<number, JsonObject>()
  // In stream order, and by the `index` of their pieces.
  private readonly toolCalls: StreamedToolCall[] = []
  private readonly toolCallsByIndex = new Map<number, StreamedToolCall>()
  private opaque = ''
  private firstTextField: ReasoningTextField | null = null
  // `[DONE]` or a `finish_reason` arrived. Without `failed`, the reasoning
  // was not cut off.
  private complete = false
  // The server reported a failure inside the stream.
  private failed = false

  constructor(private readonly thinking: boolean) {
    this.inline = thinking ? new InlineThinkingSplitter() : null
  }

  parse(data: string): SseTokenEvent[] {
    if (data.trim() === '[DONE]') {
      this.complete = true
      return [{ kind: 'done' }]
    }

    const chunk = JSON.parse(data) as OpenAiChunk
    if (chunk.error !== undefined && chunk.error !== null) this.failed = true
    const events: SseTokenEvent[] = []

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      if (delta && this.thinking) this.readReasoning(delta, events)

      const content = delta?.content
      if (nonEmptyString(content)) {
        if (this.inline) {
          this.inline.push(content, events)
        } else {
          events.push({ kind: 'token', token: content })
        }
      }

      if (Array.isArray(delta?.images)) this.readImages(delta.images.filter(isRecord), events)

      if (Array.isArray(delta?.tool_calls)) this.readToolCalls(delta.tool_calls.filter(isRecord))

      if (choice.finish_reason === 'error') this.failed = true
      else if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.complete = true
    }

    return events
  }

  // The tool calls of a stream that was cut off or failed may have cut-off
  // arguments, so such a stream gives none.
  finish(): SseStreamEnd {
    const events: SseTokenEvent[] = []
    this.inline?.flush(events)
    const replay = this.replay()
    const toolCalls = this.complete && !this.failed && this.toolCalls.length > 0 ? this.toolCalls : undefined
    return { events, ...(replay && { replay }), ...(toolCalls && { toolCalls }) }
  }

  // The images of one chunk go after its text, so the text that the model
  // wrote before an image stays before it. Text held back as a possible
  // inline tag is answer text once an image comes.
  private readImages(images: Record<string, unknown>[], events: SseTokenEvent[]): void {
    for (const image of images) {
      const url = isRecord(image.image_url) ? image.image_url.url : undefined
      if (!nonEmptyString(url)) continue
      this.inline?.stopLooking(events)
      events.push({ kind: 'image', url })
    }
  }

  private readReasoning(delta: OpenAiChoiceDelta, events: SseTokenEvent[]): void {
    const field = REASONING_TEXT_FIELDS.find((name) => nonEmptyString(delta[name]))
    const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details.filter(isRecord) : []
    const text = field ? delta[field] as string : reasoningDetailsText(details)

    this.mergeDetails(details)
    if (nonEmptyString(delta.reasoning_opaque)) this.opaque = delta.reasoning_opaque
    if (text !== '' || details.length > 0 || nonEmptyString(delta.reasoning_opaque)) {
      this.inline?.stopLooking(events)
    }
    if (text === '') return

    if (field) this.firstTextField ??= field
    events.push({ kind: 'thinking', token: text })
  }

  // The first piece of a call has its `id` and `function.name`; later pieces
  // have its `index` and more of the arguments JSON text. Some servers give
  // every call index 0, so a new `id` at a known index starts a new call.
  // Some send no `index`, so a piece without one goes on with the last call.
  private readToolCalls(pieces: Record<string, unknown>[]): void {
    for (const piece of pieces) {
      const index = typeof piece.index === 'number' ? piece.index : undefined
      const id = nonEmptyString(piece.id) ? piece.id : ''
      const fn: Record<string, unknown> = isRecord(piece.function) ? piece.function : {}

      let call = index === undefined ? this.toolCalls.at(-1) : this.toolCallsByIndex.get(index)
      if (!call || (id !== '' && call.id !== '' && id !== call.id)) {
        call = { id: '', name: '', argumentsText: '' }
        this.toolCalls.push(call)
      }
      if (index !== undefined) this.toolCallsByIndex.set(index, call)

      if (id !== '') call.id = id
      // Some servers repeat the name in every piece, so it is set, not joined.
      if (nonEmptyString(fn.name)) call.name = fn.name
      if (typeof fn.arguments === 'string') call.argumentsText += fn.arguments
    }
  }

  // Pieces of one entry join their `text` and `summary`; any other field
  // (`signature`, `data`, `id`, `format`) takes the value that arrives.
  private mergeDetails(details: Record<string, unknown>[]): void {
    for (const detail of details) {
      const index = typeof detail.index === 'number' ? detail.index : undefined
      const existing = index === undefined ? undefined : this.detailsByIndex.get(index)
      const entry: JsonObject = existing ?? {}

      for (const [key, value] of Object.entries(detail)) {
        if (FORBIDDEN_BODY_KEYS.has(key) || value === null || value === undefined) continue
        const previous = entry[key]
        entry[key] = (key === 'text' || key === 'summary') && typeof previous === 'string' && typeof value === 'string'
          ? previous + value
          : value as JsonObject[string]
      }

      if (!existing) {
        this.details.push(entry)
        if (index !== undefined) this.detailsByIndex.set(index, entry)
      }
    }
  }

  // Inline-tag thinking and a stream that was cut off or failed give no
  // replay. The signed parts win over the plain text field, because a
  // provider that sends them checks them.
  private replay(): StreamedThinkingReplay | undefined {
    if (!this.complete || this.failed || this.inline?.startedWithTag) return undefined
    if (this.details.length > 0) return { kind: 'reasoningDetails', details: this.details }
    if (this.opaque !== '') return { kind: 'copilot', opaque: this.opaque }
    if (this.firstTextField === 'reasoning_content' || this.firstTextField === 'reasoning') {
      return { kind: 'field', field: this.firstTextField }
    }
    return undefined
  }
}
