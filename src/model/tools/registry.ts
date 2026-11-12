import type { JsonObject } from '../../utils/json'
import { AUDIO_TOOL_DEFINITION } from './audioTool'
import { IMAGE_TOOL_DEFINITION } from './imageTool'
import { MODEL_INFO_TOOL } from './modelInfo'
import { MODEL_LIST_TOOL } from './modelList'
import type { ToolDefinition } from './types'

/** Every Dez tool, in the order that requests list them. A new tool goes
 *  at the end: the tools before it then keep their bytes in the tools
 *  array (the provider's prompt cache). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [MODEL_LIST_TOOL, MODEL_INFO_TOOL, AUDIO_TOOL_DEFINITION, IMAGE_TOOL_DEFINITION]

/** The Dez tool with this name; undefined when no Dez tool has it. */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

/** The error result of a call to a tool that Dez does not have. */
export function unknownToolText(name: string): string {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name).join(', ')
  return `Dez has no tool named ${JSON.stringify(name)}. Call only the Dez tools, by their exact names: ${names}.`
}

/** The JSON schema of a tool's arguments: the OpenAI-format `parameters` and
 *  the Anthropic-format `input_schema`. It comes from the static definition
 *  with a fixed key order, so the tools array is the same bytes in every
 *  request and stays in the provider's prompt cache.
 *
 *  `required` is left out when it would be empty (older JSON Schema drafts
 *  need at least one item). `additionalProperties: false` is left out too:
 *  some servers that translate schemas for other model families refuse it,
 *  and `parseToolArguments` (arguments.ts) refuses unknown keys anyway. */
export function toolJsonSchema(definition: ToolDefinition): JsonObject {
  const properties = Object.fromEntries(definition.parameters.map((parameter) => [
    parameter.name,
    { type: parameter.type, description: parameter.description },
  ]))
  const required = definition.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name)
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}
