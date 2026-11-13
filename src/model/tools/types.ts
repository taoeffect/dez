import { ExplainedError } from '../../utils/errorText'
import type { JsonObject } from '../../utils/json'

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

/** For a key of a call that is none of a tool's parameters: the text that
 *  tells the model where the key belongs, from the call's arguments
 *  (`values`); null when the tool does not know the key. */
export type MisplacedParameterText = (key: string, values: Readonly<Record<string, unknown>>) => string | null

/** A tool as the model sees it: its name, what it does, and its parameters
 *  in a fixed order. The order is the order of the JSON schema keys and of
 *  the block attributes, so requests keep the same bytes. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: readonly ToolParameter[]
  /** Only a tool whose calls hold more parameters inside one of these
   *  (subcommands.ts). No part of a request. */
  misplacedParameter?: MisplacedParameterText
}

export type ToolArgumentValue = string | number | boolean

/** Checked arguments of a call, keyed by parameter name. An absent optional
 *  parameter has no key. */
export type ToolArguments = Record<string, ToolArgumentValue>

/** A call that a model made, as later requests send it back. */
export interface ToolCall {
  /** The provider's call id, byte for byte. */
  id: string
  name: string
  /** In definition order (`<dez:tool>` blocks keep it), so the request
   *  bytes do not change. */
  arguments: JsonObject
}

/** A call as a reply stream gave it, before any check. The controller turns
 *  it into a `<dez:tool>` block. */
export interface StreamedToolCall {
  /** The provider's call id; `''` when the server sent none. */
  id: string
  /** The tool name as the model wrote it; `''` when the server sent none. */
  name: string
  /** The arguments JSON text as it streamed; blank means `{}`
   *  (`parseToolArguments`). It can be invalid JSON, for example when the
   *  reply hit its token limit. */
  argumentsText: string
}

/** The result of one call, as requests send it. */
export interface ToolResult {
  /** The `ToolCall.id` of its call. */
  callId: string
  /** Never blank (`agentSectionMessages`): Anthropic refuses an error
   *  result with no content. */
  content: string
  isError: boolean
}

/** What running one call gave, before it goes into its block. */
export interface ToolRunResult {
  content: string
  isError: boolean
}

/** An error whose text Dez wrote for the model that made a call: what is
 *  wrong with the call and how to fix it, or a failure that is not the
 *  call's fault and what the model can do. `dez.controller/tools/run` gives
 *  its message as the error result; any other error of a tool is one that
 *  Dez did not expect. Its text must hold no local path: it goes to the
 *  chat provider. */
export class ToolError extends ExplainedError {
  constructor(explanation: string, details = '', options?: ErrorOptions) {
    super(explanation, details, options)
    this.name = 'ToolError'
  }
}
