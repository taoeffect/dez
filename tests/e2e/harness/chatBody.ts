import { buildSystemPrompt } from '../../../src/model/systemPrompt'
import { TOOL_DEFINITIONS, toolJsonSchema } from '../../../src/model/tools/registry'

// The parts of a chat request body that the app adds to its messages: Dez's
// system prompt and the Dez tools. The app offers the tools to every model
// that its model cache does not mark as unable to call them, so every mock
// model gets them. The specs build the expected prompt with the app's own
// builder, so a change of its wording breaks no spec; the unit tests pin
// the text (src/model/systemPrompt/index.test.ts) and the wire shapes
// (src/model/providers/provider.test.ts).

/** A provider id and the id of one of its models, as `MockProvider` has
 *  them. */
export interface ChatModel {
  id: string
  modelId: string
}

/** Dez's system prompt in a chat request to `model` that offers the Dez
 *  tools. */
export function systemPrompt (model: ChatModel): string {
  return buildSystemPrompt({ providerId: model.id, modelId: model.modelId }, TOOL_DEFINITIONS)
}

/** The first message of an OpenAI-format chat request to `model`. */
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

/** The body of an OpenAI-format chat request to `model` with no thinking
 *  fields: the system message, then `messages`. */
export function openAiChatBody (model: ChatModel, messages: unknown[]): Record<string, unknown> {
  return { model: model.modelId, stream: true, messages: [openAiSystemMessage(model), ...messages], tools: OPENAI_TOOLS }
}

/** The body of an Anthropic-format chat request to `model` with no
 *  thinking field and the default `max_tokens`. */
export function anthropicChatBody (model: ChatModel, messages: unknown[]): Record<string, unknown> {
  return { model: model.modelId, stream: true, max_tokens: 32000, system: systemPrompt(model), tools: ANTHROPIC_TOOLS, messages }
}

/** A user message that the Anthropic format marks as a cache breakpoint:
 *  the last two user messages of each request. */
export function anthropicMarkedUser (text: string): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
}
