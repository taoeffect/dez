import type { MessagePart, ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findImageMentions } from '../chat/imageMentions'
import { findImageReferences, IMAGE_TOOL_KEY, type ImageReference } from '../chat/images'
import { sameModelRef } from '../chat/modelRef'
import { holdsStoredFilePath, withoutStoredFilePaths } from '../chat/storedFilePaths'
import { thinkingField } from '../chat/thinking'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, agentTextForRequest, splitToolBlocks, type ToolBlock } from '../chat/toolBlocks'
import { maxInputImages, needsInputImage, takesInputImages } from '../providers/clipImages'
import { clipText } from '../providers/clipText'
import type { ClipInputRules, MediaKind } from '../providers/types'
import type { ToolCall, ToolResult } from '../tools/types'
import type { RequestMessages, StreamMessage } from './types'

export interface RequestOptions {
  // False when the request model does not read images: the images of the
  // newest user message (its references and the images that it mentions)
  // then go as text only, as the images of every earlier message do.
  sendImages: boolean
  // False when the request offers no tools: an agent section's tool calls
  // then go as text (agentSectionMessages).
  sendTools: boolean
}

// The request messages: every section that has text, in order. No path of a
// file that Dez stores ever goes to a provider: every text (user and agent
// text, prompt bodies, tool arguments and results) goes through
// `withoutStoredFilePaths`, so an image reference goes as `![image](id=a)`,
// with the ids and other metadata that later requests can name. A clip in
// an agent section goes as its tag with only the id and the type
// (`agentTextForRequest`): no path and no signed URL. Each message is built
// from its own section and, for the images that it mentions, the sections
// before it.
//
// Only the newest user message carries images (image parts), unless
// `sendImages` is false: its image references, and the images that it
// names with an `@id` mention, however far back they are
// (`userMessageContent`). Every earlier user message goes as text only,
// with each image as its `![image](id=a)` text, so a long conversation
// does not send all its images again with each request. An agent section's
// images go as text only too: both formats take images only from the user.
// So to show a model an old image, or an image that a model made, the user
// mentions it in the new message.
//
// Prompt cache: a message is the same bytes in every later request, with
// one exception. A user message with image parts loses them when a newer
// user message comes, so the first request after that reads it, and what
// follows it, with no cache hit, and the signed thinking replays from there
// on no longer go back (their prefix changed; `wireChat`, apiFormats.ts).
// All request rounds of one reply have the same newest user message, so
// the bytes hold inside a reply.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, options: RequestOptions): Omit<RequestMessages, 'sendTools'> {
  let imagesLeftOut = 0
  // The images that a mention in the section at hand can name: the path of
  // each image id in the references of that section and of the sections
  // before it, user and agent. When two images have one id (a hand edit),
  // the last one wins. Later sections are never read: the newest user
  // message must keep its parts while the reply after it grows.
  const imagesById = new Map<string, string>()
  const sentSections = sections.filter((section) => !sectionIsEmpty(section))
  const newestUser = sentSections.findLastIndex((section) => section.role === 'user')
  const messages = sentSections.flatMap((section, index): StreamMessage[] => {
    const text = sectionPlainText(section)
    const references = findImageReferences(text)
    for (const { id, path } of references) {
      if (id !== null) imagesById.set(id, path)
    }
    if (section.role === 'agent') return agentSectionMessages(section, requestModel, options.sendTools)
    if (index !== newestUser) return [{ role: 'user', content: withoutStoredFilePaths(text) }]
    const content = userMessageContent(text, references, imagesById)
    if (options.sendImages || typeof content === 'string') return [{ role: 'user', content }]
    // The count is of the image parts that the request has for a model
    // that reads images, so the toast and the request always agree.
    imagesLeftOut = content.filter((part) => part.type === 'image').length
    return [{ role: 'user', content: withoutStoredFilePaths(text) }]
  })

  return { messages, imagesLeftOut }
}

