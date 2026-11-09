import type { ThinkingReplay } from '../chat/types'
import { toolJsonSchema } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import type { JsonObject } from '../../utils/json'
import type { Secret } from '../../utils/secret'
import { AnthropicStreamParser } from './anthropicSse'
import { trimTrailingSlashes, type ApiFormatId, type ProviderConfig } from './config'
import { OpenAiStreamParser } from './openaiSse'
import { ThinkingPrefixHasher } from './thinking'
import type { ChatMessage, ChatPart, ChatRequestContext, SseStreamParser } from './types'

// Anthropic requires `max_tokens` on every /v1/messages request; current
// Claude 4.x models accept this value.
const DEFAULT_ANTHROPIC_MAX_TOKENS = 32000

// A chat request body, and the prefix hash (thinking.ts) of its system
// prompt, tools, and messages: a signed replay of the reply keeps it. The
// hasher that makes it also checks the replays of later requests, so the two
// always agree.
export interface ChatBody {
  body: Record<string, unknown>
  prefixHash: string
}

// Everything that differs between the wire formats a provider can speak.
export interface ApiFormat {
  chatUrl(baseUrl: string): string
  modelsUrl(baseUrl: string): string
  // Sent on every request, with or without a key.
  headers: Record<string, string>
  // Sent only when a key is stored.
  authHeaders(secret: Secret<string>): Record<string, string>
  chatBody(messages: ChatMessage[], modelId: string, config: ProviderConfig, context: ChatRequestContext): ChatBody
  // Merged into the chat body when the Thinking toggle is on and the config
  // sets no `thinking.enabledBody`.
  thinkingBody: JsonObject
  // `thinking`: the provider supports thinking, so the parser splits the
  // reasoning from the answer text. Without it, reasoning fields are ignored
  // and the answer text is passed on as it comes.
  createStreamParser(thinking: boolean): SseStreamParser
}

// A message as the provider gets it.
type WireMessage = Record<string, unknown>

// The wire message of an agent reply that sends its thinking back, or
// undefined when the format has no shape for the replay's kind: the replay
// came from the other format (a custom provider's format was changed).
type ReplayMessage = (content: string, text: string, replay: ThinkingReplay) => WireMessage | undefined

// The wire block of one image of a user message.
type ImageBlock = (image: Extract<ChatPart, { type: 'image' }>) => Record<string, unknown>

// The entry of one Dez tool in the request's `tools` array.
type WireTool = (tool: ToolDefinition) => Record<string, unknown>

// The shapes of the things that both formats send but write differently.
interface WireShapes {
  replayMessage: ReplayMessage
  imageBlock: ImageBlock
  tool: WireTool
}

// What both formats build the same way, before each one puts it in its own
// body: the wire messages, the wire tools (absent when the request offers
// none), and the prefix hash of the request.
interface WireChat {
  messages: WireMessage[]
  tools?: Record<string, unknown>[]
  prefixHash: string
}

// The parts and the blocks that each one becomes, the same at every build:
// the prefix hash of a signed replay covers the messages before it.
function wireContent(content: string | ChatPart[], imageBlock: ImageBlock): unknown {
  return typeof content === 'string'
    ? content
    : content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : imageBlock(part))
}

