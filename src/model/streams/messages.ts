import type { MessagePart, ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findImageReferences, holdsImagePath, splitImageReferences, withoutImagePaths } from '../chat/images'
import { sameModelRef } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, splitToolBlocks, unescapeModelText, type ToolBlock } from '../chat/toolBlocks'
import type { MediaKind } from '../providers/types'
import type { ToolCall, ToolResult } from '../tools/types'
import type { RequestMessages, StreamMessage } from './types'

export interface RequestOptions {
  // False when the request model does not read images: a user section's
  // image references then go as text only.
  sendImages: boolean
  // False when the request offers no tools: an agent section's tool calls
  // then go as text (agentSectionMessages).
  sendTools: boolean
}

// The request messages: every section that has text, in order. No image path
// ever goes to a provider: every text (user and agent text, prompt bodies,
// tool arguments and results) goes through `withoutImagePaths`, so a
// reference goes as `![image](id=a)`, with the ids and other metadata that
// later requests can name. Each message is built from its own section only,
// so an earlier message is the same bytes in every later request (prompt
// cache).
//
// The image references of a user section also go as image parts, unless
// `sendImages` is false. An agent section's images go as text only: both
// formats take images only from the user.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, options: RequestOptions): Omit<RequestMessages, 'sendTools'> {
  let imagesLeftOut = 0
  const messages = sections
    .filter((section) => !sectionIsEmpty(section))
    .flatMap((section): StreamMessage[] => {
      if (section.role === 'agent') return agentSectionMessages(section, requestModel, options.sendTools)
      const text = sectionPlainText(section)
      if (!options.sendImages) {
        imagesLeftOut += findImageReferences(text).length
        return [{ role: 'user', content: withoutImagePaths(text) }]
      }
      return [{ role: 'user', content: userMessageContent(text) }]
    })

  return { messages, imagesLeftOut }
}

/** What a media reply (ModelInfo.request `image` or `imageEdit`) sends to
 *  dez.provider/generateMedia. The prompt is the text of the last user
 *  message of `messages` as a chat request sends it: with no path, and with
 *  each image reference as its `![image](id=a)` text. An edit takes the
 *  images of that message; when it has none, it takes the newest image
 *  reference of `sections` (the tab's sections, in which the reply's own
 *  section is still empty), so that "Make it blue" edits the image of the
 *  reply before. An edit with no image gets no paths, and generateMedia
 *  refuses it. */
export function mediaRequestInput(kind: MediaKind, messages: StreamMessage[], sections: Section[]): { prompt: string, images: string[] } {
  const content = messages.findLast((message): message is Extract<StreamMessage, { role: 'user' }> => message.role === 'user')?.content ?? ''
  const parts: MessagePart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const prompt = parts.map((part) => (part.type === 'text' ? part.text : '')).join('').trim()
  if (kind === 'image') return { prompt, images: [] }

  const images = parts.flatMap((part) => (part.type === 'image' ? [part.path] : []))
  if (images.length > 0) return { prompt, images }
  const newest = sections.map((section) => findImageReferences(sectionPlainText(section)).at(-1)).findLast((reference) => reference !== undefined)
  return { prompt, images: newest ? [newest.path] : [] }
}

/** The request messages of one agent section. A reply that called tools
 *  made one request round per group of calls, and the section holds them
 *  all: each round's text, then its `<dez:tool>` blocks. Each round becomes
 *  an agent message with the round's text and calls, then a tool message
 *  with their results; the text after the last group becomes the last agent
 *  message, left out when it is blank. A section with no blocks gives one
 *  agent message, the same bytes as before tools existed (saved prefix
 *  hashes depend on it). The stream controller builds the rounds of a
 *  running reply with this too, so the loop and every later request send
 *  the same bytes.
 *
 *  With `sendTools` false, a section with blocks is one agent message, with
 *  each block as text, and sends no thinking: a request with no tool
 *  definitions cannot hold tool calls. */
export function agentSectionMessages(section: Section, requestModel: ModelRef, sendTools: boolean): StreamMessage[] {
  const text = sectionPlainText(section)
  const rounds = agentRounds(text)
  // The first group's blocks are always in the first round; a section that
  // ends at its first group has only that round.
  if (!sendTools && rounds[0].blocks.length > 0) return [{ role: 'agent', content: textWithToolCalls(text) }]

  return rounds.flatMap((round, index): StreamMessage[] => {
    const content = withoutImagePaths(unescapeModelText(round.text))
    const thinking = roundThinking(section, requestModel, rounds, index)
    if (round.blocks.length === 0) return content.trim() === '' ? [] : [{ role: 'agent', content, ...thinking }]
    return [
      { role: 'agent', content, ...thinking, toolCalls: round.blocks.map(toolCall) },
      { role: 'tool', results: round.blocks.map(toolResult) },
    ]
  })
}

// One request round of an agent section: the text that the round wrote, and
// the group of calls that ended it. The last round has no calls.
interface AgentRound {
  text: string
  blocks: ToolBlock[]
}