/** What a media reply (a ModelInfo.request that is not `chat`) sends to
 *  dez.provider/generateMedia. `rules` is what the cache knows of the
 *  model's input (its ModelInfo).
 *
 *  The prompt is the text of the last user message of `messages` as a chat
 *  request sends it: with no path, and with each image reference as its
 *  `![image](id=a)` text. For a model that takes lyrics (`rules.text`), a
 *  `Lyrics:` line splits that text into the prompt and the lyrics
 *  (`clipText`).
 *
 *  The images are the images of that message, in text order and each one
 *  once: the ones that it holds and the ones that it names with an `@id`
 *  mention. An edit (`imageEdit`), an upscale, and a video request
 *  (`video`, `imageToVideo`) take as many as the model takes
 *  (`rules.images`, `maxInputImages`): for an edit, the first image is the
 *  one to edit; for a video, the first image is the first frame, and the
 *  second one is the last frame. `imagesLeftOut` is the count of the
 *  message's images that the request does not take, so that the submit
 *  can tell the user. A request of another kind takes no image
 *  (`takesInputImages`).
 *
 *  When the message has no image, a request that cannot go without one
 *  (`needsInputImage`) takes the newest image reference of `sections` (the
 *  tab's sections, in which the reply's own section is still empty), so
 *  that "Make it blue" or "Make it move" uses the image of the reply
 *  before. With no image there either, it gets no paths: the submit
 *  refuses the request (`missingImageProblem`), and generateMedia refuses
 *  it too. */
