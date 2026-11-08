import type { JsonObject } from '../../utils/json'

export type Role = 'user' | 'agent'

export interface TextNode {
  kind: 'text'
  text: string
}

export interface PromptNode {
  kind: 'prompt'
  /** Per-insertion id (ephemeral; not stable across reload unless persisted). */
  id: string
  /** Original prompt template id, or null if the saved template no longer exists. */
  promptId: string | null
  /** Display name on the pill; also used for matching on load. */
  name: string
  /** Per-insertion copy of the template body; editable when expanded. */
  body: string
  /** UI state; true when the body is rendered inline and editable. */
  expanded: boolean
}

export type ContentNode = TextNode | PromptNode

/** One part of a user message to a model: text, or a stored image by its
 *  absolute path (an image reference, `images.ts`). `dez.provider/streamChat`
 *  reads the bytes. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string }

/** A provider and a model, e.g. `openrouter` + `anthropic/claude-sonnet-4.5`. */
export interface ModelRef {
  providerId: string
  modelId: string
}

/** One Anthropic-format thinking block, kept exactly as it streamed: the
 *  signature checks the block text, so neither may change. */
export type AnthropicThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** What goes back to the provider with the next request so it can reuse
 *  its earlier reasoning. It is valid only for the section's `model`.
 *  - `field`: `SectionThinking.text` goes back in this assistant-message
 *    field, so the text must stay byte for byte as it streamed.
 *  - The other kinds carry signed or opaque parts that the provider checks.
 *    `prefixHash` is the hash of the request messages before this turn; the
 *    replay is sent only while that prefix is unchanged. */
export type ThinkingReplay =
  | { kind: 'field'; field: 'reasoning_content' | 'reasoning' }
  | { kind: 'anthropicBlocks'; blocks: AnthropicThinkingBlock[]; prefixHash: string }
  | { kind: 'reasoningDetails'; details: JsonObject[]; prefixHash: string }
  | { kind: 'copilot'; opaque: string; prefixHash: string }

/** The reasoning a model streamed before its answer. It is not in the
 *  section content or the CodeMirror doc: the editor shows it in the agent
 *  pill, and requests, previews, titles, search, find, Save As Markdown, and
 *  Copy Markdown never read it as message text. */
export interface SectionThinking {
  /** Every streamed thinking part, joined in stream order. */
  text: string
  /** Absent when the thinking cannot go back: it was cut off, pasted, or
   *  came from inline `<think>` tags. */
  replay?: ThinkingReplay
}

export interface Section {
  id: string
  role: Role
  content: ContentNode[]
  /** The model that wrote this agent section. Absent when unknown (user
   *  sections, hand-made sections, files saved before Dez stored it); never
   *  set to `undefined`. It stays when the role becomes `user`, but only
   *  `agent` sections show it or save it. */
  model?: ModelRef
  /** Absent when the model sent no thinking; never set to `undefined`. Like
   *  `model`, it stays when the role becomes `user`, but only `agent`
   *  sections show it, save it, or send it. */
  thinking?: SectionThinking
  /** How long the stream that wrote this agent section ran, in whole
   *  milliseconds, from the request start to the stream end. Absent when
   *  unknown (a reply still streaming, user sections, files saved before
   *  Dez stored it); never set to `undefined`. Like `model`, it stays when
   *  the role becomes `user`, but only `agent` sections show it, save it,
   *  or copy it. Never sent to a provider. */
  durationMs?: number
}

export interface ActiveModel extends ModelRef {
  modelName: string
}

export interface Tab {
  id: string
  title: string
  conversationId: string
  sections: Section[]
  activeModel: ActiveModel | null
  createdAt: number
}

export type StreamEvent =
  | { kind: 'Token'; data: { content: string } }
  | { kind: 'Done'; data: null }
  | { kind: 'Error'; data: { message: string } }
