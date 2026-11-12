import { withoutStoredFilePaths } from '../chat/storedFilePaths'
import type { ModelRef } from '../chat/types'
import type { ToolDefinition, ToolParameter } from '../tools/types'
import { ExplainedError } from '../../utils/errorText'
import { renderTemplate, type RenderedTemplate } from './template'
import SYSTEM_PROMPT_TEMPLATE from './systemPrompt.md?raw'

/** Dez's own template, with no last newline: the text that Settings ›
 *  System Prompt shows while the user has no template of their own (the
 *  `systemPrompt` setting is null). */
export const BUILT_IN_SYSTEM_PROMPT = SYSTEM_PROMPT_TEMPLATE.trimEnd()

/** The facts of a request that the variables of a template stand for. */
interface PromptFacts {
  model: ModelRef
  providerName: string
  tools: readonly ToolDefinition[]
}

function parameterItem(parameter: ToolParameter): string {
  const use = parameter.required ? 'required' : 'optional'
  return `  - \`${parameter.name}\` (${parameter.type}, ${use}): ${parameter.description}`
}

// One markdown list item per tool, with a nested item per parameter.
function toolItem(tool: ToolDefinition): string {
  if (tool.parameters.length === 0) return `- \`${tool.name}\`: ${tool.description} No parameters.`
  return [`- \`${tool.name}\`: ${tool.description} Parameters:`, ...tool.parameters.map(parameterItem)].join('\n')
}

/** The variables of a template, each with what it means for the user
 *  (Settings › System Prompt lists them) and its value for a request.
 *
 *  The model goes in by its id, as Dez lists it. The provider goes in by
 *  its display name and by its id: a provider added in Settings has a
 *  random UUID id, which the model could not name to the user. The name
 *  schema trims only its ends, so a hand-edited `app_state.json` can hold a
 *  line break that would split the prompt's first line: each run of white
 *  space goes in as one space, as in `model_list` (`columnText`). */
export const SYSTEM_PROMPT_VARIABLES: readonly {
  name: string
  meaning: string
  value: (facts: PromptFacts) => string
}[] = [
  {
    name: 'model_id',
    meaning: 'The id of the model, as Dez lists it.',
    value: ({ model }) => model.modelId,
  },
  {
    name: 'provider_id',
    meaning: 'The id of the provider. A provider that you added has a random id.',
    value: ({ model }) => model.providerId,
  },
  {
    name: 'provider_name',
    meaning: 'The name of the provider, on one line.',
    value: ({ providerName }) => providerName.replace(/\s+/g, ' '),
  },
  {
    name: 'tools_list',
    meaning: 'The Dez tools that the request offers, as a markdown list with their parameters, or "None.".',
    value: ({ tools }) => (tools.length > 0 ? tools.map(toolItem).join('\n') : 'None.'),
  },
]

/** True for an empty template or one of only white space: then Dez sends
 *  no system prompt at all. */
export function systemPromptIsBlank(template: string): boolean {
  return template.trim() === ''
}

function render(template: string, facts: PromptFacts): RenderedTemplate {
  const values = Object.fromEntries(SYSTEM_PROMPT_VARIABLES.map((variable) => [variable.name, variable.value(facts)]))
  return renderTemplate(template.trimEnd(), values)
}

/** The first problem of a template (a name that is not a variable, a stray
 *  `{{` or `}}`), as a short text that starts with its line number; null
 *  when it has none. A blank template has none. */
export function systemPromptProblem(template: string): string | null {
  if (systemPromptIsBlank(template)) return null
  const rendered = render(template, { model: { providerId: '', modelId: '' }, providerName: '', tools: [] })
  return 'problem' in rendered ? rendered.problem : null
}

/** The text that refuses a request whose template has `problem` (the text
 *  of `systemPromptProblem`). */
export function systemPromptErrorText(problem: string): string {
  return `The system prompt in Settings › System Prompt has an error. ${problem} Fix it there, or click Restore Default there, and send again.`
}

/** The system prompt of a request to `model` that offers `tools`, the Dez
 *  tools that the request sends, from `template` (the user's template, else
 *  `BUILT_IN_SYSTEM_PROMPT`); undefined for a blank template, so that the
 *  request has no system prompt. `providerName` is the display name of the
 *  model's provider. Throws an `ExplainedError` for a template with a
 *  problem: `dez.controller/submitTab` refuses such a request first.
 *
 *  The prompt holds no date, count, or other changing value, and the
 *  template's last white space is dropped: the same template, model,
 *  provider name, and tools always give the same bytes, so the prompt stays
 *  in the provider's cached prefix. An edit of the template or a provider
 *  rename changes the bytes once: the next request misses the cache once,
 *  and the signed thinking replays of the earlier replies do not go back
 *  (the prefix hash of `wireChat`, apiFormats.ts). That is expected.
 *
 *  A template that the user wrote can hold the path of a stored file (a
 *  pasted image reference), so the text goes through
 *  `withoutStoredFilePaths`, as every request text does. */
export function buildSystemPrompt(template: string, model: ModelRef, providerName: string, tools: readonly ToolDefinition[]): string | undefined {
  if (systemPromptIsBlank(template)) return undefined
  const rendered = render(template, { model, providerName, tools })
  if ('problem' in rendered) {
    const error = new ExplainedError(systemPromptErrorText(rendered.problem))
    console.error(error)
    throw error
  }
  return withoutStoredFilePaths(rendered.text)
}