export function mediaRequestInput(
  kind: MediaKind,
  messages: StreamMessage[],
  sections: Section[],
  rules: ClipInputRules = {},
): { prompt: string, lyrics?: string, images: string[], imagesLeftOut: number } {
  const content = messages.findLast((message): message is Extract<StreamMessage, { role: 'user' }> => message.role === 'user')?.content ?? ''
  const parts: MessagePart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const text = clipText(rules.text, parts.map((part) => (part.type === 'text' ? part.text : '')).join('').trim())
  if (!takesInputImages(kind)) return { ...text, images: [], imagesLeftOut: 0 }

  const messageImages = [...new Set(parts.flatMap((part) => (part.type === 'image' ? [part.path] : [])))]
  const images = messageImages.slice(0, maxInputImages(kind, rules.images))
  const imagesLeftOut = messageImages.length - images.length
  if (messageImages.length > 0 || !needsInputImage(kind)) return { ...text, images, imagesLeftOut }
  const newest = sections.map((section) => findImageReferences(sectionPlainText(section)).at(-1)).findLast((reference) => reference !== undefined)
  return { ...text, images: newest ? [newest.path] : [], imagesLeftOut }
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
    const content = withoutStoredFilePaths(agentTextForRequest(round.text))
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
// section, the round has a replay, and neither holds a stored file path: a
// replay is valid only for the model that made it, a signed replay cannot be
// changed, and thinking with no replay (pasted, cut off, or split from
// inline tags) never goes back. A `field` replay sends the thinking text; the
// other kinds hold the thinking in their own JSON.
//
// The thinking of a round whose text holds an image of the model never goes
// back. A round that made an image has the provider's signature of that
// image as its replay (about 1 MB from a Gemini image model), and the
// request holds the image only as its reference text. The stream controller
// keeps no replay for such a round (`runChatRounds`, controller/stream.ts);
// conversations from before that rule still hold one. An image that a Dez
// tool made (`IMAGE_TOOL_KEY`) does not count: its reference is at the
// start of the text of the round after the tool's group, and the replay of
// that round is of the model's text only. That round can call a tool too,
// and some providers refuse a request that holds the calls of a round with
// no thinking.
//
// The first round has the section's `replay` and the text up to the first
// `rounds` entry. A later round has the entry whose `afterToolCall` is the
// first call of the group before it, and the text up to the next entry. A
// round with no entry had no thinking.
function roundThinking(section: Section, requestModel: ModelRef, rounds: AgentRound[], index: number): { thinking?: SectionThinking } {
  const { thinking } = section
  if (!thinking || !sameModelRef(section.model, requestModel)) return {}
  const madeByModel = ({ metadata }: ImageReference) => metadata.every((item) => item.key !== IMAGE_TOOL_KEY)
  if (findImageReferences(rounds[index].text).some(madeByModel)) return {}

  const entries = thinking.rounds ?? []
  const textUpTo = (entry: number) => entries[entry]?.from ?? thinking.text.length
  if (index === 0) return sentThinking(thinking.text.slice(0, textUpTo(0)), thinking.replay)

  const afterToolCall = rounds[index - 1].blocks[0].id
  const entry = entries.findIndex((candidate) => candidate.afterToolCall === afterToolCall)
  if (entry < 0) return {}
  return sentThinking(thinking.text.slice(entries[entry].from, textUpTo(entry + 1)), entries[entry].replay)
}

function sentThinking(text: string, replay: ThinkingReplay | undefined): { thinking?: SectionThinking } {
  if (!replay || holdsStoredFilePath(text) || holdsStoredFilePath(JSON.stringify(replay))) return {}
  return thinkingField({ text, replay })
}

// A block's arguments are in definition order (toolBlocks.ts), so their JSON
// is the same bytes in every request.
function toolCall(block: ToolBlock): ToolCall {
  const args = Object.entries(block.arguments).map(([name, value]) => [name, typeof value === 'string' ? withoutStoredFilePaths(value) : value])
  return { id: block.id, name: block.name, arguments: Object.fromEntries(args) }
}

// Every call gets a result. A `running` block in a request has no tool run
// that will end it: the app stopped while the tool ran, or the user pasted
// the block. A submit during a tool run sends the final blocks that
// `dez.stream/endOutput` wrote.
function toolResult(block: ToolBlock): ToolResult {
  if (block.status === 'running') return { callId: block.id, content: INTERRUPTED_TOOL_RESULT, isError: true }
  const content = withoutStoredFilePaths(block.result)
  return { callId: block.id, content: content.trim() === '' ? EMPTY_TOOL_RESULT : content, isError: block.status === 'error' }
}

// The section text with each block in place as plain text, for a request
// with no tools.
function textWithToolCalls(text: string): string {
  const parts = splitToolBlocks(text).map((piece) => {
    if (piece.kind === 'text') return agentTextForRequest(piece.text)
    const call = toolCall(piece.block)
    return `[Tool call: ${call.name} ${JSON.stringify(call.arguments)}]\n${toolResult(piece.block).content}\n[End of tool result]`
  })
  return withoutStoredFilePaths(parts.join(''))
}

// The content of the newest user message, the only one with image parts:
// text and image parts in doc order. `references` are the image references
// of `text`. Each image part comes right after its reference's text,
// `![image](id=a)`, at the end of the text part before it, so that a model
// can name the image by its id.
//
// An `@id` mention (imageMentions.ts) that names an image of `imagesById`
// counts as that image at that place: its image part comes right after the
// mention, which stays in the text as the user typed it. A mentioned image
// goes once, at its first mention. A mention of an image that the text
// itself holds adds no part: the reference sends that image. Mentions are
// read in the text as the provider gets it, after the path scrub: a bare
// path can hold an `@`, and a cut there would send the start of the path.
//
// A text with no image stays a string, so a text-only request body is the
// same bytes as before images existed: the prefix hashes of saved thinking
// replays depend on it. A whitespace-only text after the last image is left
// out: Anthropic refuses a text block with no visible text.
function userMessageContent(text: string, references: readonly ImageReference[], imagesById: ReadonlyMap<string, string>): string | MessagePart[] {
  const parts: MessagePart[] = []
  // The images that the message has a part for, or gets one for below.
  const sentImages = new Set(references.map((reference) => reference.path))
  // The scrubbed text since the last image part.
  let pendingText = ''
  // Takes in the text between two references (or a text end), with an
  // image part after each mention that adds one.
  const addText = (from: number, to: number) => {
    const scrubbed = withoutStoredFilePaths(text.slice(from, to))
    let start = 0
    for (const mention of findImageMentions(scrubbed)) {
      const path = imagesById.get(mention.id)
      if (path === undefined || sentImages.has(path)) continue
      sentImages.add(path)
      parts.push({ type: 'text', text: pendingText + scrubbed.slice(start, mention.to) }, { type: 'image', path })
      pendingText = ''
      start = mention.to
    }
    pendingText += scrubbed.slice(start)
  }

  let end = 0
  for (const { from, to, path } of references) {
    addText(end, from)
    parts.push({ type: 'text', text: pendingText + withoutStoredFilePaths(text.slice(from, to)) }, { type: 'image', path })
    pendingText = ''
    end = to
  }
  addText(end, text.length)

  // With no part, the pending text is the whole scrubbed text.
  if (parts.length === 0) return pendingText
  if (pendingText.trim()) parts.push({ type: 'text', text: pendingText })
  return parts
}
