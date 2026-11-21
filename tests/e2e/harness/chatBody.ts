import { BUILT_IN_SYSTEM_PROMPT, buildSystemPrompt } from '../../../src/model/systemPrompt'
import { TOOL_DEFINITIONS, toolJsonSchema } from '../../../src/model/tools/registry'

// The parts of a chat request body that the app adds to its messages: Dez's
// system prompt and the Dez tools. The app offers the tools to every model
// that its model cache does not mark as unable to call them, so every mock
// model gets them. An incognito tab sends neither (`requestParts`,
// src/model/chat/incognito.ts). The specs build the expected prompt with
// the app's own builder, so a change of its wording breaks no spec; the
// unit tests pin the text (src/model/systemPrompt/index.test.ts) and the
// wire shapes (src/model/providers/provider.test.ts).

/** A provider id and name and the id of one of its models, as
 *  `MockProvider` has them. */
export interface ChatModel {
  id: string
  name: string
  modelId: string
}

/** Dez's system prompt in a chat request to `model` that offers the Dez
 *  tools, from `template` (the built-in one when absent); undefined for a
 *  blank template, which sends no system prompt. */
export function systemPrompt (model: ChatModel, template = BUILT_IN_SYSTEM_PROMPT): string | undefined {
  return buildSystemPrompt(template, { providerId: model.id, modelId: model.modelId }, model.name, TOOL_DEFINITIONS)
}

/** The first message of an OpenAI-format chat request to `model`, with
 *  Dez's built-in system prompt. */
export function openAiSystemMessage (model: ChatModel): Record<string, unknown> {
  return { role: 'system', content: systemPrompt(model) }
}

/** The `tools` field of an OpenAI-format chat request. */
export const OPENAI_TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: toolJsonSchema(tool) },
}))

/** The `tools` field of an Anthropic-format chat request. */
export const ANTHROPIC_TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: toolJsonSchema(tool),
}))

/** What a chat request adds to its messages. */
export interface ChatBodyOptions {
  /** The template of Dez's system prompt: the built-in one when absent; a
   *  blank one sends no system prompt. */
  template?: string
  /** The request of an incognito tab: no system prompt and no tools. */
  incognito?: boolean
}

/** The body of an OpenAI-format chat request to `model` with no thinking
 *  fields: the system message (see `ChatBodyOptions`), then `messages`. */
export function openAiChatBody (model: ChatModel, messages: unknown[], { template = BUILT_IN_SYSTEM_PROMPT, incognito = false }: ChatBodyOptions = {}): Record<string, unknown> {
  const system = incognito ? undefined : systemPrompt(model, template)
  const systemMessages = system === undefined ? [] : [{ role: 'system', content: system }]
  return { model: model.modelId, stream: true, messages: [...systemMessages, ...messages], ...(!incognito && { tools: OPENAI_TOOLS }) }
}

/** The body of an Anthropic-format chat request to `model` with no
 *  thinking field and the default `max_tokens`. */
export function anthropicChatBody (model: ChatModel, messages: unknown[], { template = BUILT_IN_SYSTEM_PROMPT, incognito = false }: ChatBodyOptions = {}): Record<string, unknown> {
  const system = incognito ? undefined : systemPrompt(model, template)
  return {
    model: model.modelId,
    stream: true,
    max_tokens: 32000,
    ...(system !== undefined && { system }),
    ...(!incognito && { tools: ANTHROPIC_TOOLS }),
    messages,
  }
}

/** A user message that the Anthropic format marks as a cache breakpoint:
 *  the last two user messages of each request. */
export function anthropicMarkedUser (text: string): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
}

/** The URL of each image part of the messages of the OpenAI-format chat
 *  request body `body` (its JSON text), in the order of the request. */
export function sentImageUrls (body: string): string[] {
  const { messages } = JSON.parse(body) as { messages: Array<{ content: unknown }> }
  return messages
    .flatMap(({ content }): Array<{ image_url?: { url: string } }> => (Array.isArray(content) ? content : []))
    .flatMap(({ image_url: image }) => (image ? [image.url] : []))
}
