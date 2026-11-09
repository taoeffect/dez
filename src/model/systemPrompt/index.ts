import type { ModelRef } from '../chat/types'
import type { ToolDefinition, ToolParameter } from '../tools/types'
import { renderTemplate } from './template'
import SYSTEM_PROMPT_TEMPLATE from './systemPrompt.md?raw'

function parameterItem(parameter: ToolParameter): string {
  const use = parameter.required ? 'required' : 'optional'
  return `  - \`${parameter.name}\` (${parameter.type}, ${use}): ${parameter.description}`
}

// One markdown list item per tool, with a nested item per parameter.
function toolItem(tool: ToolDefinition): string {
  if (tool.parameters.length === 0) return `- \`${tool.name}\`: ${tool.description} No parameters.`
  return [`- \`${tool.name}\`: ${tool.description} Parameters:`, ...tool.parameters.map(parameterItem)].join('\n')
}

/** Dez's system prompt for a request to `model` that offers `tools`, the
 *  Dez tools that the request sends. The model goes in by its id, as Dez
 *  lists it. The provider goes in by `providerName`, its display name, and
 *  by its id: a provider added in Settings has a random UUID id, which the
 *  model could not name to the user.
 *
 *  The prompt holds no date, count, or other changing value, and the file's
 *  last newline is dropped: the same model, provider name, and tools always
 *  give the same bytes, so the prompt stays in the provider's cached prefix.
 *  A provider rename changes the bytes once. */
export function buildSystemPrompt(model: ModelRef, providerName: string, tools: readonly ToolDefinition[]): string {
  return renderTemplate(SYSTEM_PROMPT_TEMPLATE.trimEnd(), {
    model_id: model.modelId,
    provider_id: model.providerId,
    provider_name: providerName,
    tools_list: tools.length > 0 ? tools.map(toolItem).join('\n') : 'None.',
  })
}
