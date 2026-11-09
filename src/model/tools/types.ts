// The Dez tools: tools that the Dez app itself runs for a model, as opposed
// to tools that a provider runs on its side (such as Venice web search).

export type ToolParameterType = 'string' | 'number' | 'integer' | 'boolean'

/** One parameter of a tool. Parameters are flat scalars only, so each one
 *  fits in one attribute of a `<dez:tool>` block. */
export interface ToolParameter {
  name: string
  type: ToolParameterType
  description: string
  required: boolean
}

/** A tool as the model sees it: its name, what it does, and its parameters
 *  in a fixed order. The order is the order of the JSON schema keys and of
 *  the block attributes, so requests keep the same bytes. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: readonly ToolParameter[]
}

export type ToolArgumentValue = string | number | boolean

/** Checked arguments of a call, keyed by parameter name. An absent optional
 *  parameter has no key. */
export type ToolArguments = Record<string, ToolArgumentValue>