// The stream controller writes one `\n` before each group of calls (none
// when the section is empty) and one `\n` after each block. After a round
// that wrote no text, that gives a blank line before the next group. So
// blocks with exactly one `\n` between them are one group, and any other
// text between two blocks is the text of the round between them. The `\n`
// that joins a text to a block is not model text: one is dropped on each
// side that touches a block, and the model's own line breaks stay. A block
// starts at the text start or after a `\n`, and ends at the text end or
// before a `\n`, so the text next to a block always has that `\n`.
function agentRounds(text: string): AgentRound[] {
  const pieces = splitToolBlocks(text)
  const rounds: AgentRound[] = [{ text: '', blocks: [] }]
  // splitToolBlocks never gives two text pieces in a row.
  pieces.forEach((piece, index) => {
    if (piece.kind === 'tool') {
      rounds[rounds.length - 1].blocks.push(piece.block)
      return
    }
    const afterBlock = index > 0
    const beforeBlock = index < pieces.length - 1
    if (afterBlock && beforeBlock && piece.text === '\n') return
    let roundText = piece.text
    if (afterBlock) roundText = roundText.slice(1)
    if (beforeBlock) roundText = roundText.slice(0, -1)
    if (afterBlock) rounds.push({ text: roundText, blocks: [] })
    else rounds[0].text = roundText
  })
  return rounds
}

// The thinking of one round goes back only when `requestModel` wrote the
// section, the round has a replay, and neither holds an image path: a
// replay is valid only for the model that made it, a signed replay cannot be
// changed, and thinking with no replay (pasted, cut off, or split from
// inline tags) never goes back. A `field` replay sends the thinking text; the
// other kinds hold the thinking in their own JSON.
//
// The first round has the section's `replay` and the text up to the first
// `rounds` entry. A later round has the entry whose `afterToolCall` is the
// first call of the group before it, and the text up to the next entry. A
// round with no entry had no thinking.
function roundThinking(section: Section, requestModel: ModelRef, rounds: AgentRound[], index: number): { thinking?: SectionThinking } {
  const { thinking } = section
  if (!thinking || !sameModelRef(section.model, requestModel)) return {}

  const entries = thinking.rounds ?? []
  const textUpTo = (entry: number) => entries[entry]?.from ?? thinking.text.length
  if (index === 0) return sentThinking(thinking.text.slice(0, textUpTo(0)), thinking.replay)

  const afterToolCall = rounds[index - 1].blocks[0].id
  const entry = entries.findIndex((candidate) => candidate.afterToolCall === afterToolCall)
  if (entry < 0) return {}
  return sentThinking(thinking.text.slice(entries[entry].from, textUpTo(entry + 1)), entries[entry].replay)
}

function sentThinking(text: string, replay: ThinkingReplay | undefined): { thinking?: SectionThinking } {
  if (!replay || holdsImagePath(text) || holdsImagePath(JSON.stringify(replay))) return {}
  return thinkingField({ text, replay })
}

// A block's arguments are in definition order (toolBlocks.ts), so their JSON
// is the same bytes in every request.
function toolCall(block: ToolBlock): ToolCall {
  const args = Object.entries(block.arguments).map(([name, value]) => [name, typeof value === 'string' ? withoutImagePaths(value) : value])
  return { id: block.id, name: block.name, arguments: Object.fromEntries(args) }
}

// Every call gets a result. A `running` block in a request has no tool run
// that will end it: the app stopped while the tool ran, or the user pasted
// the block. A submit during a tool run sends the final blocks that
// `dez.stream/endOutput` wrote.
function toolResult(block: ToolBlock): ToolResult {
  if (block.status === 'running') return { callId: block.id, content: INTERRUPTED_TOOL_RESULT, isError: true }
  const content = withoutImagePaths(block.result)
  return { callId: block.id, content: content.trim() === '' ? EMPTY_TOOL_RESULT : content, isError: block.status === 'error' }
}

// The section text with each block in place as plain text, for a request
// with no tools.
function textWithToolCalls(text: string): string {
  const parts = splitToolBlocks(text).map((piece) => {
    if (piece.kind === 'text') return unescapeModelText(piece.text)
    const call = toolCall(piece.block)
    return `[Tool call: ${call.name} ${JSON.stringify(call.arguments)}]\n${toolResult(piece.block).content}\n[End of tool result]`
  })
  return withoutImagePaths(parts.join(''))
}

// Text and image parts in doc order. Each image part comes right after its
// reference's text, `![image](id=a)`, at the end of the text part before it,
// so that a model can name the image by its id. A text with no image
// reference stays a string, so a text-only request body is the same bytes as
// before images existed: the prefix hashes of saved thinking replays depend
// on it. A whitespace-only text after the last image is left out: Anthropic
// refuses a text block with no visible text.
function userMessageContent(text: string): string | MessagePart[] {
  const pieces = splitImageReferences(text)
  if (!pieces.some((piece) => piece.kind === 'image')) return withoutImagePaths(text)

  const parts: MessagePart[] = []
  let textBefore = ''
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      textBefore = piece.text
      continue
    }
    parts.push({ type: 'text', text: withoutImagePaths(textBefore + piece.source) }, { type: 'image', path: piece.path })
    textBefore = ''
  }
  if (textBefore.trim()) parts.push({ type: 'text', text: withoutImagePaths(textBefore) })
  return parts
}