// Both formats send the same message list; only the replay shapes, the image
// blocks, the tool entries, and the extras differ. A message carries thinking
// only when the request asks for thinking (Provider.chatRequest).
//
// A signed replay (every kind except `field`) is sent only while the request
// before it hashes to its `prefixHash`, the hash of what the provider signed
// it with: the provider refuses it once anything before it changed. No other
// rule is needed. Anthropic's "drop no block in the middle" rule follows from
// this check, because a dropped block changes the prefix of every later
// block. And a plain agent message is the same bytes whether its replay was
// dropped as stale or it never had one (cancelled, Thinking off, another
// model), so a later replay that matches is still the one that the provider
// signed. A `field` replay is plain text that nothing checks, so an edit
// before it only costs cache hits.
//
// The provider reads the tools and the system prompt before the messages, so
// the prefix starts with them, in fixed places (null when absent): a signed
// replay goes back only with the same system prompt and tools.
function wireChat(messages: ChatMessage[], context: ChatRequestContext, shapes: WireShapes): WireChat {
  const tools = context.tools?.length ? context.tools.map(shapes.tool) : undefined
  const prefix = new ThinkingPrefixHasher()
  prefix.add(context.system ?? null)
  prefix.add(tools ?? null)

  const wireMessages = messages.map((message) => {
    const role = message.role === 'agent' ? 'assistant' : message.role
    const content = message.content
    let wireMessage: WireMessage = { role, content: wireContent(content, shapes.imageBlock) }
    const thinking = message.role === 'agent' ? message.thinking : undefined
    // An agent message is always a string (ChatMessage), so the string check
    // only narrows the type.
    const replayed = thinking?.replay && typeof content === 'string' && shapes.replayMessage(content, thinking.text, thinking.replay)

    if (thinking?.replay && replayed && (thinking.replay.kind === 'field' || prefix.digest() === thinking.replay.prefixHash)) {
      wireMessage = replayed
    }

    prefix.add(wireMessage)
    return wireMessage
  })

  return { messages: wireMessages, ...(tools && { tools }), prefixHash: prefix.digest() }
}

const openAiReplayMessage: ReplayMessage = (content, text, replay) => {
  switch (replay.kind) {
    case 'field':
      return { role: 'assistant', content, [replay.field]: text }
    case 'reasoningDetails':
      return { role: 'assistant', content, reasoning_details: replay.details }
    case 'copilot':
      return { role: 'assistant', content, reasoning_text: text, reasoning_opaque: replay.opaque }
    case 'anthropicBlocks':
      return undefined
  }
}

// The blocks go back unchanged and in stream order, before the answer text.
const anthropicReplayMessage: ReplayMessage = (content, _text, replay) => replay.kind === 'anthropicBlocks'
  ? { role: 'assistant', content: [...replay.blocks, { type: 'text', text: content }] }
  : undefined

// The image as a base64 data URL in an `image_url` part (checked live on
// Venice).
const openAiImageBlock: ImageBlock = (image) => ({
  type: 'image_url',
  image_url: { url: `data:${image.mediaType};base64,${image.data}` },
})

const anthropicImageBlock: ImageBlock = (image) => ({
  type: 'image',
  source: { type: 'base64', media_type: image.mediaType, data: image.data },
})

// Both entries take the same JSON schema (toolJsonSchema), with a fixed key
// order, so the tools array is the same bytes in every request.
const openAiTool: WireTool = (tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: toolJsonSchema(tool) },
})

const anthropicTool: WireTool = (tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: toolJsonSchema(tool),
})

const openAiShapes: WireShapes = { replayMessage: openAiReplayMessage, imageBlock: openAiImageBlock, tool: openAiTool }
const anthropicShapes: WireShapes = { replayMessage: anthropicReplayMessage, imageBlock: anthropicImageBlock, tool: anthropicTool }

// Anthropic caches a prompt prefix only up to a block marked with
// `cache_control` (a cache breakpoint). A mark on the last user message
// stores the whole conversation for the next request. A mark on the user
// message before it is where the previous request stored it, so this
// request reads that entry even when it adds more than the 20 blocks that a
// cache read looks back (each image is one block). The provider reads the
// tools and the system prompt before the messages, so the marks cover them
// too. The marks are added after the prefix hash: a user message loses its
// mark two turns later, and that must not drop a signed replay. Anthropic
// does not compare the marks when it matches a prefix, and a string content
// is the same prompt as one text block. `markedBlock` gives the index of the
// block to mark, or -1 when the message has none; such a message gets no
// mark.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
function withCacheBreakpoints(messages: WireMessage[], markedBlock: (blocks: WireMessage[]) => number): WireMessage[] {
  const marks = new Map<number, number>()
  for (let index = messages.length - 1; index >= 0 && marks.size < 2; index--) {
    const block = messages[index].role === 'user' ? markedBlock(contentBlocks(messages[index])) : -1
    if (block >= 0) marks.set(index, block)
  }
  return messages.map((message, index) => {
    const marked = marks.get(index)
    if (marked === undefined) return message
    const content = contentBlocks(message).map((block, blockIndex) =>
      blockIndex === marked ? { ...block, cache_control: { type: 'ephemeral' } } : block)
    return { ...message, content }
  })
}

function contentBlocks(message: WireMessage): WireMessage[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content as WireMessage[]
}

// OpenAI SDK style: the base URL already includes the version, e.g.
// http://localhost:11434/v1.
const openAiFormat: ApiFormat = {
  chatUrl: (baseUrl) => `${trimTrailingSlashes(baseUrl)}/chat/completions`,
  modelsUrl: (baseUrl) => `${trimTrailingSlashes(baseUrl)}/models`,
  headers: {},
  authHeaders: (secret) => ({ Authorization: `Bearer ${secret.reveal()}` }),
  // The system prompt is the first message. Tools go in `tools`, as
  // functions.
  chatBody: (messages, modelId, config, context) => {
    const chat = wireChat(messages, context, openAiShapes)
    // Venice drops a mark on an `image_url` part (checked live), so the
    // mark goes on the last text part.
    const conversation = config.cacheBreakpoints
      ? withCacheBreakpoints(chat.messages, (blocks) => blocks.findLastIndex((block) => block.type === 'text'))
      : chat.messages
    const body: Record<string, unknown> = {
      model: modelId,
      messages: context.system === undefined ? conversation : [{ role: 'system', content: context.system }, ...conversation],
      stream: true,
    }
    if (chat.tools) body.tools = chat.tools
    if (config.promptCacheKey && context.conversationId) body.prompt_cache_key = context.conversationId
    return { body, prefixHash: chat.prefixHash }
  },
  // A generic field such as `reasoning_effort` gives a 400 on Ollama, Groq
  // and GitHub Copilot models that do not think, and most OpenAI-compatible
  // models that do think, think without one.
  thinkingBody: {},
  createStreamParser: (thinking) => new OpenAiStreamParser(thinking),
}

// Anthropic SDK style base URLs have no version (https://api.anthropic.com),
// but users often paste one that ends in `/v1`; strip it so the versioned
// paths below are not doubled.
function anthropicApiRoot(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl).replace(/\/v1$/, '')
}

const anthropicFormat: ApiFormat = {
  chatUrl: (baseUrl) => `${anthropicApiRoot(baseUrl)}/v1/messages`,
  // The model list is paged, 20 models by default; 1000 is Anthropic's
  // largest page, so one request gets every model.
  modelsUrl: (baseUrl) => `${anthropicApiRoot(baseUrl)}/v1/models?limit=1000`,
  // Required by the Anthropic API on every request, the model list included.
  headers: { 'anthropic-version': '2023-06-01' },
  authHeaders: (secret) => ({ 'x-api-key': secret.reveal() }),
  // The system prompt is the top-level `system` field; Anthropic has no
  // system role.
  chatBody: (messages, modelId, config, context) => {
    const chat = wireChat(messages, context, anthropicShapes)
    const body: Record<string, unknown> = {
      model: modelId,
      ...(context.system !== undefined && { system: context.system }),
      messages: withCacheBreakpoints(chat.messages, (blocks) => blocks.length - 1),
      stream: true,
    }
    if (chat.tools) body.tools = chat.tools
    body.max_tokens = config.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS
    return { body, prefixHash: chat.prefixHash }
  },
  // Claude 4.7+ and 5.x send no thinking text without `display`, and
  // `adaptive` lets each model decide how much to think. Claude 4.5 models
  // refuse `adaptive`; a config can set its own `enabledBody` for them.
  thinkingBody: { thinking: { type: 'adaptive', display: 'summarized' } },
  createStreamParser: (thinking) => new AnthropicStreamParser(thinking),
}

export const API_FORMATS: Record<ApiFormatId, ApiFormat> = {
  openai: openAiFormat,
  anthropic: anthropicFormat,
}
